/**
 * 光标序列去重：Windows Terminal 每收到一次 \x1b[?25h / \x1b[?25l 都会重置
 * 光标闪烁相位，而 pi-tui 主屏每次渲染（positionHardwareCursor）都会把这两条
 * 序列重写一遍。流式期间工具卡动画又把渲染频率抬到 12.5 次/秒，编辑区的硬件
 * 光标就会一闪一闪。这里只做一件事：状态没变就不再写。
 *
 * 只装在 regular（主屏）TUI 上：主屏只有 terminal.showCursor/hideCursor 会在
 * 这两条序列，状态跟踪不会失效；fullscreen 的 alt-screen 直接在渲染缓冲里写
 * 原始转义，绕过这两个方法，装了反而可能把状态记错。
 */

type CursorTerminal = {
	showCursor?: () => void;
	hideCursor?: () => void;
};

export const CURSOR_DEDUPE_KEY = Symbol("ccstyle.cursor-dedupe");

export function installCursorWriteDedupe(tui: any): void {
	const terminal: CursorTerminal | undefined = tui?.terminal;
	if (!terminal) return;
	if (typeof terminal.showCursor !== "function" || typeof terminal.hideCursor !== "function") {
		return;
	}
	const marked = terminal as CursorTerminal & { [CURSOR_DEDUPE_KEY]?: unknown };
	if (marked[CURSOR_DEDUPE_KEY]) return;
	const original = { show: terminal.showCursor, hide: terminal.hideCursor };
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
	Object.defineProperty(terminal, CURSOR_DEDUPE_KEY, { value: { original }, configurable: true });
}
