/**
 * 会话记录浏览层：对齐 Claude Code 的 transcript 视图。
 *
 * on / compact 模式、全屏、输入框有焦点时按「展开工具输出」键（默认 ctrl+o），
 * 打开一个铺满屏幕的弹层，盖住对话区、输入框和底栏。弹层持有焦点，按键只用来翻阅。
 *
 * 弹层不走对话区的渲染流程：照着对话区现有组件新建一份副本来画。
 * - 工具卡：按原参数与结果新建 ToolExecutionComponent，全部展开；
 * - 模型回复：按原消息新建 AssistantMessageComponent，思考块完整显示；
 * - 其余（用户消息、提示、摘要）：不受展开影响，直接画原组件；
 * - compact 挂进对话区的回合尾行：跳过。
 * 副本带浏览标记（见 transcript-scope），compact 折叠、分组、互斥收起与行数上限都不作用于它们。
 * 对话区本身一个状态都不改，关掉弹层即恢复原样。
 *
 * Pi 把 app.tools.expand 列为保留键，registerShortcut 注册不上；这里在原始输入到达
 * 输入框之前拦截。只认 Pi 自己会响应该键的组件（带 actionHandlers 的编辑器）。
 */

import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { config } from "../config/config.ts";
import { walkComponentTree } from "../utils/component-tree.ts";
import { isCompactRoundTail } from "./compact-mode.ts";
import { stripToolFrameMarkers } from "./mouse/packets.ts";
import { fullscreenLazyTui, getToolMouseTui } from "./mouse/scroll.ts";
import { ToolGroupComponent } from "./tool/grouping.ts";
import { expandShortcutText } from "./tool/names.ts";
import { markTranscriptComponent, withTranscriptScope } from "./transcript-scope.ts";

const EXPAND_ACTION = "app.tools.expand";
// 与 Pi 的 tui.altScreen.pageUp/pageDown 同一重叠行数，翻页后保留上下文。
const PAGE_SCROLL_OVERLAP = 4;
const WHEEL_LINES = 3;

type TranscriptUi = {
	onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined): () => void;
	custom<T>(factory: (...args: any[]) => any, options?: any): Promise<T>;
};

type ScrollAction =
	| { kind: "lines"; lines: number }
	| { kind: "half"; direction: 1 | -1 }
	| { kind: "page"; direction: 1 | -1 }
	| { kind: "top" }
	| { kind: "bottom" }
	| { kind: "prompt"; direction: 1 | -1 };

const SCROLL_KEYS: Array<[string[], ScrollAction]> = [
	[["j", "down", "ctrl+n"], { kind: "lines", lines: 1 }],
	[["k", "up", "ctrl+p"], { kind: "lines", lines: -1 }],
	[["ctrl+d"], { kind: "half", direction: 1 }],
	[["ctrl+u"], { kind: "half", direction: -1 }],
	[["space", "ctrl+f", "pageDown"], { kind: "page", direction: 1 }],
	[["b", "ctrl+b", "shift+space", "pageUp"], { kind: "page", direction: -1 }],
	[["g", "home"], { kind: "top" }],
	[["shift+g", "end"], { kind: "bottom" }],
	[["}"], { kind: "prompt", direction: 1 }],
	[["{"], { kind: "prompt", direction: -1 }],
];

const EXIT_KEYS = ["escape", "q", "ctrl+c"];

function matchesAny(data: string, keys: string[]): boolean {
	return keys.some((key) => matchesKey(data, key as any));
}

export function transcriptScrollAction(data: string): ScrollAction | undefined {
	for (const [keys, action] of SCROLL_KEYS) {
		if (matchesAny(data, keys)) return action;
	}
	return undefined;
}

export function isTranscriptExitKey(data: string): boolean {
	return matchesAny(data, EXIT_KEYS) || getKeybindings().matches(data, EXPAND_ACTION as any);
}

// ---------------------------------------------------------------------------
// 副本
// ---------------------------------------------------------------------------

type TranscriptItem = { view: any; prompt: boolean };
type CloneEntry = { view: any; signature: unknown[] };

const clones = new WeakMap<object, CloneEntry>();

function sameSignature(left: unknown[], right: unknown[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function reuseOrClone(live: any, signature: unknown[], build: () => any): any {
	const cached = clones.get(live);
	if (cached && sameSignature(cached.signature, signature)) return cached.view;
	const view = withTranscriptScope(build);
	markTranscriptComponent(view);
	clones.set(live, { view, signature });
	return view;
}

function cloneTool(live: any): any {
	const signature = [
		live.args,
		live.result,
		live.isPartial,
		live.executionStarted,
		live.argsComplete,
	];
	return reuseOrClone(live, signature, () => {
		const view: any = new ToolExecutionComponent(
			live.toolName,
			live.toolCallId,
			live.args,
			{
				showImages: live.showImages,
				imageWidthCells: live.imageWidthCells,
				outputPad: live.outputPad,
			},
			live.toolDefinition,
			live.ui,
			live.cwd,
		);
		if (live.argsComplete) view.setArgsComplete();
		if (live.executionStarted) view.markExecutionStarted();
		if (live.result) view.updateResult(live.result, live.isPartial === true);
		view.setExpanded(true);
		return view;
	});
}

function cloneAssistant(live: any): any {
	const message = live.lastMessage;
	if (!message) return undefined;
	return reuseOrClone(live, [message, live.isStreaming], () => {
		const view: any = new AssistantMessageComponent(
			undefined,
			false,
			live.markdownTheme,
			live.hiddenThinkingLabel,
			live.outputPad,
			live.markdownTransformers,
		);
		view.updateContent(message, live.isStreaming === true);
		return view;
	});
}

/** 对话区（Pi 的 chatContainer）：直接装着回复或用户消息的那个容器。 */
export function findChatContainer(root: any): any {
	let found: any;
	walkComponentTree(root, (value: any) => {
		if (found) return false;
		const children = value?.children;
		if (
			Array.isArray(children) &&
			children.some(
				(child: any) =>
					child instanceof AssistantMessageComponent || child instanceof UserMessageComponent,
			)
		) {
			found = value;
			return false;
		}
		return undefined;
	});
	return found;
}

/** 按对话区现有内容生成浏览项：工具与回复用副本，其余直接用原组件。 */
export function collectTranscriptItems(container: any): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	const pushTool = (tool: any) => {
		if (tool instanceof ToolExecutionComponent)
			items.push({ view: cloneTool(tool), prompt: false });
	};
	for (const child of Array.isArray(container?.children) ? container.children : []) {
		if (isCompactRoundTail(child)) continue;
		if (child instanceof ToolGroupComponent) {
			for (const tool of child.children) pushTool(tool);
		} else if (child instanceof ToolExecutionComponent) {
			pushTool(child);
		} else if (child instanceof AssistantMessageComponent) {
			const view = cloneAssistant(child);
			if (view) items.push({ view, prompt: false });
		} else if (child && typeof child.render === "function") {
			items.push({ view: child, prompt: child instanceof UserMessageComponent });
		}
	}
	return items;
}

// ---------------------------------------------------------------------------
// 弹层
// ---------------------------------------------------------------------------

export type TranscriptViewOptions = {
	rows: () => number;
	items: () => TranscriptItem[];
	theme: any;
	close: () => void;
	focused: (view: object) => boolean;
	/** 正文滚动了 delta 行（正数为向下翻），bodyHeight 为正文可见行数。 */
	scrolled?: (delta: number, bodyHeight: number) => void;
};

type ScreenPoint = { row: number; col: number; scrollView?: unknown };

/**
 * 让 Pi 的屏幕选区跟着浏览层的正文走。
 *
 * 有弹层时 Pi 的选区记的是屏幕行号（不挂 scrollView），复制也只从屏幕文字里取。
 * 正文滚动 delta 行后把选区上移 delta 行，高亮与复制都跟着原来的文字。
 * 选区有一端滚出正文区：屏幕上已没有那段文字，清掉选区，免得复制到别的内容。
 */
export function followScreenSelection(tui: any, delta: number, bodyHeight: number): void {
	if (!tui || delta === 0) return;
	const anchor: ScreenPoint | undefined = tui.selectionAnchor;
	const focus: ScreenPoint | undefined = tui.selectionFocus;
	if (!anchor || !focus || anchor.scrollView || focus.scrollView) return;
	const move = (point: ScreenPoint): ScreenPoint => ({ ...point, row: point.row - delta });
	const nextAnchor = move(anchor);
	const nextFocus = move(focus);
	const inside = (point: ScreenPoint) => point.row >= 0 && point.row < bodyHeight;
	if (!inside(nextAnchor) || !inside(nextFocus)) {
		tui.resetTextSelection?.();
		return;
	}
	tui.selectionAnchor = nextAnchor;
	tui.selectionFocus = nextFocus;
	const range = tui.selectionInitialRange;
	if (range?.start && range?.end) {
		tui.selectionInitialRange = { start: move(range.start), end: move(range.end) };
	}
	// 双击/三击按坐标累计：位置已变，不再和上一次点击连成多击。
	tui.lastClick = undefined;
}

export class TranscriptView {
	private scrollTop = 0;
	private followEnd = true;
	private bodyHeight = 1;
	private totalLines = 0;
	private promptRows: number[] = [];
	private hadFocus = false;
	private closed = false;
	/** 上一帧画出的滚动位置：与本帧不同就通知选区跟随。 */
	private renderedScrollTop: number | undefined;

	private readonly options: TranscriptViewOptions;

	constructor(options: TranscriptViewOptions) {
		this.options = options;
	}

	private maxScroll(): number {
		return Math.max(0, this.totalLines - this.bodyHeight);
	}

	private scrollTo(row: number): void {
		this.scrollTop = Math.max(0, Math.min(this.maxScroll(), row));
		this.followEnd = this.scrollTop >= this.maxScroll();
	}

	private scrollBy(lines: number): void {
		this.scrollTo(this.scrollTop + lines);
	}

	private apply(action: ScrollAction): void {
		switch (action.kind) {
			case "lines":
				this.scrollBy(action.lines);
				break;
			case "half":
				this.scrollBy(action.direction * Math.max(1, Math.floor(this.bodyHeight / 2)));
				break;
			case "page":
				this.scrollBy(action.direction * Math.max(1, this.bodyHeight - PAGE_SCROLL_OVERLAP));
				break;
			case "top":
				this.scrollTo(0);
				break;
			case "bottom":
				this.scrollTo(this.maxScroll());
				break;
			case "prompt": {
				const target =
					action.direction > 0
						? this.promptRows.find((row) => row > this.scrollTop)
						: this.promptRows.findLast((row) => row < this.scrollTop);
				if (target !== undefined) this.scrollTo(target);
				break;
			}
		}
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.options.close();
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (isTranscriptExitKey(data)) {
			this.close();
			return;
		}
		const action = transcriptScrollAction(data);
		if (action) this.apply(action);
		// 其余按键不做任何事：浏览层不编辑输入框。
	}

	/**
	 * 只接管滚轮。按下、拖动、松开不处理：Pi 有弹层时按屏幕文字做选中复制，
	 * 放行后浏览层里的文字照常能拖选、双击选词、复制。
	 */
	handleMouse(event: any): { handled: boolean } | undefined {
		if (event?.type !== "wheel") return undefined;
		const delta = Number(event.wheelDelta) || 0;
		if (delta !== 0) this.scrollBy(Math.sign(delta) * WHEEL_LINES);
		return { handled: true };
	}

	render(width: number): string[] {
		// 其他界面抢走焦点（提问、权限确认等对话框）：让位给它。
		if (this.options.focused(this)) this.hadFocus = true;
		else if (this.hadFocus) queueMicrotask(() => this.close());

		// 底部两行：空一行隔开正文，下面是提示。
		const rows = Math.max(3, this.options.rows());
		this.bodyHeight = rows - 2;
		const lines: string[] = [];
		const promptRows: number[] = [];
		withTranscriptScope(() => {
			for (const item of this.options.items()) {
				if (item.prompt) promptRows.push(lines.length);
				for (const line of item.view.render(width)) lines.push(stripToolFrameMarkers(line));
			}
		});
		this.totalLines = lines.length;
		this.promptRows = promptRows;
		if (this.followEnd) this.scrollTop = this.maxScroll();
		else this.scrollTop = Math.min(this.scrollTop, this.maxScroll());
		// 按键、滚轮、跟随新内容都会改滚动位置，统一在画出时结算一次。
		if (this.renderedScrollTop !== undefined && this.renderedScrollTop !== this.scrollTop) {
			this.options.scrolled?.(this.scrollTop - this.renderedScrollTop, this.bodyHeight);
		}
		this.renderedScrollTop = this.scrollTop;

		const body = lines.slice(this.scrollTop, this.scrollTop + this.bodyHeight);
		while (body.length < this.bodyHeight) body.push("");
		return [...body, "", this.hintLine(width)];
	}

	private hintLine(width: number): string {
		const theme = this.options.theme;
		const dim = (text: string) => (typeof theme?.fg === "function" ? theme.fg("dim", text) : text);
		const position =
			this.totalLines > this.bodyHeight
				? ` (${Math.min(100, Math.round(((this.scrollTop + this.bodyHeight) / this.totalLines) * 100))}%)`
				: "";
		// 窄屏从右侧截断：位置与退出方式放在最前。
		return truncateToWidth(
			dim(
				`  Showing detailed transcript${position} · esc/q to exit · ${expandShortcutText()} to toggle · j/k scroll`,
			),
			width,
		);
	}

	invalidate(): void {}
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

let ui: TranscriptUi | undefined;
let unsubscribe: (() => void) | undefined;
let open = false;
let closeOpen: (() => void) | undefined;

/** 浏览层是否打开。 */
export function isTranscriptModeActive(): boolean {
	return open;
}

/** Pi 会把展开键交给它处理的组件：默认编辑器与继承 CustomEditor 的编辑器。 */
function editorFocused(tui: any): boolean {
	const handlers = tui?.focusedComponent?.actionHandlers;
	return handlers instanceof Map && handlers.has(EXPAND_ACTION);
}

function canOpen(tui: any): boolean {
	return (
		config.mode !== "off" &&
		fullscreenLazyTui(tui) &&
		tui.hasOverlay?.() !== true &&
		editorFocused(tui)
	);
}

function openTranscript(): void {
	if (!ui || open) return;
	open = true;
	void ui
		.custom<void>(
			(tui: any, theme: any, _keybindings: unknown, done: () => void) => {
				closeOpen = done;
				return new TranscriptView({
					rows: () => Number(tui?.terminal?.rows) || 24,
					items: () => collectTranscriptItems(findChatContainer(getToolMouseTui() ?? tui)),
					theme,
					close: done,
					focused: (view) => tui?.focusedComponent === view,
					scrolled: (delta, bodyHeight) => followScreenSelection(tui, delta, bodyHeight),
				});
			},
			{
				overlay: true,
				overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
			},
		)
		.finally(() => {
			open = false;
			closeOpen = undefined;
		});
}

function handleInput(data: string): { consume?: boolean } | undefined {
	if (open) return undefined;
	if (!getKeybindings().matches(data, EXPAND_ACTION as any)) return undefined;
	if (!canOpen(getToolMouseTui())) return undefined;
	if (!isKeyRelease(data)) openTranscript();
	return { consume: true };
}

/** 装上展开键拦截；重复安装先拆旧的。 */
export function installTranscriptMode(ctx: any): void {
	teardownTranscriptMode();
	if (ctx?.mode !== "tui" || !ctx?.hasUI) return;
	const candidate = ctx.ui as TranscriptUi | undefined;
	if (typeof candidate?.onTerminalInput !== "function" || typeof candidate.custom !== "function")
		return;
	ui = candidate;
	unsubscribe = candidate.onTerminalInput(handleInput);
}

export function teardownTranscriptMode(): void {
	closeOpen?.();
	unsubscribe?.();
	unsubscribe = undefined;
	ui = undefined;
}
