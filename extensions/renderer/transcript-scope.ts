/**
 * 会话记录浏览层的组件标记。
 *
 * 浏览层照着对话区现有组件新建一份来画。这些副本要绕开对话区的渲染规则：
 * compact 的整轮折叠与组件跟踪、compact-thinking 的思考跟踪、展开后的行数上限。
 *
 * 副本的构造与渲染都包在 withTranscriptScope 里；构造完成后再用
 * markTranscriptComponent 打上实例标记，覆盖动画定时器等在作用域外触发的重绘。
 */

const TRANSCRIPT_STATE_KEY = "ccstyleTranscript";
const marked = new WeakSet<object>();
let depth = 0;

/** 在浏览层作用域里执行：期间构造或渲染的组件都按浏览副本处理。 */
export function withTranscriptScope<T>(run: () => T): T {
	depth++;
	try {
		return run();
	} finally {
		depth--;
	}
}

/** 给浏览副本打实例标记；渲染状态里也记一份，供只拿得到 context 的渲染器判断。 */
export function markTranscriptComponent(component: any): void {
	if (!component || typeof component !== "object") return;
	marked.add(component);
	const state = component.rendererState;
	if (state && typeof state === "object") state[TRANSCRIPT_STATE_KEY] = true;
}

/** 组件是否为浏览副本（或正处于浏览层作用域）。 */
export function isTranscriptComponent(component: unknown): boolean {
	return (
		depth > 0 || (typeof component === "object" && component !== null && marked.has(component))
	);
}

/** 展开内容的行数上限：浏览副本不限行数，其余沿用配置。 */
export function expandedLineLimit(limit: number, context?: any): number {
	if (depth > 0 || context?.state?.[TRANSCRIPT_STATE_KEY] === true) return Number.MAX_SAFE_INTEGER;
	return limit;
}
