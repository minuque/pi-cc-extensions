/**
 * 按键提示与按键匹配的统一取源。
 *
 * pi 1.5.0 起把 `keyText()` / `keyHint()` 放进渲染上下文，把 KeybindingsManager 注入
 * `ctx.ui.custom()` 和编辑器工厂（docs/extensions.md「Keybinding Hints」）。扩展自己
 * import 的那份副本可能看不到用户的 `keybindings.json`，所以这里优先用注入值；
 * 没有注入点的位置（例如原型补丁里的思考块提示）再退回 `getKeybindings()`。
 */
import { getKeybindings } from "@earendil-works/pi-tui";

export type KeybindingsLike = {
	getKeys(id: string): string[];
	matches(data: string, id: string): boolean;
};

type KeyTextSource = (id: string) => string;

let injectedManager: KeybindingsLike | undefined;
let injectedKeyText: KeyTextSource | undefined;

function isManager(value: unknown): value is KeybindingsLike {
	const candidate = value as KeybindingsLike | undefined;
	return (
		Boolean(candidate) &&
		typeof candidate?.getKeys === "function" &&
		typeof candidate?.matches === "function"
	);
}

/** 记下 pi 注入的 KeybindingsManager；值不匹配就忽略。 */
export function setInjectedKeybindings(value: unknown): void {
	if (isManager(value)) injectedManager = value;
}

/** 记下渲染上下文里的 `context.keyText`；值不匹配就忽略。 */
export function setInjectedKeyText(value: unknown): void {
	if (typeof value === "function") injectedKeyText = value as KeyTextSource;
}

/** 当前的按键管理器：注入值优先，没有时回退到本进程解析到的 pi。 */
export function keybindings(): KeybindingsLike {
	return injectedManager ?? getKeybindings();
}

function formatKeyPart(part: string, capitalize = false): string {
	// 与 pi 内置 keybinding-hints 一致：macOS 上 alt 显示为 option
	const display = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	return capitalize ? display.charAt(0).toUpperCase() + display.slice(1) : display;
}

/** 把字面按键串（如 `"ctrl+o"`）格式化成显示文本。 */
export function formatKeyText(key: string, options?: { capitalize?: boolean }): string {
	const capitalize = options?.capitalize === true;
	return key
		.split("/")
		.map((part) =>
			part
				.split("+")
				.map((piece) => formatKeyPart(piece, capitalize))
				.join("+"),
		)
		.join("/");
}

/** 按键显示文本：pi 注入的 keyText 说了算（包括 id 没绑键时的空串）；没有注入时本地格式化。 */
export function keyText(id: string): string {
	if (injectedKeyText) return injectedKeyText(id);
	const keys = keybindings().getKeys(id);
	return keys.length === 0 ? "" : formatKeyText(keys.join("/"));
}

/** 与 pi 的 keyDisplayText 同形：首字母大写，用于 fullscreen 浮层按钮这类原生样式。 */
export function keyDisplayText(id: string): string {
	return formatKeyText(keyText(id), { capitalize: true });
}
