/**
 * ccstyle 补丁所有权与跨模块协调键的单一来源（single source of truth）。
 *
 * 全部使用 Symbol.for（全局注册表）：/reload 后新模块实例拿到的是同一个 symbol，
 * 这是跨 reload 识别/让渡补丁所有权的关键。切勿把这些 Symbol.for 改成模块局部 Symbol。
 *
 * 两类用途：
 * 1. globalThis 槽位：安装补丁时写 host[KEY] = patch，dispose 时按所有权判断还原。
 * 2. 实例/函数标记：把补丁包装器或组件实例标记在某个 symbol 属性上，供跨模块识别。
 *
 * PatchRegistry 把第 1 类的读写收口为带所有权语义的 install/dispose 生命周期；
 * 底层仍是 globalThis[symbol]，因此外部（含测试）直接读 globalThis 槽不受影响。
 */

// ── compact / compact-thinking 协调 ──
export const COMPACT_MODE_PATCH_KEY = Symbol.for("pi.ccstyle.compact-mode-patch");
export const COMPACT_THINKING_PATCH_KEY = Symbol.for("pi.ccstyle.compact-thinking-update");
export const PROTOTYPE_ORIGINAL_KEY = Symbol.for("pi.ccstyle.prototype-original");
export const COMPACT_THINKING_OWNER = Symbol.for("pi.ccstyle.compact-thinking-owner");

// ── assistant 展开状态（实例标记） ──
export const ASSISTANT_SET_EXPANDED_KEY = Symbol.for("pi.ccstyle.compact-assistant-set-expanded");
export const ASSISTANT_TOGGLE_ROUND_KEY = Symbol.for("pi.ccstyle.compact-assistant-toggle-round");
export const ASSISTANT_REENTRY_KEY = Symbol.for("pi.ccstyle.compact-assistant-reentry");

// ── 工具渲染补丁 ──
export const GLOBAL_TOOL_RENDER_PATCH = Symbol.for("pi.ccstyle.global-tool-render-patch");
export const COMPONENT_TOOL_RENDER_MODE = Symbol.for("pi.ccstyle.component-tool-render-mode");
export const TOOL_EXPANDED_BACKGROUND_PATCH = Symbol.for(
	"pi.ccstyle.tool-expanded-background-patch",
);
// write 归属：注册期确认一次，渲染期据此决定是否提供 rich diff。
export const WRITE_OWNERSHIP_SLOT = Symbol.for("pi.ccstyle.write-ownership");

// ── 消息组件补丁 ──
export const MESSAGE_DISPLAY_PATCH = Symbol.for("pi.ccstyle.message-display-patch");

// ── 工具分组 ──
export const TOOL_GROUPING_PATCH_KEY = Symbol.for("pi.ccstyle.tool-grouping-patch");
export const TOOL_GROUPING_PARENT_KEY = Symbol.for("pi.ccstyle.tool-grouping-parent");
export const TOOL_GROUPING_GENERATION_KEY = Symbol.for("pi.ccstyle.tool-grouping-generation");

// ── regular 主屏渲染补丁 ──
export const MAIN_SCREEN_DO_RENDER_PATCH = Symbol.for("pi.ccstyle.main-screen-do-render-patch");

// ── 鼠标交互 ──
export const TOOL_MOUSE_OWNER_KEY = Symbol.for("pi.ccstyle.tool-mouse-owner");
export const TOOL_MOUSE_TUI_SLOT = Symbol.for("pi.ccstyle.tool-mouse-tui");
export const SCROLL_BUTTON_STATE_SLOT = Symbol.for("pi.ccstyle.scroll-button-state");
export const OFFICIAL_SCROLL_TO_END_KEY = Symbol.for("pi.ccstyle.official-scroll-to-end");
export const FULLSCREEN_SELECTION_COPY_PATCH = Symbol.for(
	"pi.ccstyle.fullscreen-selection-copy-patch",
);
export const FLUSH_DOCKED_BASH_PATCH = Symbol.for("pi.ccstyle.flush-docked-bash-patch");
export const TOOL_HOVER_STATE_KEY = Symbol.for("pi.ccstyle.tool-hover-state");

// ── rich diff 组件标记 ──
export const RICH_DIFF_COMPONENT = Symbol.for("pi.ccstyle.rich-diff-component");

// ── PatchRegistry：所有权生命周期统一收口 ──

/**
 * host 上的补丁槽位读写器。把散落各处的
 * `host[KEY] = patch` / `if (host[KEY] === patch) delete host[KEY]` 收口为
 * 带所有权语义的 install/dispose 生命周期：
 *
 * - install：覆盖写入并返回被替换的旧值（不自动让旧值失效——部分安装器
 *   需要先读旧补丁以链接下游方法，由调用方决定如何 inactivate）。
 * - dispose：所有权守卫删除——仅当槽位仍 === 该值才删除，防止 /reload 后
 *   旧模块误删新模块的补丁。
 * - owns：判断槽位是否仍由某值持有（恒等比较）。
 * - ensure：惰性状态槽（??= 语义），用于无所有权的跨模块共享状态。
 */
export class PatchRegistry {
	readonly host: Record<PropertyKey, unknown>;

	constructor(
		host: Record<PropertyKey, unknown> = globalThis as unknown as Record<PropertyKey, unknown>,
	) {
		this.host = host;
	}

	/** 读取槽位当前值。 */
	get<T = unknown>(key: symbol): T | undefined {
		return this.host[key] as T | undefined;
	}

	/** 是否仍由 value 持有（恒等比较）。 */
	owns(key: symbol, value: unknown): boolean {
		return this.host[key] === value;
	}

	/** 覆盖写入并返回被替换的旧值；不自动让旧值失效。 */
	install<T = unknown>(key: symbol, value: T): T | undefined {
		const previous = this.host[key] as T | undefined;
		this.host[key] = value;
		return previous;
	}

	/** 所有权守卫删除：仅当槽位仍 === value 时删除。返回是否删除。 */
	dispose(key: symbol, value: unknown): boolean {
		if (!this.owns(key, value)) return false;
		delete this.host[key];
		return true;
	}

	/** 惰性槽位：无值（null/undefined）时用 init() 初始化并缓存。 */
	ensure<T>(key: symbol, init: () => T): T {
		const current = this.host[key];
		if (current !== null && current !== undefined) return current as T;
		const value = init();
		this.host[key] = value;
		return value;
	}

	/** 无条件删除槽位（不判断所有权）。返回是否实际删除了键。 */
	delete(key: symbol): boolean {
		if (!(key in this.host)) return false;
		delete this.host[key];
		return true;
	}
}

/** 全局单例：host 固定为 globalThis，跨 /reload 与 jiti 重载稳定。 */
export const patchRegistry = new PatchRegistry();
