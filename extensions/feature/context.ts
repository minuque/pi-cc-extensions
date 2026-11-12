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
import { type Color, rgbColor } from "@earendil-works/pi-tui";
import { padLine } from "../utils/format.ts";
import { setInjectedKeybindings } from "../utils/keybindings.ts";
import { mouseBaseButton, parseSgrMousePacket } from "../utils/sgr-mouse.ts";

export type ContextPart = {
	label: string;
	tokens: number;
	/** 固定 RGB 色值，不走主题 token——避免不同主题撞色。渲染用 theme.style({fg: color})。 */
	color: Color;
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

/** Pi 居中 overlay 的屏幕起点。没有 renderedOverlayLayouts 时用它，避免把 1-based 屏幕坐标当局部坐标。 */
function centeredOverlayOrigin(
	tui: any,
	margin: number,
	maxHeightPercent: number,
	width: number,
	height: number,
) {
	const termWidth = Math.max(1, tui.terminal?.columns ?? 80);
	const termHeight = Math.max(1, tui.terminal?.rows ?? 24);
	const availWidth = Math.max(1, termWidth - margin * 2);
	const availHeight = Math.max(1, termHeight - margin * 2);
	const maxHeight = Math.max(
		1,
		Math.min(Math.floor((termHeight * maxHeightPercent) / 100), availHeight),
	);
	const effectiveHeight = Math.min(height, maxHeight);
	return {
		col: Math.max(
			margin,
			Math.min(margin + Math.floor((availWidth - width) / 2), termWidth - margin - width),
		),
		row: Math.max(
			margin,
			Math.min(
				margin + Math.floor((availHeight - effectiveHeight) / 2),
				termHeight - margin - effectiveHeight,
			),
		),
	};
}

function localMouseFromSgr(
	tui: any,
	mouse: { code: number; col: number; row: number; final: "M" | "m" },
	fallback: { col: number; row: number },
) {
	// 用焦点组件自己的布局。取最上层会在多个 overlay 叠放时把下层的点击算偏。
	const layouts = Array.isArray(tui.renderedOverlayLayouts) ? tui.renderedOverlayLayouts : [];
	const focused = tui.focusedComponent;
	const layout =
		layouts.findLast((candidate: { entry?: { component?: unknown } }) =>
			focused ? candidate.entry?.component === focused : false,
		) ??
		(focused ? undefined : layouts.at(-1)) ??
		fallback;
	return {
		col: mouse.col - 1 - layout.col,
		row: mouse.row - 1 - layout.row,
		release: mouse.final === "m",
		motion: (mouse.code & 32) !== 0,
		baseButton: mouseBaseButton(mouse.code),
	};
}

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
			(tui, theme, injectedKeybindings, done) => {
				setInjectedKeybindings(injectedKeybindings);
				ensureFullscreenMouseMotion(tui);
				let scrollOffset = 0;
				let pageSize = 1;
				let totalLines = 1;
				let escHovered = false;
				let copyHovered = false;
				let scrollbarHovered = false;
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
				let screenOrigin = { col: 0, row: 0 };
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

				const setScrollbarHovered = (hovered: boolean): void => {
					if (hovered === scrollbarHovered) return;
					scrollbarHovered = hovered;
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

				/**
				 * 预览鼠标共用处：1-based 屏幕 col/row + 已解码的按键/动作。
				 * handleInput（regular 主屏 raw SGR）与 handleMouse（overlay 事件对象）
				 * 都收在这里，两条链同一套 esc/copy/滚动条/滚轮行为。
				 * 返回 true 表示这次输入被预览消费。
				 */
				const handlePreviewMouse = (args: {
					col: number;
					row: number;
					release: boolean;
					motion: boolean;
					/** 基础按键码：0 左键、64/65 滚轮上/下。 */
					baseButton: number;
				}): boolean => {
					const { col, row, release, motion, baseButton } = args;
					if (release) {
						scrollbarDragOffset = null;
						setScrollbarHovered(false);
						return true;
					}
					const overEsc = Boolean(
						escHitbox &&
							row === escHitbox.row &&
							col >= escHitbox.startCol &&
							col <= escHitbox.endCol,
					);
					const overCopy = Boolean(
						copyHitbox &&
							row === copyHitbox.row &&
							col >= copyHitbox.startCol &&
							col <= copyHitbox.endCol,
					);
					setEscHovered(overEsc);
					setCopyHovered(overCopy);
					// 拖动中保持 hover：thumb 一直亮，官方 scrollbarDrag 同理。
					setScrollbarHovered(
						Boolean(
							scrollbarHitbox &&
								col === scrollbarHitbox.col &&
								row >= scrollbarHitbox.startRow &&
								row <= scrollbarHitbox.endRow,
						) || scrollbarDragOffset !== null,
					);
					if (baseButton === 0 && !motion) {
						if (overEsc) {
							done(undefined);
							return true;
						}
						if (overCopy) {
							copyPreview();
							return true;
						}
						if (
							scrollbarHitbox &&
							col === scrollbarHitbox.col &&
							row >= scrollbarHitbox.startRow &&
							row <= scrollbarHitbox.endRow
						) {
							const trackRow = row - scrollbarHitbox.startRow;
							const inThumb =
								trackRow >= scrollbarHitbox.thumbStart &&
								trackRow < scrollbarHitbox.thumbStart + scrollbarHitbox.thumbSize;
							scrollbarDragOffset = inThumb
								? trackRow - scrollbarHitbox.thumbStart
								: Math.floor(scrollbarHitbox.thumbSize / 2);
							dragScrollbarTo(row);
							return true;
						}
					}
					if (motion && scrollbarDragOffset !== null) {
						dragScrollbarTo(row);
						return true;
					}
					if (baseButton === 64) {
						scrollTo(scrollOffset - 3);
						return true;
					}
					if (baseButton === 65) {
						scrollTo(scrollOffset + 3);
						return true;
					}
					// 预览矩形内但未命中任何控件的包也算预览的：返回 true 让 overlay
					// 命中它（hit 成立），官方不再往底下的 transcript 分发。
					return true;
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
							handlePreviewMouse(localMouseFromSgr(tui, mouse, screenOrigin));
						}
					},
					// overlay 事件对象路径：官方 dispatchMouseToOverlay 把鼠标派到
					// handleMouse，event.x/y 是相对弹框左上角的 0-based 局部坐标，
					// 与 hitbox 同基准，天然对齐官方放置位置。
					handleMouse(event: any) {
						// 一次单击 = press + release + 合成 click。动作已在 press 执行，
						// click 只消费不重复触发（否则 copy/esc 会跑两次）。
						if (event.type === "click") return { handled: true };
						const wheelUp = event.type === "wheel" && Number(event.wheelDelta) < 0;
						const wheelDown = event.type === "wheel" && Number(event.wheelDelta) > 0;
						handlePreviewMouse({
							col: Number(event.x),
							row: Number(event.y),
							release: event.type === "release",
							motion: event.type === "move" || event.type === "drag",
							baseButton: wheelUp ? 64 : wheelDown ? 65 : event.button === "left" ? 0 : -1,
						});
						return { handled: true };
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
						// hitbox 用弹框局部坐标（0-based）：title 固定第 1 行，esc/copy
						// 在行尾，滚动条字符在 body 行右 border 内侧（width-2 列）。
						escHitbox = { row: 1, startCol: width - 6, endCol: width - 2 };
						copyHitbox = {
							row: 1,
							startCol: width - 6 - 1 - visibleWidth(COPY_LABEL),
							endCol: width - 8,
						};
						const visible = wrapped.slice(scrollOffset, scrollOffset + pageSize);
						const border = (text: string) => theme.fg("border", text);
						const scrollable = totalLines > pageSize;
						// thumb 几何对齐官方 getScrollbarGeometry：trackHeight=pageSize、
						// contentHeight=totalLines，minThumb=min(2,track)，thumb=round(track²/content)。
						const thumbSize = scrollable
							? Math.max(
									Math.min(2, pageSize),
									Math.min(pageSize, Math.round((pageSize * pageSize) / totalLines)),
								)
							: 0;
						const maxScrollOffset = Math.max(0, totalLines - pageSize);
						const thumbStart =
							scrollable && maxScrollOffset > 0
								? Math.round((scrollOffset / maxScrollOffset) * (pageSize - thumbSize))
								: 0;
						scrollbarHitbox = scrollable
							? {
									col: width - 2,
									startRow: 3,
									endRow: 2 + pageSize,
									thumbStart,
									thumbSize,
									maxOffset: maxScrollOffset,
								}
							: undefined;
						const scrollbar = (row: number): string => {
							if (!scrollable) return " ";
							const inThumb = row >= thumbStart && row < thumbStart + thumbSize;
							// 对齐官方：thumb 常态 ┃、hover/拖动中 █；track 始终 │。
							const thumbActive = scrollbarHovered || scrollbarDragOffset !== null;
							if (inThumb) return theme.fg("accent", thumbActive ? "█" : "┃");
							return theme.fg("borderMuted", "│");
						};
						const bodyRows = Array.from({ length: pageSize }, (_, row) => {
							const line = visible[row] ?? "";
							return `${border("│")}${padLine(` ${line}`, bodyInner)}${scrollbar(row)}${border("│")}`;
						});
						const start = totalLines === 0 ? 0 : scrollOffset + 1;
						const end = Math.min(totalLines, scrollOffset + pageSize);
						const status = `${start}-${end} / ${totalLines} lines · ↑↓ PgUp/PgDn Home/End`;
						const lines = [
							border(`╭${"─".repeat(inner)}╮`),
							`${border("│")}${padLine(` ${theme.bold(theme.fg("accent", title))}`, inner - actionsWidth)}${theme.fg(copyHovered ? "text" : "muted", COPY_LABEL)} ${theme.fg(escHovered ? "text" : "muted", ESC_LABEL)}${border("│")}`,
							`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
							...bodyRows,
							`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
							`${border("│")}${padLine(theme.fg("dim", ` ${status}`), inner)}${border("│")}`,
							border(`╰${"─".repeat(inner)}╯`),
						];
						screenOrigin = centeredOverlayOrigin(tui, 2, 80, width, lines.length);
						return lines;
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "80%",
					minWidth: 50,
					maxHeight: "80%",
					margin: 2,
				},
				blocked: { kind: "question", message: "Reviewing context" },
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
			{ label: "System prompt", tokens: systemTokens, color: rgbColor(0x79, 0xc0, 0xff) },
			{ label: "Memory", tokens: memoryTokens, color: rgbColor(0xff, 0x7b, 0x72) },
			{ label: "Skills", tokens: skillsTokens, color: rgbColor(0xcb, 0x92, 0x14) },
			{
				label: "Tools definition",
				tokens: toolDefinitionTokens,
				color: rgbColor(0x37, 0xb3, 0x4a),
			},
			{ label: "Tool results", tokens: toolResultTokens, color: rgbColor(0xf7, 0x78, 0xba) },
			{ label: "Context", tokens: contextTokens, color: rgbColor(0xf0, 0x88, 0x3e) },
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
				{ label: "Other", tokens: other, color: rgbColor(0x92, 0x9e, 0xab) },
				{ label: "Free space", tokens: free, color: rgbColor(0x76, 0x84, 0x94) },
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
						(tui, theme, injectedKeybindings, done) => {
							setInjectedKeybindings(injectedKeybindings);
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
							let screenOrigin = { col: 0, row: 0 };

							/** context 主弹框鼠标共用处：handleInput（raw SGR）与 handleMouse（overlay
							 * 事件对象）同一套 hover/选中/关闭行为。返回 true 表示被预览消费。 */
							const handleDialogMouse = (args: {
								col: number;
								row: number;
								release: boolean;
								motion: boolean;
								baseButton: number;
							}): boolean => {
								const { col, row, release, motion, baseButton } = args;
								if (release) return true;
								if (motion) {
									const overEsc = Boolean(
										escHitbox &&
											row === escHitbox.row &&
											col >= escHitbox.startCol &&
											col <= escHitbox.endCol,
									);
									const hovered = previewHitboxes.find(
										(candidate) =>
											row === candidate.row && col >= candidate.startCol && col <= candidate.endCol,
									);
									if (overEsc !== escHovered || hovered?.key !== hoveredKey) {
										escHovered = overEsc;
										hoveredKey = hovered?.key;
										tui.requestRender();
									}
									return true;
								}
								if (baseButton !== 0) return true;
								if (
									escHitbox &&
									row === escHitbox.row &&
									col >= escHitbox.startCol &&
									col <= escHitbox.endCol
								) {
									done(undefined);
									return true;
								}
								const hitbox = previewHitboxes.find(
									(candidate) =>
										row === candidate.row && col >= candidate.startCol && col <= candidate.endCol,
								);
								if (hitbox) {
									selectedPreviewIndex = Math.max(
										0,
										visiblePreviews.findIndex((preview) => preview.key === hitbox.key),
									);
									done(hitbox.key);
								}
								return true;
							};

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
									if (!mouse) return;
									handleDialogMouse(localMouseFromSgr(tui, mouse, screenOrigin));
								},
								// overlay 事件对象路径：event.x/y 是弹框局部 0-based 坐标，
								// 与 hitbox 同基准。click 是 press+release 的合成，动作已在
								// press 做过，只消费。
								handleMouse(event: any) {
									if (event.type === "click") return { handled: true };
									handleDialogMouse({
										col: Number(event.x),
										row: Number(event.y),
										release: event.type === "release",
										motion: event.type === "move" || event.type === "drag",
										baseButton: event.button === "left" ? 0 : -1,
									});
									return { handled: true };
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
											return theme.style("█".repeat(Math.max(0, cells)), { fg: part.color });
										})
										.join("");
									const amountCells = allParts.map((part) => {
										const pct = contextWindow > 0 ? (part.tokens / contextWindow) * 100 : 0;
										const tokens = formatTokens(part.tokens).padStart(7);
										const percent = `${pct.toFixed(1).padStart(5)}%`;
										return { tokens, percent, plain: `${tokens}  ${percent}` };
									});
									// 数字列整体贴右：label 最多占到「行宽 - 数字列宽 - 前缀 - 边距」为止。
									const amountWidth = Math.max(
										...amountCells.map((cell) => visibleWidth(cell.plain)),
									);
									const labelWidth = Math.min(
										24,
										Math.max(...allParts.map((part) => part.label.length)),
										Math.max(1, inner - amountWidth - 5),
									);
									const selectedLabel = visiblePreviews[selectedPreviewIndex]?.label;
									const partRows = allParts.map((part, index) => {
										const swatch = theme.style("■", { fg: part.color });
										const label = part.label.padEnd(labelWidth);
										const amount = amountCells[index];
										const selected = part.label === selectedLabel;
										const hoverLabel = visiblePreviews.find((p) => p.key === hoveredKey)?.label;
										const prefix = selected ? "› " : "  ";
										const left = `${prefix}${swatch} ${label}`;
										const gap = Math.max(
											1,
											inner - 1 - visibleWidth(left) - visibleWidth(amount?.plain ?? ""),
										);
										// token 数字用次级色，百分比保持正文色以保留可读的主指标。
										const right = `${theme.fg("dim", amount?.tokens ?? "")}  ${amount?.percent ?? ""}`;
										const row = padLine(`${left}${" ".repeat(gap)}${right}`, inner);
										if (selected) return theme.bg("selectedBg", row);
										return part.label === hoverLabel ? theme.bg("customMessageBg", row) : row;
									});
									const border = (text: string) => theme.fg("border", text);
									const lines = [
										border(`╭${"─".repeat(inner)}╮`),
										`${border("│")}${padLine(` ${title}  ${theme.fg("dim", subtitle)}`, inner - escWidth)}${theme.fg(escHovered ? "text" : "muted", "[esc]")}${border("│")}`,
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
									// hitbox 用弹框局部坐标（0-based）：esc 在 title 行（第 1 行）
									// 尾部 │ 前 5 列，preview 行对应 partRows（顶 border=0、title=1、
									// ├=2、segments=3、空行=4，part 从 5 起）。不依赖官方放置行列。
									escHitbox = { row: 1, startCol: width - 6, endCol: width - 2 };
									previewHitboxes = visiblePreviews.flatMap((preview) => {
										const partIndex = allParts.findIndex((part) => part.label === preview.label);
										const line = 5 + partIndex;
										return partIndex >= 0 && line < visibleHeight
											? [
													{
														key: preview.key,
														row: line,
														startCol: 0,
														endCol: width - 1,
													},
												]
											: [];
									});
									screenOrigin = centeredOverlayOrigin(tui, 1, 90, width, visibleHeight);

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
							blocked: { kind: "question", message: "Reviewing context" },
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
