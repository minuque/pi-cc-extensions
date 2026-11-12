/**
 * 输入框 `❯` 提示符（issue #68）。
 *
 * `PromptEditor` 继承 `CustomEditor`：pi 的 setCustomEditorComponent 会自动接线
 * onSubmit/onChange/actionHandlers/autocomplete/工作状态指示器，本扩展只管渲染。
 *
 * `❯ ` 恒占左侧 2 列：渲染前把 paddingX 抬到「用户值 + 2」（直接改字段绕过
 * setter，避免每帧 requestRender 自激），渲染后恢复。首内容行前两列换成
 * `❯ `，其后仍保留用户 editorPaddingX 的空格。
 * `❯` 颜色直接用 `borderColor`，随 thinking 等级 / bash mode 自动联动。
 *
 * `userPaddingX` 记录渲染时读到的用户 editorPaddingX（pi 通过 setPaddingX
 * 同步进本编辑器），footer 用 `inputTextIndent()` 对齐输入文本起始列：
 * 前缀开 = userPaddingX + 2，关 = userPaddingX。
 */
import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { config } from "../../config/config.ts";
import { setInjectedKeybindings } from "../../utils/keybindings.ts";

/** `❯ ` 固定 2 列：glyph + 尾随空格。 */
const PROMPT_GLYPH = "❯";
const PROMPT_COLS = 2;

/** 最近一次 render 读到的用户 editorPaddingX；未启用过提示符时为 0。 */
let userPaddingX = 0;

/** 输入文本起始列：footer 按它对齐。 */
export function inputTextIndent(): number {
	return config.enableEditorPrefix ? userPaddingX + PROMPT_COLS : userPaddingX;
}

export class PromptEditor extends CustomEditor {
	render(width: number): string[] {
		// ❯ + 用户 padding：文本从 userPaddingX+2 列开始。
		const self = this as unknown as { paddingX: number };
		const saved = self.paddingX;
		userPaddingX = saved;
		self.paddingX = saved + PROMPT_COLS;
		try {
			const lines = super.render(width);
			// 布局：lines[0] 顶边框，lines[1..n-2] 内容，lines[n-1] 底边框（autocomplete 在底边框后追加，
			// 首内容行恒为 index 1）。开头是 paddingX 个纯空格，前两列换成 ❯+空格，剩余 padding 保留；
			// 续行不动——Claude Code 行为。
			if (lines.length > 2 && lines[1].startsWith("  ")) {
				lines[1] = this.borderColor(PROMPT_GLYPH) + " " + lines[1].slice(2);
			}
			return lines;
		} finally {
			self.paddingX = saved;
		}
	}
}

type EditorFactory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];

const promptEditorFactory: EditorFactory = (tui, theme, keybindings) => {
	// pi 把用户的 KeybindingsManager 注进来，顺带作为全扩展的按键提示取源。
	setInjectedKeybindings(keybindings);
	return new PromptEditor(tui, theme, keybindings, { embedWorkingStatus: true });
};

/** 是否正占着插槽；占据前的工厂用于原样还回去。 */
let active = false;
let previousEditorFactory: EditorFactory | undefined;

/**
 * 撤销本扩展占据的插槽；从未占用就不碰插槽。
 *
 * 插槽可能已经被其他扩展包在外层（pi-inline-skills 会把当前工厂再包一层），
 * 那种结构里无法只拆内层，直接还回占据前的工厂；外层扩展会在下次终端输入时
 * 自己重新包装，前缀不会因此复活。
 *
 * 例外：插槽被 pi 重置回占据前的工厂时（/new、/reload 走 resetExtensionUI），
 * 我们已经不在槽里，再写一次会把 pi 刚重置的结果又覆盖掉；此时只清状态。
 * 用户主动改设置时传 force：pi 1.5 会把对话框开着时的替换排队到关闭后落地，
 * 期间 getEditorComponent() 仍是旧工厂，无法据此判断要不要还回去。
 */
function releasePromptEditor(ctx: ExtensionContext, force = false): void {
	if (!active) return;
	const previous = previousEditorFactory;
	active = false;
	previousEditorFactory = undefined;
	if (!force && ctx.ui.getEditorComponent?.() === previous) return;
	ctx.ui.setEditorComponent(previous);
}

/**
 * 应用输入框前缀；enableEditorPrefix=false 时只撤自己装的那层。
 *
 * 面板开着时也能直接替换：pi 1.5.0 起 setEditorComponent 不会再把现有对话框踢出渲染树，
 * 新编辑器等对话框关闭后才出现（issue #11431）；早于该版本时 `ctx.ui.custom()` 的 Promise
 * 会永不落定，只能在面板关闭后再调用。
 *
 * 插槽已经装着本扩展的编辑器时直接返回：重复安装只会重建实例，丢掉撤销栈、
 * 历史等编辑器状态，还会打断其他扩展包在外层的编辑器。
 */
export function applyPromptEditor(ctx: ExtensionContext, options?: { force?: boolean }): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setEditorComponent !== "function") return;
	if (!config.enableEditorPrefix) {
		releasePromptEditor(ctx, options?.force);
		return;
	}
	const current = ctx.ui.getEditorComponent?.();
	if (current === promptEditorFactory) return;
	try {
		// pi 的插槽是硬替换、没有栈，先记住是谁占着，撤销时还回去。
		previousEditorFactory = current;
		active = true;
		ctx.ui.setEditorComponent(promptEditorFactory);
	} catch (err) {
		ctx.ui.notify(
			`prompt editor error: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

/** 恢复本扩展占据前的编辑器；未占用时不动作。 */
export function clearPromptEditor(ctx: ExtensionContext, options?: { force?: boolean }): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setEditorComponent !== "function") return;
	releasePromptEditor(ctx, options?.force);
}
