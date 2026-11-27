/**
 * 输入框 `❯` 提示符（issue #68）。
 *
 * `PromptEditor` 继承 `CustomEditor`：pi 的 setCustomEditorComponent 会自动接线
 * onSubmit/onChange/actionHandlers/autocomplete/工作状态指示器，本扩展只补充前缀布局。
 *
 * `❯ ` 占左侧 2 列：渲染和鼠标定位都把 paddingX 临时抬到「用户值 + 2」。
 * 首内容行前两列换成 `❯ `，其后仍保留用户 editorPaddingX 的空格。
 * `❯` 颜色直接用 `borderColor`，随 thinking 等级 / bash mode 自动联动。
 *
 * `userPaddingX` 记录渲染时读到的用户 editorPaddingX（pi 通过 setPaddingX
 * 同步进本编辑器），footer 用 `inputTextIndent()` 对齐输入文本起始列：
 * 前缀开 = userPaddingX + 2，关 = userPaddingX。
 */
import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
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
	private withPromptPadding<T>(run: () => T): T {
		// Pi 的 setter 会触发重绘。临时改字段，让基类自行处理窄窗口和补全菜单的几何。
		const self = this as unknown as { paddingX: number };
		const saved = self.paddingX;
		self.paddingX = saved + PROMPT_COLS;
		try {
			return run();
		} finally {
			self.paddingX = saved;
		}
	}

	render(width: number): string[] {
		userPaddingX = this.getPaddingX();
		const lines = this.withPromptPadding(() => super.render(width));
		// 首内容行之前是顶边框。只替换前两格，保留续行和补全菜单的缩进。
		if (lines.length > 2 && lines[1].startsWith("  ")) {
			return [
				lines[0],
				`${this.borderColor(PROMPT_GLYPH)} ${lines[1].slice(PROMPT_COLS)}`,
				...lines.slice(2),
			];
		}
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.withPromptPadding(() => super.handleMouse(event));
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
 * 例外：插槽已被 pi 重置时（/new、/reload 走 resetExtensionUI，它把插槽置成 undefined），
 * 我们已经不在槽里，再写一次会把 pi 刚重置的结果又覆盖掉；此时只清状态。
 * 用户主动改设置时传 force：pi 1.5 会把对话框开着时的替换排队到关闭后落地，
 * 期间 getEditorComponent() 仍是旧工厂，无法据此判断要不要还回去。
 */
function releasePromptEditor(ctx: ExtensionContext, force = false): void {
	if (!active) return;
	const previous = previousEditorFactory;
	const current = ctx.ui.getEditorComponent?.();
	active = false;
	previousEditorFactory = undefined;
	if (!force && current === undefined) return;
	if (!force && current === previous) return;
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
