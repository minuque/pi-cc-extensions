/**
 * show-more 提示文本：fullscreen 下鼠标 hover/click 可用，提示 "click to show more"；
 * 其他模式（regular 保留终端原生 scrollback、不启用鼠标上报）提示默认展开快捷键。
 *
 * tui 模式由 mouse-interaction 在 renderer 回调中维护；未安装时按 fullscreen 处理，
 * 保证纯渲染测试与既有行为不变。
 */
import { getKeybindings } from "@earendil-works/pi-tui";

let toolTuiFullscreen: boolean | undefined;

export function setToolTuiFullscreen(value: boolean): void {
	toolTuiFullscreen = value;
}

export function isToolTuiFullscreen(): boolean {
	return toolTuiFullscreen !== false;
}

function formatKeyPart(part: string): string {
	// 与 pi 内置 keybinding-hints 一致：macOS 上 alt 显示为 option
	return process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
}

/** 默认展开快捷键（app.tools.expand）显示文本；未配置时回退 ctrl+o。 */
export function expandShortcutText(): string {
	const keys = getKeybindings().getKeys("app.tools.expand");
	if (keys.length === 0) return "ctrl+o";
	return keys
		.join("/")
		.split("/")
		.map((part) => part.split("+").map(formatKeyPart).join("+"))
		.join("/");
}

export function showMoreHintText(): string {
	return isToolTuiFullscreen() ? "click to show more" : `${expandShortcutText()} to show more`;
}

/** 展开卡的收起提示，与折叠态 showMoreHintText 同一位置对称。 */
export function collapseHintText(): string {
	return isToolTuiFullscreen() ? "↑ Collapse" : `${expandShortcutText()} to collapse`;
}

/** 该行是否带展开态收起提示（用于展开卡的 hint hover 命中）。 */
export function isCollapseHintLine(plainLine: string): boolean {
	return plainLine.includes(collapseHintText());
}
