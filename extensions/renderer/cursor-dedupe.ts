/**
 * 光标序列去重：Windows Terminal 每收到一次 \x1b[?25h / \x1b[?25l 都会重置
 * 光标闪烁相位，而 pi-tui 主屏每次渲染（positionHardwareCursor）都会把这两条
 * 序列重写一遍。流式期间工具卡动画又把渲染频率抬到 12.5 次/秒，编辑区的硬件
 * 光标就会一闪一闪。这里只做一件事：状态没变就不再写。
 *
 * 两个前提保证状态不会记错：
 * 1. 只装在 regular（主屏）TUI 上——主屏只通过 terminal.showCursor/hideCursor
 *    写这两条序列。
 * 2. 同时扫 terminal.write：fullscreen 的 alt-screen 会把 \x1b[?25h/l 直接写进
 *    渲染缓冲，运行时切换模式时靠这一步把状态同步回来，避免之后把该写的
 *    show/hide 误判成重复。
 *
 * terminal 不随 renderer 切换而重建（pi 切模式时把同一个 terminal 交给新实例），
 * 所以包装只装一次、状态跨模式连续。
 */

type CursorTerminal = {
	showCursor?: () => void;
	hideCursor?: () => void;
	write?: (data: string) => void;
};

export const CURSOR_DEDUPE_KEY = Symbol("ccstyle.cursor-dedupe");

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

export function installCursorWriteDedupe(tui: any): void {
	const terminal: CursorTerminal | undefined = tui?.terminal;
	if (!terminal) return;
	if (typeof terminal.showCursor !== "function" || typeof terminal.hideCursor !== "function") {
		return;
	}
	const marked = terminal as CursorTerminal & { [CURSOR_DEDUPE_KEY]?: unknown };
	if (marked[CURSOR_DEDUPE_KEY]) return;
	const original = { show: terminal.showCursor, hide: terminal.hideCursor, write: terminal.write };
	let visible: boolean | undefined;
	terminal.showCursor = function (this: unknown) {
		if (visible === true) return;
		visible = true;
		Reflect.apply(original.show, this, []);
	};
	terminal.hideCursor = function (this: unknown) {
		if (visible === false) return;
		visible = false;
		Reflect.apply(original.hide, this, []);
	};
	if (typeof original.write === "function") {
		terminal.write = function (this: unknown, data: string) {
			const next = cursorStateAfterWrite(data, visible);
			if (next !== visible) visible = next;
			return Reflect.apply(original.write as (...args: unknown[]) => unknown, this, [data]);
		};
	}
	Object.defineProperty(terminal, CURSOR_DEDUPE_KEY, { value: { original }, configurable: true });
}

/** 取一段写出内容里最后一次出现的光标显示/隐藏序列，没有则维持原状态。 */
function cursorStateAfterWrite(data: unknown, current: boolean | undefined): boolean | undefined {
	if (typeof data !== "string" || !data.includes("?25")) return current;
	const lastShow = data.lastIndexOf(SHOW_CURSOR);
	const lastHide = data.lastIndexOf(HIDE_CURSOR);
	if (lastShow < 0 && lastHide < 0) return current;
	return lastShow > lastHide;
}
