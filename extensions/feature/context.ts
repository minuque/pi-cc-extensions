import {
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ToolInfo,
	copyToClipboard,
	estimateTokens,
	formatSkillsForPrompt,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { mouseBaseButton, parseSgrMousePacket } from "../utils/sgr-mouse.ts";
import { padLine } from "../utils/format.ts";

export type ContextPart = {
	label: string;
	tokens: number;
	color: "accent" | "success" | "warning" | "customMessageLabel" | "muted" | "dim" | "error";
};

type PreviewKey =
	| "systemPrompt"
	| "memoryFiles"
	| "skills"
	| "tools"
	| "toolResults"
	| "contextFiles";

type ContextPreview = {
	key: PreviewKey;
	label: string;
	title: string;
	content: string;
};

function normalizePreviewText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "  ")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export type DialogBounds = { left: number; top: number; width: number };

/** 1-based terminal hitbox of the [esc] close button on the dialog title row (row 2 of the box). */
export function escCloseHitbox(bounds: DialogBounds): {
	row: number;
	startCol: number;
	endCol: number;
} {
	return {
		row: bounds.top + 2,
		startCol: bounds.left + bounds.width - 5,
		endCol: bounds.left + bounds.width - 1,
	};
}

const COPY_LABEL = "[copy]";
const ESC_LABEL = "[esc]";

/** 测试可替换；生产使用 pi 的剪贴板实现。 */
let copyTextImpl: (text: string) => Promise<void> = (text) => copyToClipboard(text);

export function setPreviewCopyImpl(impl: ((text: string) => Promise<void>) | null): void {
	copyTextImpl = impl ?? ((text) => copyToClipboard(text));
}

/** 1-based terminal hitbox of the [copy] button, one space left of [esc] on the same title row. */
export function copyButtonHitbox(bounds: DialogBounds): {
	row: number;
	startCol: number;
	endCol: number;
} {
	const esc = escCloseHitbox(bounds);
	return {
		row: esc.row,
		startCol: esc.startCol - visibleWidth(COPY_LABEL) - 1,
		endCol: esc.startCol - 2,
	};
}

let activeContextOverlays = 0;

/** fullscreen 输入包装用于把鼠标事件继续传给当前 context 主弹框或文本预览 overlay。 */
export function hasActiveTextPreview(): boolean {
	return activeContextOverlays > 0;
}

/** 官方 fullscreen 打开 overlay 时会退回 1002；重新启用 1003 才能收到无按键 hover。 */
function ensureFullscreenMouseMotion(tui: any): void {
	if (tui.mode === "fullscreen") tui.terminal?.write?.("\x1b[?1003h\x1b[?1006h");
}

export async function showTextPreview(
	ctx: Pick<ExtensionCommandContext, "ui">,
	title: string,
	rawContent: string,
): Promise<void> {
	const content = normalizePreviewText(rawContent);
	activeContextOverlays++;
	try {
		await ctx.ui.custom(
			(tui, theme, _keybindings, done) => {
				ensureFullscreenMouseMotion(tui);
				let scrollOffset = 0;
				let pageSize = 1;
				let totalLines = 1;
				let escHovered = false;
				let copyHovered = false;
				let escHitbox: { row: number; startCol: number; endCol: number } | undefined;
				let copyHitbox: { row: number; startCol: number; endCol: number } | undefined;
				let scrollbarHitbox:
					| {
							col: number;
							startRow: number;
							endRow: number;
							thumbStart: number;
							thumbSize: number;
							maxOffset: number;
					  }
					| undefined;
				let scrollbarDragOffset: number | null = null;
				const markdownView = new Markdown(content, 0, 0, getMarkdownTheme());

				const scrollTo = (nextOffset: number): void => {
					const next = Math.max(0, Math.min(nextOffset, Math.max(0, totalLines - pageSize)));
					if (next === scrollOffset) return;
					scrollOffset = next;
					tui.requestRender();
				};

				const setEscHovered = (hovered: boolean): void => {
					if (hovered === escHovered) return;
					escHovered = hovered;
					tui.requestRender();
				};

				const setCopyHovered = (hovered: boolean): void => {
					if (hovered === copyHovered) return;
					copyHovered = hovered;
					tui.requestRender();
				};

				const copyPreview = (): void => {
					void copyTextImpl(content)
						.then(() => {
							const flash = (tui as { flash?: (message: string) => void }).flash;
							if (typeof flash === "function") flash("Copied!");
							else ctx.ui.notify("Copied preview to clipboard", "info");
						})
						.catch((error: unknown) => {
							ctx.ui.notify(error instanceof Error ? error.message : "Copy failed", "error");
						});
				};

				const dragScrollbarTo = (mouseRow: number): void => {
					if (!scrollbarHitbox || scrollbarDragOffset === null) return;
					const trackSize = scrollbarHitbox.endRow - scrollbarHitbox.startRow + 1;
					const maxThumbStart = Math.max(0, trackSize - scrollbarHitbox.thumbSize);
					const thumbStart = Math.max(
						0,
						Math.min(mouseRow - scrollbarHitbox.startRow - scrollbarDragOffset, maxThumbStart),
					);
					const nextOffset =
						maxThumbStart > 0
							? Math.round((thumbStart / maxThumbStart) * scrollbarHitbox.maxOffset)
							: 0;
					scrollTo(nextOffset);
				};

				return {
					invalidate() {
						markdownView.invalidate();
					},
					handleInput(data: string) {
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
							done(undefined);
							return;
						}
						if (matchesKey(data, Key.up)) scrollTo(scrollOffset - 1);
						else if (matchesKey(data, Key.down)) scrollTo(scrollOffset + 1);
						else if (matchesKey(data, "pageUp")) scrollTo(scrollOffset - pageSize);
						else if (matchesKey(data, "pageDown")) scrollTo(scrollOffset + pageSize);
						else if (matchesKey(data, Key.home)) scrollTo(0);
						else if (matchesKey(data, Key.end)) scrollTo(totalLines - pageSize);
						else {
							const mouse = parseSgrMousePacket(data);
							if (!mouse) return;
							if (mouse.final === "m") {
								scrollbarDragOffset = null;
								return;
							}
							const overEsc = Boolean(
								escHitbox &&
									mouse.row === escHitbox.row &&
									mouse.col >= escHitbox.startCol &&
									mouse.col <= escHitbox.endCol,
							);
							const overCopy = Boolean(
								copyHitbox &&
									mouse.row === copyHitbox.row &&
									mouse.col >= copyHitbox.startCol &&
									mouse.col <= copyHitbox.endCol,
							);
							setEscHovered(overEsc);
							setCopyHovered(overCopy);
							const button = mouseBaseButton(mouse.code);
							const motion = (mouse.code & 32) !== 0;
							if (button === 0 && !motion) {
								if (overEsc) {
									done(undefined);
									return;
								}
								if (overCopy) {
									copyPreview();
									return;
								}
								if (
									scrollbarHitbox &&
									mouse.col === scrollbarHitbox.col &&
									mouse.row >= scrollbarHitbox.startRow &&
									mouse.row <= scrollbarHitbox.endRow
								) {
									const trackRow = mouse.row - scrollbarHitbox.startRow;
									const inThumb =
										trackRow >= scrollbarHitbox.thumbStart &&
										trackRow < scrollbarHitbox.thumbStart + scrollbarHitbox.thumbSize;
									scrollbarDragOffset = inThumb
										? trackRow - scrollbarHitbox.thumbStart
										: Math.floor(scrollbarHitbox.thumbSize / 2);
									dragScrollbarTo(mouse.row);
									return;
								}
							}
							if (motion && scrollbarDragOffset !== null) {
								dragScrollbarTo(mouse.row);
								return;
							}
							if (button === 64) scrollTo(scrollOffset - 3);
							else if (button === 65) scrollTo(scrollOffset + 3);
						}
					},

					render(width: number) {
						const inner = Math.max(1, width - 2);
						const actionsWidth = visibleWidth(`${COPY_LABEL} ${ESC_LABEL}`);
						const bodyInner = Math.max(1, inner - 1);
						const bodyWidth = Math.max(1, bodyInner - 1);
						const terminalHeight = Math.max(1, tui.terminal.rows);
						const availableHeight = Math.max(1, terminalHeight - 4);
						const viewportHeight = Math.min(
							30,
							Math.max(1, Math.floor(terminalHeight * 0.8)),
							availableHeight,
						);
						pageSize = Math.max(1, viewportHeight - 6);
						const wrapped = markdownView.render(bodyWidth);
						totalLines = wrapped.length;
						scrollOffset = Math.min(scrollOffset, Math.max(0, totalLines - pageSize));
						// Centered overlay with margin 2: mirror TUI resolveOverlayLayout for anchor "center".
						const overlayTop = 2 + Math.floor((availableHeight - viewportHeight) / 2);
						const overlayLeft = Math.floor((Math.max(1, tui.terminal.columns) - width) / 2);
						escHitbox = escCloseHitbox({ left: overlayLeft, top: overlayTop, width });
						copyHitbox = copyButtonHitbox({ left: overlayLeft, top: overlayTop, width });
						const visible = wrapped.slice(scrollOffset, scrollOffset + pageSize);
						const border = (text: string) => theme.fg("border", text);
						const scrollable = totalLines > pageSize;
						const thumbSize = scrollable
							? Math.max(1, Math.floor((pageSize * pageSize) / totalLines))
							: 0;
						const maxScrollOffset = Math.max(0, totalLines - pageSize);
						const thumbStart =
							scrollable && maxScrollOffset > 0
								? Math.round((scrollOffset / maxScrollOffset) * (pageSize - thumbSize))
								: 0;
						scrollbarHitbox = scrollable
							? {
									col: overlayLeft + width - 1,
									startRow: overlayTop + 4,
									endRow: overlayTop + 3 + pageSize,
									thumbStart,
									thumbSize,
									maxOffset: maxScrollOffset,
								}
							: undefined;
						const scrollbar = (row: number): string => {
							if (!scrollable) return " ";
							const inThumb = row >= thumbStart && row < thumbStart + thumbSize;
							return theme.fg(inThumb ? "accent" : "borderMuted", inThumb ? "█" : "│");
						};
						const bodyRows = Array.from({ length: pageSize }, (_, row) => {
							const line = visible[row] ?? "";
							return `${border("│")}${padLine(` ${line}`, bodyInner)}${scrollbar(row)}${border("│")}`;
						});
						const start = totalLines === 0 ? 0 : scrollOffset + 1;
						const end = Math.min(totalLines, scrollOffset + pageSize);
						const status = `${start}-${end} / ${totalLines} lines · ↑↓ PgUp/PgDn Home/End · [copy] · [esc] close`;

						return [
							border(`╭${"─".repeat(inner)}╮`),
							`${border("│")}${padLine(` ${theme.bold(theme.fg("accent", title))}`, inner - actionsWidth)}${theme.fg(copyHovered ? "text" : "muted", COPY_LABEL)} ${theme.fg(escHovered ? "text" : "muted", ESC_LABEL)}${border("│")}`,
							`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
							...bodyRows,
							`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
							`${border("│")}${padLine(theme.fg("dim", ` ${status}`), inner)}${border("│")}`,
							border(`╰${"─".repeat(inner)}╯`),
						];
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "85%",
					minWidth: 50,
					maxHeight: "80%",
					margin: 2,
				},
			},
		);
	} finally {
		activeContextOverlays--;
	}
}

const tokenEstimate = (value: unknown): number => {
	if (!value) return 0;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return Math.max(0, Math.ceil(text.length / 4));
};

/** 只算会进请求正文的 content 和 sections。工具 schema 走 tools 参数，由 Tools definition 单独计一次。 */
function systemMessageTokens(message: {
	content?: unknown;
	sections?: Record<string, string | null> | null;
}): number {
	let chars = typeof message.content === "string" ? message.content.length : 0;
	for (const section of Object.values(message.sections ?? {})) {
		if (typeof section === "string") chars += section.length;
	}
	return Math.ceil(chars / 4);
}

/** prompt 组装会把 CRLF 归一成 LF，匹配前对齐行尾。 */
function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** 只统计确实嵌进 system prompt 的片段，避免源文件预览把占用加两遍。 */
function embeddedTokens(prompt: string, chunk: string): number {
	if (!chunk || !prompt.includes(chunk)) return 0;
	return tokenEstimate(chunk);
}

export function capParts(parts: ContextPart[], target: number, fixedPrefix = 0): ContextPart[] {
	const fixed = parts.slice(0, fixedPrefix);
	const variable = parts.slice(fixedPrefix);
	const fixedTokens = fixed.reduce((sum, part) => sum + part.tokens, 0);
	const variableTarget = Math.max(0, target - fixedTokens);
	const estimated = variable.reduce((sum, part) => sum + part.tokens, 0);
	if (estimated <= variableTarget || estimated === 0) return parts;
	if (variableTarget === 0) {
		return [...fixed, ...variable.map((part) => ({ ...part, tokens: 0 }))];
	}

	let previous = 0;
	let cumulative = 0;
	const capped = variable.map((part, index) => {
		cumulative += part.tokens;
		const next =
			index === variable.length - 1
				? variableTarget
				: Math.round((cumulative / estimated) * variableTarget);
		const tokens = next - previous;
		previous = next;
		return { ...part, tokens };
	});
	return [...fixed, ...capped];
}

export function formatTokens(tokens: number): string {
	if (tokens < 1_000) return String(tokens);
	if (tokens < 100_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens / 1_000)}k`;
}

export function resolveUsedTokens(
	usage: { tokens: number | null; percent: number | null } | undefined,
	estimated: number,
	contextWindow: number,
): number {
	const reported = usage?.tokens;
	const fromPercent =
		usage?.percent !== null && usage?.percent !== undefined && contextWindow > 0
			? Math.round((usage.percent / 100) * contextWindow)
			: undefined;
	let resolved = reported ?? fromPercent ?? estimated;
	if (reported !== null && reported !== undefined && fromPercent !== undefined) {
		// 某些 Provider 会返回异常 totalTokens；百分比与底部状态栏不一致时优先采用百分比。
		const tolerance = Math.max(32, Math.round(contextWindow * 0.001));
		if (Math.abs(reported - fromPercent) > tolerance) resolved = fromPercent;
	}
	// tokens 与 percent 可能同时源自异常 usage；数量级明显偏小时回退到实际内容估算。
	if (estimated > 0 && resolved < estimated * 0.25) return estimated;
	return resolved;
}

type ContextBreakdown = {
	parts: ContextPart[];
	previews: Record<PreviewKey, string>;
};

function previewValue(value: unknown): string {
	if (typeof value === "string") return value;
	return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

/** 按真实请求的 systemPrompt、tools、messages 三部分同步组装计数与预览。 */
export function collectContextBreakdown(
	ctx: ExtensionCommandContext,
	allTools: ToolInfo[],
): ContextBreakdown {
	const options = (ctx.getSystemPromptOptions?.() ?? {}) as BuildSystemPromptOptions;
	const selectedTools = new Set(options.selectedTools ?? ["read", "bash", "edit", "write"]);
	const toolDefinitionPreview: string[] = [];
	const toolResultPreview: string[] = [];
	const contextPreview: string[] = [];
	const systemPromptPreview: string[] = [];
	let toolDefinitionTokens = 0;
	let toolResultTokens = 0;
	let contextTokens = 0;
	let systemTokens = 0;

	const memoryPreview: string[] = [];
	const contextFiles = options.contextFiles ?? [];
	for (const file of contextFiles) {
		memoryPreview.push(`## ${file.path}\n\n${previewValue(file.content)}`);
	}

	const skills = options.skills ?? [];
	const skillsText = formatSkillsForPrompt(skills).trim();

	for (const tool of allTools) {
		if (!selectedTools.has(tool.name)) continue;
		const definition = {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		};
		toolDefinitionTokens += tokenEstimate(definition);
		toolDefinitionPreview.push(`## Definition: ${tool.name}\n\n${previewValue(definition)}`);
	}

	let memoryTokens = 0;
	let skillsTokens = 0;
	for (const projected of ctx.sessionManager.buildSessionProjection().entries) {
		const source = projected.sourceEntry;
		for (const message of projected.messages) {
			if (message.role === "system") {
				systemTokens += systemMessageTokens(message);
				// Memory / skills 按投影中的实际 section 文本切分，与 system prompt 增量互补、不重不漏。
				const sections = (message.sections ?? {}) as Record<string, string | null>;
				const projectContext =
					typeof sections.project_context === "string"
						? normalizeLineEndings(sections.project_context)
						: "";
				for (const file of contextFiles) {
					const chunk = `<project_instructions path="${file.path}">\n${normalizeLineEndings(file.content)}\n</project_instructions>`;
					memoryTokens += embeddedTokens(projectContext, chunk);
					systemTokens -= embeddedTokens(projectContext, chunk);
				}
				const skillsSection =
					typeof sections.skills === "string" ? normalizeLineEndings(sections.skills) : "";
				skillsTokens += embeddedTokens(skillsSection, skillsText);
				systemTokens -= embeddedTokens(skillsSection, skillsText);
				systemPromptPreview.push(
					(source.type === "compaction"
						? "## System prompt snapshot at compaction\n\n"
						: "## System prompt update\n\n") +
						previewValue({
							content: message.content,
							sections: message.sections,
							toolsAdded: (message.toolsAdded ?? []).map((tool: { name?: string }) => tool?.name),
							toolsRemoved: (message.toolsRemoved ?? []).map(
								(tool: { name?: string }) => tool?.name,
							),
						}),
				);
			} else if (message.role === "assistant") {
				contextTokens += estimateTokens(message);
				for (const block of message.content) {
					if (block.type === "toolCall") {
						contextPreview.push(
							`## Assistant tool call: ${block.name}\n\n${previewValue(block.arguments)}`,
						);
					} else if (block.type === "text") {
						contextPreview.push(`## Assistant\n\n${block.text}`);
					} else if (block.type === "thinking") {
						contextPreview.push(`## Assistant thinking\n\n${block.thinking}`);
					}
				}
			} else if (message.role === "toolResult") {
				toolResultTokens += estimateTokens(message);
				toolResultPreview.push(
					`## Result: ${message.toolName}\n\n${previewValue(message.content)}`,
				);
			} else if (message.role === "bashExecution") {
				contextTokens += estimateTokens(message);
				contextPreview.push(
					`## Bash\n\nCommand:\n\n${previewValue(message.command)}\n\nOutput:\n\n${previewValue(message.output)}`,
				);
			} else if (message.role === "branchSummary" || message.role === "compactionSummary") {
				contextTokens += estimateTokens(message);
				contextPreview.push(`## ${message.role}\n\n${message.summary}`);
			} else {
				contextTokens += estimateTokens(message);
				contextPreview.push(`## ${message.role}\n\n${previewValue(message.content)}`);
			}
		}
	}

	systemTokens = Math.max(0, systemTokens);
	return {
		parts: [
			{ label: "System prompt", tokens: systemTokens, color: "accent" },
			{ label: "Memory", tokens: memoryTokens, color: "error" },
			{ label: "Skills", tokens: skillsTokens, color: "warning" },
			{ label: "Tools definition", tokens: toolDefinitionTokens, color: "success" },
			{ label: "Tool results", tokens: toolResultTokens, color: "customMessageLabel" },
			{ label: "Context", tokens: contextTokens, color: "warning" },
		] satisfies ContextPart[],
		previews: {
			systemPrompt:
				systemPromptPreview.join("\n\n") ||
				(typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "") ||
				"No system prompt.",
			memoryFiles: memoryPreview.join("\n\n") || "No memory files in context.",
			skills: skillsText || "No skills in context.",
			tools: toolDefinitionPreview.join("\n\n") || "No active tool definitions.",
			toolResults: toolResultPreview.join("\n\n") || "No tool results in the current context.",
			contextFiles: contextPreview.join("\n\n") || "No conversation context.",
		},
	};
}

export default function contextUsageExtension(pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Show the current context-window distribution",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const tools = pi.getAllTools();
			const breakdown = collectContextBreakdown(ctx, tools);
			const estimated = breakdown.parts.reduce((sum, part) => sum + part.tokens, 0);
			// System / Memory / Skills / Tools definition 为固定项，capParts 时保持原值不压缩。
			const fixedTokens = breakdown.parts.slice(0, 4).reduce((sum, part) => sum + part.tokens, 0);
			const used = Math.max(resolveUsedTokens(usage, estimated, contextWindow), fixedTokens);
			const parts = capParts(breakdown.parts, used, 4);
			const attributed = parts.reduce((sum, part) => sum + part.tokens, 0);
			const other = Math.max(0, used - attributed);
			const free = Math.max(0, contextWindow - used);
			const allParts = [
				...parts,
				{ label: "Other", tokens: other, color: "muted" as const },
				{ label: "Free space", tokens: free, color: "dim" as const },
			];

			if (ctx.mode !== "tui") {
				const lines = allParts.map((part) => `${part.label}: ${formatTokens(part.tokens)} tokens`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const rawPreviews: ContextPreview[] = [
				{
					key: "systemPrompt",
					label: "System prompt",
					title: "System Prompt",
					content: breakdown.previews.systemPrompt,
				},
				{
					key: "memoryFiles",
					label: "Memory",
					title: "Memory Files",
					content: breakdown.previews.memoryFiles,
				},
				{
					key: "skills",
					label: "Skills",
					title: "Skills",
					content: breakdown.previews.skills,
				},
				{
					key: "tools",
					label: "Tools definition",
					title: "Tools definition",
					content: breakdown.previews.tools,
				},
				{
					key: "toolResults",
					label: "Tool results",
					title: "Tool Results",
					content: breakdown.previews.toolResults,
				},
				{
					key: "contextFiles",
					label: "Context",
					title: "Context",
					content: breakdown.previews.contextFiles,
				},
			];
			const previews = rawPreviews.map((preview) => ({
				...preview,
				content: normalizePreviewText(preview.content),
			}));
			const previewByKey = new Map(previews.map((preview) => [preview.key, preview]));
			const visiblePreviews = previews.filter((preview) =>
				allParts.some((part) => part.label === preview.label),
			);
			let selectedPreviewIndex = 0;

			while (true) {
				// 主弹框也计入活动 overlay，fullscreen 下官方输入链才会把鼠标包放行给行点击。
				activeContextOverlays++;
				let action;
				try {
					action = await ctx.ui.custom(
						(tui, theme, _keybindings, done) => {
							ensureFullscreenMouseMotion(tui);
							let previewHitboxes: Array<{
								key: PreviewKey;
								row: number;
								startCol: number;
								endCol: number;
							}> = [];
							let escHitbox: { row: number; startCol: number; endCol: number } | undefined;
							let escHovered = false;
							let hoveredKey: PreviewKey | undefined;

							return {
								invalidate() {},
								handleInput(data: string) {
									if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
										done(undefined);
										return;
									}
									if (matchesKey(data, Key.up) && visiblePreviews.length > 0) {
										selectedPreviewIndex =
											(selectedPreviewIndex - 1 + visiblePreviews.length) % visiblePreviews.length;
										tui.requestRender();
										return;
									}
									if (matchesKey(data, Key.down) && visiblePreviews.length > 0) {
										selectedPreviewIndex = (selectedPreviewIndex + 1) % visiblePreviews.length;
										tui.requestRender();
										return;
									}
									if (matchesKey(data, Key.enter)) {
										done(visiblePreviews[selectedPreviewIndex]?.key);
										return;
									}

									const mouse = parseSgrMousePacket(data);
									if (!mouse || mouse.final !== "M") return;
									if ((mouse.code & 32) !== 0) {
										// SGR 1003 的无按键 hover code 为 35，不能按左键事件过滤。
										const overEsc = Boolean(
											escHitbox &&
												mouse.row === escHitbox.row &&
												mouse.col >= escHitbox.startCol &&
												mouse.col <= escHitbox.endCol,
										);
										const hovered = previewHitboxes.find(
											(candidate) =>
												mouse.row === candidate.row &&
												mouse.col >= candidate.startCol &&
												mouse.col <= candidate.endCol,
										);
										if (overEsc !== escHovered || hovered?.key !== hoveredKey) {
											escHovered = overEsc;
											hoveredKey = hovered?.key;
											tui.requestRender();
										}
										return;
									}
									if (mouseBaseButton(mouse.code) !== 0) return;
									if (
										escHitbox &&
										mouse.row === escHitbox.row &&
										mouse.col >= escHitbox.startCol &&
										mouse.col <= escHitbox.endCol
									) {
										done(undefined);
										return;
									}
									const hitbox = previewHitboxes.find(
										(candidate) =>
											mouse.row === candidate.row &&
											mouse.col >= candidate.startCol &&
											mouse.col <= candidate.endCol,
									);
									if (hitbox) {
										selectedPreviewIndex = Math.max(
											0,
											visiblePreviews.findIndex((preview) => preview.key === hitbox.key),
										);
										done(hitbox.key);
									}
								},
								render(width: number) {
									const inner = Math.max(1, width - 2);
									const escWidth = visibleWidth("[esc]");
									const percent = contextWindow > 0 ? (used / contextWindow) * 100 : 0;
									const title = theme.bold(theme.fg("accent", "Context Usage"));
									const subtitle = `${formatTokens(used)} / ${formatTokens(contextWindow)} tokens (${percent.toFixed(1)}%)`;
									const barWidth = Math.max(1, Math.min(60, inner - 2));
									let remaining = barWidth;
									const segments = allParts
										.map((part, index) => {
											const cells =
												index === allParts.length - 1
													? remaining
													: Math.min(
															remaining,
															Math.round((part.tokens / Math.max(1, contextWindow)) * barWidth),
														);
											remaining -= cells;
											return theme.fg(part.color, "█".repeat(Math.max(0, cells)));
										})
										.join("");
									const labelWidth = Math.min(
										24,
										Math.max(...allParts.map((part) => part.label.length)),
									);
									const selectedLabel = visiblePreviews[selectedPreviewIndex]?.label;
									const partRows = allParts.map((part) => {
										const pct = contextWindow > 0 ? (part.tokens / contextWindow) * 100 : 0;
										const swatch = theme.fg(part.color, "■");
										const label = part.label.padEnd(labelWidth);
										const amount = `${formatTokens(part.tokens).padStart(7)}  ${pct.toFixed(1).padStart(5)}%`;
										const selected = part.label === selectedLabel;
										const hoverLabel = visiblePreviews.find((p) => p.key === hoveredKey)?.label;
										const prefix = selected ? "› " : "  ";
										const row = padLine(`${prefix}${swatch} ${label} ${amount}`, inner);
										if (selected) return theme.bg("selectedBg", row);
										return part.label === hoverLabel ? theme.bg("customMessageBg", row) : row;
									});
									const border = (text: string) => theme.fg("border", text);
									const lines = [
										border(`╭${"─".repeat(inner)}╮`),
										`${border("│")}${padLine(` ${title}  ${theme.fg("muted", subtitle)}`, inner - escWidth)}${theme.fg(escHovered ? "text" : "muted", "[esc]")}${border("│")}`,
										`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
										`${border("│")}${padLine(` ${segments}`, inner)}${border("│")}`,
										`${border("│")}${" ".repeat(inner)}${border("│")}`,
										...partRows.map((row) => `${border("│")}${row}${border("│")}`),
										`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
										`${border("│")}${padLine(theme.fg("dim", " ↑↓ select · Click / Enter to preview · [esc] close"), inner)}${border("│")}`,
										border(`╰${"─".repeat(inner)}╯`),
									];

									const terminalHeight = Math.max(1, tui.terminal.rows);
									const maxHeight = Math.min(
										Math.max(1, Math.floor(terminalHeight * 0.9)),
										Math.max(1, terminalHeight - 2),
									);
									const visibleHeight = Math.min(lines.length, maxHeight);
									const overlayTop =
										1 + Math.floor((Math.max(1, terminalHeight - 2) - visibleHeight) / 2);
									const overlayLeft = Math.floor((Math.max(1, tui.terminal.columns) - width) / 2);
									escHitbox = escCloseHitbox({ left: overlayLeft, top: overlayTop, width });
									previewHitboxes = visiblePreviews.flatMap((preview) => {
										const partIndex = allParts.findIndex((part) => part.label === preview.label);
										const line = 5 + partIndex;
										return partIndex >= 0 && line < visibleHeight
											? [
													{
														key: preview.key,
														row: overlayTop + line + 1,
														startCol: overlayLeft + 1,
														endCol: overlayLeft + width,
													},
												]
											: [];
									});

									return lines;
								},
							};
						},
						{
							overlay: true,
							overlayOptions: {
								anchor: "center",
								width: 64,
								minWidth: 44,
								maxHeight: "90%",
								margin: 1,
							},
						},
					);
				} finally {
					activeContextOverlays--;
				}

				if (!action) break;
				const preview = previewByKey.get(action as PreviewKey);
				if (!preview) continue;

				await showTextPreview(ctx, preview.title, preview.content);
			}
		},
	});
}
