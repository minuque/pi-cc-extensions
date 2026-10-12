import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Spacer,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { TOOL_LOADING_INTERVAL_MS, toolLoadingIcon } from "../../utils/tool-loading-icon.ts";
import {
	ASK_USER_QUESTION_TOOL_NAME,
	askUserAnswerText,
	askUserAnswers,
	type AskUserAnswer,
} from "./ask-user-question.ts";
import {
	CODEMODE_TOOL_NAME,
	codemodeCalls,
	codemodeOutputLineCount,
	codemodeSummaryParts,
} from "./codemode.ts";
import { getToolMouseTui } from "../mouse/scroll.ts";
import { mcpToolTitle } from "./mcp-title.ts";
import { collapseHintText, isToolTuiFullscreen, showMoreHintText } from "./names.ts";
import { stripAnsi, stripBackgroundAnsi, stripLeadingStatusIcon } from "../../utils/ansi-text.ts";
import { walkComponentTree } from "../../utils/component-tree.ts";
import {
	fitToolCallSummary,
	humanizeToolLabel,
	renderToolSummary,
	SHELL_TOOL_NAMES,
	toolCallSummary,
	type ToolCallSummary,
} from "./names.ts";
import { formatToolDuration, headTruncateToWidth, toolViewportWidth } from "./result.ts";
import { isLiveToolCall } from "./tool-state.ts";
import {
	patchRegistry,
	TOOL_GROUPING_GENERATION_KEY as GENERATION_KEY,
	TOOL_GROUPING_PARENT_KEY as PARENT_KEY,
	TOOL_GROUPING_PATCH_KEY as PATCH_KEY,
} from "../../utils/patch-keys.ts";

const NON_GROUPABLE = new Set(["edit", "write", "apply_patch"]);

type Patch = {
	owner: object;
	active: boolean;
	prototype: any;
	original: { addChild: Function; removeChild: Function; clear: Function };
	installed: { addChild: Function; removeChild: Function; clear: Function };
	groups: Set<ToolGroupComponent>;
	enabled: () => boolean;
	generation: number;
	lastEnabled: boolean;
	theme?: any;
	animationTimer: ReturnType<typeof setTimeout> | null;
};

function toolName(tool: any): string {
	return String(tool?.toolName ?? tool?.toolDefinition?.name ?? "tool");
}

/**
 * 标题：MCP 工具用 adapter 暴露的真实工具名，其余回退工具名人性化。
 */
function toolTitle(tool: any): string {
	const name = toolName(tool);
	return (
		mcpToolTitle({
			toolName: name,
			definition: tool?.toolDefinition ?? tool?.builtInToolDefinition,
		}) ?? humanizeToolLabel(name)
	);
}

function isGroupable(value: unknown): boolean {
	return value instanceof ToolExecutionComponent && !NON_GROUPABLE.has(toolName(value));
}

function isIgnorable(value: unknown): boolean {
	if (value instanceof Spacer) return true;
	if (!(value instanceof AssistantMessageComponent)) return false;
	const children = (value as any).contentContainer?.children;
	return Array.isArray(children) && children.length === 0;
}

function previousSibling(
	children: any[],
	start: number,
): { child: any; index: number } | undefined {
	let skipped = 0;
	for (let index = start; index >= 0; index--) {
		const child = children[index];
		if (isIgnorable(child) && skipped < 3) {
			skipped++;
			continue;
		}
		return { child, index };
	}
	return undefined;
}

type ToolStatus = "pending" | "success" | "error";

function status(tool: any): ToolStatus {
	if (tool?.result?.isError) return "error";
	if (tool?.isPartial === true || (tool?.executionStarted && !tool?.result)) return "pending";
	return tool?.result ? "success" : "pending";
}

function statusIcon(value: ToolStatus): string {
	if (value === "success") return "✓";
	if (value === "error") return "✗";
	return toolLoadingIcon();
}

/** 等待窗口或运行中的行：spinner 逐帧变化，分组卡要跟着跳帧。 */
function isAnimatingTool(tool: any): boolean {
	if (status(tool) !== "pending") return false;
	return Boolean(tool?.executionStarted) || isLiveToolCall(tool?.toolCallId);
}

function scheduleGroupAnimation(patch: Patch): void {
	if (patch.animationTimer || !patch.active) return;
	patch.animationTimer = setTimeout(() => {
		patch.animationTimer = null;
		if (!patch.active) return;
		let needsRender = false;
		for (const group of patch.groups) {
			if ((group.children as any[]).some(isAnimatingTool)) {
				group.invalidate();
				// 分组卡不是 ToolExecutionComponent：它的 invalidate() 不会请求渲染，
				// 不补这一步 spinner 只在别人渲染时才跳帧（并行工具下表现为卡顿/冻结）。
				needsRender = true;
			}
		}
		if (needsRender) requestAnimationRender(patch);
	}, TOOL_LOADING_INTERVAL_MS);
	patch.animationTimer.unref?.();
}

/** 借用子工具卡的 ui 请求一帧；子卡缺失时回退到扩展持有的 TUI 槽。 */
function requestAnimationRender(patch: Patch): void {
	for (const group of patch.groups) {
		const ui = (group.children as any[]).find(
			(tool) => typeof tool?.ui?.requestRender === "function",
		)?.ui;
		if (ui) {
			ui.requestRender();
			return;
		}
	}
	getToolMouseTui()?.requestRender?.();
}

function visibleLines(lines: string[]): string[] {
	return lines.filter((line) => stripAnsi(line).trim());
}

function stripLeadingSpaces(line: string, count: number): string {
	let offset = 0;
	let removed = 0;
	let ansi = "";
	while (offset < line.length) {
		const control = line.slice(offset).match(/^\x1b\[[0-?]*[ -/]*[@-~]/)?.[0];
		if (control) {
			ansi += control;
			offset += control.length;
			continue;
		}
		if (removed < count && line[offset] === " ") {
			removed++;
			offset++;
			continue;
		}
		break;
	}
	return ansi + line.slice(offset);
}

/** 生成一行铺满 width 的 slot 背景行；bgAnsiOverride 可替换背景 ANSI（用于提亮等）。 */
export function paddedBackgroundRow(
	theme: any,
	slot: string,
	content: string,
	width: number,
	bgAnsiOverride?: string,
): string {
	const innerWidth = Math.max(0, width - 2);
	const clipped = truncateToWidth(stripBackgroundAnsi(content), innerWidth, "");
	const row = ` ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} `;
	const bgAnsi =
		bgAnsiOverride ||
		(typeof theme?.bg === "function"
			? theme.getBgAnsi?.(slot) || theme.bg(slot, "").match(/^\x1b\[[0-?]*[ -/]*[@-~]/)?.[0] || ""
			: "");
	const stable = bgAnsi ? row.replace(/\x1b\[(?:0)?m/g, (reset) => reset + bgAnsi) : row;
	if (!bgAnsi) return typeof theme?.bg === "function" ? theme.bg(slot, stable) : row;
	return `${bgAnsi}${stable}\x1b[49m`;
}

function toolSummary(tool: any): ToolCallSummary {
	return toolCallSummary(toolName(tool), tool?.args ?? {}, {
		title: toolTitle(tool),
		variant: "grouping",
		cwd: tool?.cwd,
	});
}

/**
 * codemode 的折叠行：有结果就报该次调用的统计（与单卡汇总行同一套口径），
 * 免得一张卡里几行长代码预览互相看不出区别。还没结果时退回代码预览。
 */
/**
 * ask_user_question 的折叠行：有结果就报「问题 -> 回答」，
 * 多题压成一行并标注剩余条数。还没结果时退回问题预览。
 */
function askUserResultSummary(tool: any): ToolCallSummary | undefined {
	if (toolName(tool) !== ASK_USER_QUESTION_TOOL_NAME || !tool?.result) return undefined;
	const answers = askUserAnswers(tool.result)
		.map((answer: AskUserAnswer, index: number) => ({ answer, index }))
		.sort((left, right) => {
			const leftIndex = Number(left.answer.questionIndex);
			const rightIndex = Number(right.answer.questionIndex);
			const leftMissing = !Number.isFinite(leftIndex);
			const rightMissing = !Number.isFinite(rightIndex);
			if (leftMissing || rightMissing) {
				if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
				return left.index - right.index;
			}
			return leftIndex - rightIndex;
		})
		.map((entry) => entry.answer);
	if (answers.length === 0) {
		const label = tool.result?.details?.cancelled === true ? "Declined" : "Done";
		return { main: `${toolTitle(tool)} ${label}`, detail: "" };
	}
	const first = answers[0]!;
	const question = String(first.question ?? "").trim() || "Question";
	const more = answers.length > 1 ? ` (+${answers.length - 1})` : "";
	return {
		main: `${toolTitle(tool)} ${question} -> ${askUserAnswerText(first)}${more}`,
		detail: "",
	};
}

function codemodeResultSummary(tool: any): ToolCallSummary | undefined {
	if (toolName(tool) !== CODEMODE_TOOL_NAME || !tool?.result) return undefined;
	const parts = codemodeSummaryParts(
		codemodeCalls(tool.result),
		codemodeOutputLineCount(tool.result),
		tool?.isPartial === true,
	);
	return { main: `${toolTitle(tool)} ${parts.join(" · ")}`, detail: "" };
}

/**
 * 组内 shell 行的尾巴：只报耗时（`· 12.4s`）。输出和错误正文都在展开后看；
 * 失败靠行首的 ✗，组头另有 failed 计数。
 * 耗时取 pi 记在结果上的 durationMs（单卡渲染上下文里的同一个值），运行中还拿不到就不报。
 */
function shellResultTail(
	tool: any,
	fg: (color: string, text: string) => string,
	toolStatus: ToolStatus,
): string {
	if (!SHELL_TOOL_NAMES.has(toolName(tool)) || toolStatus === "pending" || !tool?.result) return "";
	const durationMs = tool.result?.durationMs;
	const duration =
		typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
			? formatToolDuration(durationMs)
			: "";
	return duration ? ` ${fg("dim", `· ${duration}`)}` : "";
}

/** 分组折叠态的一行子工具：`├/└` + 状态图标 + 与组内同一套摘要。 */
function collapsedGroupToolLine(
	tool: any,
	last: boolean,
	fg: (color: string, text: string) => string,
	width: number,
): string {
	const toolStatus = status(tool);
	const color = toolStatus === "pending" ? "accent" : toolStatus;
	const summary = askUserResultSummary(tool) ?? codemodeResultSummary(tool) ?? toolSummary(tool);
	const prefix = ` ${fg("dim", last ? "└" : "├")} ${fg(color, statusIcon(toolStatus))} `;
	const detail = fg("dim", summary.detail);
	const result = shellResultTail(tool, fg, toolStatus);
	const rowWidth = toolViewportWidth(width);
	const mainWidth = Math.max(
		0,
		rowWidth - visibleWidth(prefix) - visibleWidth(detail) - visibleWidth(result),
	);
	return truncateToWidth(
		`${prefix}${renderToolSummary(summary, mainWidth, fg)}${detail}${result}`,
		rowWidth,
		"",
	);
}

type GroupHeaderCounts = { pending: number; success: number; error: number };

/** 组头计数：`2 done · 1 failed`。没有计数时返回空串。 */
function groupCountText(
	counts: GroupHeaderCounts,
	fg: (color: string, text: string) => string,
): string {
	return (["pending", "success", "error"] as const)
		.filter((key) => counts[key])
		.map((key) => {
			const label = key === "pending" ? "running" : key === "success" ? "done" : "failed";
			const color = key === "pending" ? "accent" : key;
			return `${fg(color, String(counts[key]))} ${label}`;
		})
		.join(` ${fg("dim", "·")} `);
}

/** 组头圆点色：有失败取 error，否则有运行中取 accent，否则 success。 */
function groupOverallStatus(counts: GroupHeaderCounts): ToolStatus {
	return counts.error ? "error" : counts.pending ? "pending" : "success";
}

/**
 * 组头的工具列表：名称用与单组标题、子行同一套人性化写法，次数一律带上（各跑一次也报 ×1）。
 * 同名（同显示标题）的合并成一项，避免 `MCP call×1, MCP call×1` 这种重复。
 */
function toolNameList(tools: any[]): string {
	const counts = new Map<string, number>();
	for (const tool of tools) {
		const label = toolTitle(tool);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return [...counts].map(([label, count]) => `${label}×${count}`).join(", ");
}

let nextGroupId = 1;

type SettledGroupCache = {
	width: number;
	hover: boolean;
	theme: unknown;
	fullscreen: boolean;
	children: readonly unknown[];
	args: unknown[];
	results: unknown[];
	lines: string[];
};

type ExpandedGroupCache = {
	width: number;
	hover: boolean;
	theme: unknown;
	fullscreen: boolean;
	/** 背景槽位参与命中判断：改配置后已展开的分组不能继续用旧底色。 */
	bgSlot: string;
	paints: readonly unknown[];
	lines: string[];
};

export class ToolGroupComponent extends Container {
	readonly toolCallId = `ccstyle-tool-group-${nextGroupId++}`;
	readonly toolName = "Tool group";
	private _expanded = false;
	/** 分组是否展开（只读；测试与外部读状态用）。 */
	get expanded(): boolean {
		return this._expanded;
	}
	private hintHovered = false;
	private readonly patch: Patch;
	/** 仅缓存已完成且折叠的分组；pending 每帧现算。 */
	private settledCache: SettledGroupCache | undefined;
	/** 展开分组：子工具 paint 引用未变则复用整卡行。 */
	private expandedPaintCache: ExpandedGroupCache | undefined;

	constructor(patch: Patch) {
		super();
		this.patch = patch;
		patch.groups.add(this);
	}

	private clearPaintCache(): void {
		this.settledCache = undefined;
		this.expandedPaintCache = undefined;
	}

	addTool(tool: any): void {
		this.clearPaintCache();
		this.children.push(tool);
		tool[PARENT_KEY] = this;
	}

	releaseTools(): any[] {
		this.clearPaintCache();
		const tools = [...this.children];
		this.children.length = 0;
		this.patch.groups.delete(this);
		return tools;
	}

	removeTool(tool: any): void {
		this.clearPaintCache();
		const index = this.children.indexOf(tool);
		if (index >= 0) this.children.splice(index, 1);
		if (tool?.[PARENT_KEY] === this) delete tool[PARENT_KEY];
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) this.clearPaintCache();
		this._expanded = expanded;
		for (const tool of this.children)
			(tool as Component & { setExpanded?: (expanded: boolean) => void }).setExpanded?.(expanded);
	}

	setHintHovered(hovered: boolean): void {
		if (this.hintHovered !== hovered) this.clearPaintCache();
		this.hintHovered = hovered;
	}

	/**
	 * 展开时按局部行定位内部组件（null = 行属于 group 自身：空行/头行/尾行）。
	 * 行数计算与 render 保持一致：宽度 width-2 + 空行过滤。
	 */
	childAtRow(localRow: number, width: number): { component: any; row: number } | null {
		if (!this._expanded || localRow < 2) return null;
		let offset = 2;
		for (const tool of this.children) {
			let lines: string[] = [];
			try {
				const rendered = tool.render?.(Math.max(1, width - 2));
				if (Array.isArray(rendered)) lines = visibleLines(rendered.map((line) => String(line)));
			} catch {
				lines = [];
			}
			const lineCount = Math.max(1, lines.length);
			if (localRow < offset + lineCount) {
				return { component: tool, row: localRow - offset };
			}
			offset += lineCount;
		}
		return null;
	}

	invalidate(): void {
		this.clearPaintCache();
		for (const tool of this.children) tool.invalidate?.();
	}

	private settledCacheHit(width: number): string[] | undefined {
		const cache = this.settledCache;
		if (!cache || this._expanded) return;
		if (
			cache.width !== width ||
			cache.hover !== this.hintHovered ||
			cache.theme !== this.patch.theme ||
			cache.fullscreen !== isToolTuiFullscreen()
		) {
			return;
		}
		const tools = this.children as any[];
		if (cache.children.length !== tools.length) return;
		for (let i = 0; i < tools.length; i++) {
			const tool = tools[i];
			if (
				cache.children[i] !== tool ||
				cache.args[i] !== tool?.args ||
				cache.results[i] !== tool?.result ||
				status(tool) === "pending"
			) {
				return;
			}
		}
		return cache.lines;
	}

	private storeSettledCache(width: number, lines: string[]): void {
		this.settledCache = {
			width,
			hover: this.hintHovered,
			theme: this.patch.theme,
			fullscreen: isToolTuiFullscreen(),
			children: [...this.children],
			args: (this.children as any[]).map((tool) => tool?.args),
			results: (this.children as any[]).map((tool) => tool?.result),
			lines,
		};
	}

	render(width: number): string[] {
		const cached = this.settledCacheHit(width);
		if (cached) return cached;
		const theme = this.patch.theme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const counts = { pending: 0, success: 0, error: 0 };
		for (const tool of this.children) counts[status(tool)]++;
		const countText = groupCountText(counts, fg);
		const names = new Set(this.children.map(toolName));
		const label = names.size === 1 ? toolTitle(this.children[0]) : "Multiple Tools";
		const overall = groupOverallStatus(counts);
		if ((this.children as any[]).some(isAnimatingTool)) scheduleGroupAnimation(this.patch);
		const overallColor = overall === "pending" ? "accent" : overall;
		// 圆点保持 dim；hover 只高亮可点击文字。
		const hintText = this._expanded ? collapseHintText() : showMoreHintText();
		const hint = `${fg("dim", "·")} ${fg(this.hintHovered ? "text" : "dim", hintText)}`;
		const rowWidth = toolViewportWidth(width);
		// 工具列表让位给展开提示：提示被截断的话，鼠标层要在行尾找 `click to show more`
		// 就找不到，整张卡在窄宽度下点不开。名字截断后子行里仍能看全。
		const head = ` ${fg(overallColor, "●")} ${label}: ${countText}`;
		const tail = ` ${hint}`;
		const listRoom = rowWidth - visibleWidth(head) - visibleWidth(tail) - 3;
		// 连一个工具名都放不下就不放列表：退化成 `· …` 只会把行撑爆。
		const nameList =
			names.size > 1 && listRoom >= 4
				? ` ${fg("dim", `· ${headTruncateToWidth(toolNameList(this.children), listRoom)}`)}`
				: "";
		const lines = ["", truncateToWidth(`${head}${nameList}${tail}`, rowWidth, "")];
		const total = this.children.length;
		const childPaints = this._expanded
			? (this.children as any[]).map((tool) => tool.render?.(Math.max(1, width - 2)))
			: undefined;
		if (this._expanded && childPaints) {
			const expandedHit = this.expandedPaintCache;
			if (
				expandedHit &&
				expandedHit.width === width &&
				expandedHit.hover === this.hintHovered &&
				expandedHit.theme === this.patch.theme &&
				expandedHit.fullscreen === isToolTuiFullscreen() &&
				expandedHit.bgSlot === config.expandedCardBackground &&
				expandedHit.paints.length === childPaints.length &&
				expandedHit.paints.every((paint, index) => paint === childPaints[index])
			) {
				return expandedHit.lines;
			}
		}
		const expandedLines: string[] = [];
		for (let index = 0; index < total; index++) {
			const tool = this.children[index];
			const toolStatus = status(tool);
			const color = toolStatus === "pending" ? "accent" : toolStatus;
			const branch = index === total - 1 ? "└" : "├";
			const continuation = index === total - 1 ? "  " : "│ ";
			if (!this._expanded) {
				lines.push(collapsedGroupToolLine(tool, index === total - 1, fg, width));
				continue;
			}
			const rendered = visibleLines(Array.isArray(childPaints?.[index]) ? childPaints[index] : []);
			if (rendered.length) {
				rendered[0] = stripLeadingStatusIcon(rendered[0])
					.replace(/^ +/, "")
					.replace(/^((?:\x1b\[[0-?]*[ -/]*[@-~])*) +/, "$1");
			}
			const childLines = rendered.length ? rendered : [toolSummary(tool).main];
			for (let lineIndex = 0; lineIndex < childLines.length; lineIndex++) {
				const content =
					// 续行只剥外层 Box 的 1 格 left pad，保留 Input/Output 相对缩进
					lineIndex === 0 ? childLines[lineIndex] : stripLeadingSpaces(childLines[lineIndex], 1);
				const prefix =
					lineIndex === 0
						? `${fg("dim", branch)} ${fg(color, statusIcon(toolStatus))} `
						: fg("dim", continuation);
				expandedLines.push(prefix + content);
			}
		}
		if (this._expanded) {
			// 展开面板统一一个背景槽位（ccstyle 约定），不按状态区分。
			const backgroundSlot = config.expandedCardBackground;
			for (const line of expandedLines) {
				lines.push(paddedBackgroundRow(theme, backgroundSlot, line, width));
			}
			lines.push(paddedBackgroundRow(theme, backgroundSlot, "", width));
			this.expandedPaintCache = {
				width,
				hover: this.hintHovered,
				theme: this.patch.theme,
				fullscreen: isToolTuiFullscreen(),
				bgSlot: backgroundSlot,
				paints: childPaints ?? [],
				lines,
			};
		} else if (counts.pending === 0) {
			this.storeSettledCache(width, lines);
		}
		return lines;
	}
}

function ungroup(patch: Patch): void {
	for (const group of [...patch.groups]) {
		const parent = (group as any)[PARENT_KEY];
		const children = parent?.children;
		if (!Array.isArray(children)) {
			patch.groups.delete(group);
			continue;
		}
		const index = children.indexOf(group);
		if (index < 0) {
			patch.groups.delete(group);
			continue;
		}
		const tools = group.releaseTools();
		for (const tool of tools) tool[PARENT_KEY] = parent;
		children.splice(index, 1, ...tools);
	}
}

function normalizeGroup(patch: Patch, group: ToolGroupComponent): void {
	if (group.children.length > 1) return;
	const parent = (group as any)[PARENT_KEY];
	const index = parent?.children?.indexOf(group) ?? -1;
	const tools = group.releaseTools();
	delete (group as any)[PARENT_KEY];
	if (index < 0) {
		for (const tool of tools) delete tool[PARENT_KEY];
		return;
	}
	if (tools.length === 1) {
		tools[0][PARENT_KEY] = parent;
		parent.children.splice(index, 1, tools[0]);
	} else {
		parent.children.splice(index, 1);
	}
}

function maybeGroup(patch: Patch, parent: any, component: any): void {
	if (
		!patch.active ||
		!patch.enabled() ||
		parent instanceof ToolGroupComponent ||
		!isGroupable(component)
	)
		return;
	component[GENERATION_KEY] = patch.generation;
	const children = parent?.children;
	if (!Array.isArray(children)) return;
	const index = children.indexOf(component);
	const prior = previousSibling(children, index - 1);
	if (!prior) return;
	if (prior.child instanceof ToolGroupComponent && (prior.child as any).patch === patch) {
		children.splice(index, 1);
		prior.child.addTool(component);
		return;
	}
	if (!isGroupable(prior.child) || prior.child[GENERATION_KEY] !== patch.generation) return;
	const group = new ToolGroupComponent(patch);
	group.addTool(prior.child);
	group.addTool(component);
	(group as any)[PARENT_KEY] = parent;
	children[prior.index] = group;
	children.splice(index, 1);
}

/** /reload 不会重新 addChild；扫描当前 mounted roots，把已有工具重新送入同一分组规则。 */
function regroup(patch: Patch, root: any): void {
	if (!patch.active || !patch.enabled() || !root) return;
	walkComponentTree(root, (value: any) => {
		// 分组卡与可分组工具是分组边界：不继续下钻（与原有遍历过滤一致）。
		if (value instanceof ToolGroupComponent || isGroupable(value)) return false;
		const children = value.children;
		if (Array.isArray(children)) {
			for (const child of [...children]) {
				if (child && typeof child === "object") child[PARENT_KEY] = value;
				maybeGroup(patch, value, child);
			}
		}
	});
}

export type ToolGroupingHooks = {
	setTheme(theme: any): void;
	refresh(root?: any): void;
	shutdown(): void;
};

export function installToolGrouping(getEnabled: () => boolean): ToolGroupingHooks {
	const prototype = Container.prototype as any;
	const previous = patchRegistry.get<Patch>(PATCH_KEY);
	if (previous) {
		previous.active = false;
		previous.enabled = () => false;
		if (previous.animationTimer) clearTimeout(previous.animationTimer);
		previous.animationTimer = null;
		ungroup(previous);
	}
	const original = {
		addChild:
			previous && prototype.addChild === previous.installed.addChild
				? previous.original.addChild
				: prototype.addChild,
		removeChild:
			previous && prototype.removeChild === previous.installed.removeChild
				? previous.original.removeChild
				: prototype.removeChild,
		clear:
			previous && prototype.clear === previous.installed.clear
				? previous.original.clear
				: prototype.clear,
	};
	const patch: Patch = {
		owner: {},
		active: true,
		prototype,
		original,
		installed: undefined as any,
		groups: new Set(),
		enabled: getEnabled,
		generation: 0,
		lastEnabled: getEnabled(),
		animationTimer: null,
	};
	patch.installed = {
		addChild: function (this: any, component: any) {
			const result = patch.original.addChild.call(this, component);
			if (component && typeof component === "object") component[PARENT_KEY] = this;
			maybeGroup(patch, this, component);
			return result;
		},
		removeChild: function (this: any, component: any) {
			const group = component?.[PARENT_KEY];
			if (group instanceof ToolGroupComponent && (group as any)[PARENT_KEY] === this) {
				group.removeTool(component);
				normalizeGroup(patch, group);
				return;
			}
			const result = patch.original.removeChild.call(this, component);
			if (component?.[PARENT_KEY] === this) delete component[PARENT_KEY];
			if (this instanceof ToolGroupComponent) normalizeGroup(patch, this);
			if (component instanceof ToolGroupComponent) {
				for (const tool of component.releaseTools()) delete tool[PARENT_KEY];
			}
			return result;
		},
		clear: function (this: any) {
			for (const child of [...(this.children ?? [])]) {
				if (child instanceof ToolGroupComponent) {
					for (const tool of child.releaseTools()) delete tool[PARENT_KEY];
				}
				if (child?.[PARENT_KEY] === this) delete child[PARENT_KEY];
			}
			if (this instanceof ToolGroupComponent) patch.groups.delete(this);
			return patch.original.clear.call(this);
		},
	};
	prototype.addChild = patch.installed.addChild;
	prototype.removeChild = patch.installed.removeChild;
	prototype.clear = patch.installed.clear;
	patchRegistry.install(PATCH_KEY, patch);
	return {
		setTheme(theme: any) {
			patch.theme = theme;
		},
		refresh(root?: any) {
			const enabled = patch.enabled();
			if (enabled !== patch.lastEnabled) {
				patch.lastEnabled = enabled;
				if (enabled) patch.generation++;
			}
			if (enabled) regroup(patch, root);
			else ungroup(patch);
		},
		shutdown() {
			if (!patch.active) return;
			patch.active = false;
			if (patch.animationTimer) clearTimeout(patch.animationTimer);
			patch.animationTimer = null;
			patch.enabled = () => false;
			ungroup(patch);
			if (prototype.addChild === patch.installed.addChild)
				prototype.addChild = patch.original.addChild;
			if (prototype.removeChild === patch.installed.removeChild)
				prototype.removeChild = patch.original.removeChild;
			if (prototype.clear === patch.installed.clear) prototype.clear = patch.original.clear;
		},
	};
}
