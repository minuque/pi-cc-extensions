import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Spacer,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import { TOOL_LOADING_INTERVAL_MS, toolLoadingIcon } from "../../utils/tool-loading-icon.ts";
import { isToolTuiFullscreen, showMoreHintText } from "./show-more-hint.ts";
import { stripAnsi, stripBackgroundAnsi, stripLeadingStatusIcon } from "../../utils/ansi-text.ts";
import { walkComponentTree } from "../../utils/component-tree.ts";
import { humanizeToolLabel, toolCallSummary } from "./names.ts";
import { isRestoredToolCall, markRestoredToolCall } from "./result.ts";
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

type ToolStatus = "queued" | "pending" | "success" | "error" | "skipped";

function status(tool: any): ToolStatus {
	if (tool?.result?.isError) return "error";
	if (tool?.result) return "success";
	if (isRestoredToolCall(tool)) return "skipped";
	if (tool?.executionStarted) return "pending";
	return "queued";
}

function statusIcon(value: ToolStatus): string {
	if (value === "success") return "✓";
	if (value === "error") return "✗";
	if (value === "pending") return toolLoadingIcon();
	return "●";
}

function scheduleGroupAnimation(patch: Patch): void {
	if (patch.animationTimer || !patch.active) return;
	patch.animationTimer = setTimeout(() => {
		patch.animationTimer = null;
		if (!patch.active) return;
		for (const group of patch.groups) {
			if (group.children.some((tool) => status(tool) === "pending")) group.invalidate();
		}
	}, TOOL_LOADING_INTERVAL_MS);
	patch.animationTimer.unref?.();
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

function toolSummary(tool: any): { main: string; detail: string } {
	return toolCallSummary(toolName(tool), tool?.args ?? {}, { variant: "grouping" });
}

function toolNameList(tools: any[]): string {
	const counts = new Map<string, number>();
	for (const tool of tools) counts.set(toolName(tool), (counts.get(toolName(tool)) ?? 0) + 1);
	return [...counts].map(([name, count]) => `${name}${count > 1 ? `×${count}` : ""}`).join(", ");
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
	/** 仅缓存已完成且折叠的分组；pending / expanded 每帧现算。 */
	private settledCache: SettledGroupCache | undefined;

	constructor(patch: Patch) {
		super();
		this.patch = patch;
		patch.groups.add(this);
	}

	addTool(tool: any): void {
		this.children.push(tool);
		tool[PARENT_KEY] = this;
	}

	releaseTools(): any[] {
		const tools = [...this.children];
		this.children.length = 0;
		this.patch.groups.delete(this);
		return tools;
	}

	removeTool(tool: any): void {
		const index = this.children.indexOf(tool);
		if (index >= 0) this.children.splice(index, 1);
		if (tool?.[PARENT_KEY] === this) delete tool[PARENT_KEY];
	}

	setExpanded(expanded: boolean): void {
		this._expanded = expanded;
		for (const tool of this.children)
			(tool as Component & { setExpanded?: (expanded: boolean) => void }).setExpanded?.(expanded);
	}

	setHintHovered(hovered: boolean): void {
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
		const counts: Record<ToolStatus, number> = {
			queued: 0,
			pending: 0,
			success: 0,
			error: 0,
			skipped: 0,
		};
		for (const tool of this.children) counts[status(tool)]++;
		const countText = (["pending", "queued", "success", "error", "skipped"] as const)
			.filter((key) => counts[key])
			.map((key) => {
				const label =
					key === "pending"
						? "running"
						: key === "queued"
							? "queued"
							: key === "success"
								? "done"
								: key === "error"
									? "failed"
									: "skipped";
				const color =
					key === "pending" ? "accent" : key === "queued" || key === "skipped" ? "muted" : key;
				return `${fg(color, String(counts[key]))} ${label}`;
			})
			.join(` ${fg("dim", "•")} `);
		const names = new Set(this.children.map(toolName));
		const label =
			names.size === 1 ? humanizeToolLabel(toolName(this.children[0])) : "Multiple Tools";
		const overall: ToolStatus = counts.error
			? "error"
			: counts.pending
				? "pending"
				: counts.success
					? "success"
					: counts.queued
						? "queued"
						: "skipped";
		if (overall === "pending") scheduleGroupAnimation(this.patch);
		const overallColor =
			overall === "pending"
				? "accent"
				: overall === "queued" || overall === "skipped"
					? "muted"
					: overall;
		const nameList = names.size > 1 ? ` ${fg("dim", `• ${toolNameList(this.children)}`)}` : "";
		// 圆点保持 dim；hover 只高亮可点击文字。
		const hint = `${fg("dim", "•")} ${fg(this.hintHovered ? "text" : "dim", showMoreHintText())}`;
		const lines = [
			"",
			truncateToWidth(
				` ${fg(overallColor, "●")} ${label}: ${countText}${nameList} ${hint}`,
				width,
				"…",
			),
		];
		const total = this.children.length;
		const expandedLines: string[] = [];
		for (let index = 0; index < total; index++) {
			const tool = this.children[index];
			const toolStatus = status(tool);
			const color =
				toolStatus === "pending"
					? "accent"
					: toolStatus === "queued" || toolStatus === "skipped"
						? "muted"
						: toolStatus;
			const branch = index === total - 1 ? "└" : "├";
			const continuation = index === total - 1 ? "  " : "│ ";
			if (!this._expanded) {
				const summary = toolSummary(tool);
				lines.push(
					truncateToWidth(
						` ${fg("dim", branch)} ${fg(color, statusIcon(toolStatus))} ${fg("toolTitle", summary.main)}${fg("dim", summary.detail)}`,
						width,
						"…",
					),
				);
				continue;
			}
			const rendered = visibleLines(tool.render(Math.max(1, width - 2)));
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
			// 展开面板统一用 user message 背景色（ccstyle 约定），不按状态区分。
			const backgroundSlot = "userMessageBg";
			for (const line of expandedLines) {
				lines.push(paddedBackgroundRow(theme, backgroundSlot, line, width));
			}
			lines.push(paddedBackgroundRow(theme, backgroundSlot, "", width));
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
				if (isGroupable(child) && !child.executionStarted && !child.result) {
					markRestoredToolCall(child);
				}
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
