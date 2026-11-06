/**
 * ccstyle 工具卡本体：call/result 渲染，不碰原型补丁。
 * default 用它接管 ToolExecutionComponent；compact 展开面板复用同一份 render。
 */
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { config, getToolDisplayConfig, type CompactStyleMode } from "../../config/config.ts";
import { isToolCallHovered } from "../mouse/hover.ts";
import {
	ASK_USER_QUESTION_TOOL_NAME,
	askUserExpandedBody,
	askUserQuestionCount,
	createAskUserResultComponent,
} from "./ask-user-question.ts";
import {
	CODEMODE_TOOL_NAME,
	codemodeExpandedBody,
	createCodemodeResultComponent,
} from "./codemode.ts";
import { countWriteDiffStats, writeStatsInCollapsedBody } from "./diff/diff-renderer.ts";
import { renderRichToolResult, type WriteExecutionMetadataStore } from "./diff/index.ts";
import { mcpToolTitle } from "./mcp-title.ts";
import {
	humanizeToolLabel,
	renderToolSummary,
	SHELL_TOOL_NAMES,
	toolCallSummary,
} from "./names.ts";
import {
	collapsedResultSummary,
	expandedBodyComponent,
	formatToolDuration,
	insetComponent,
	renderCollapsedToolResult,
	renderCollapsedToolResultToWidth,
	textFromResult,
	toolViewportWidth,
} from "./result.ts";
import { hasExpandableDetail, isExpandedToolIoView, renderExpandedToolResult } from "./tool-io.ts";
import {
	isLiveToolCall,
	isToolExpanded,
	pendingIcon,
	resolveToolVisualState,
	scheduleAnimation,
	settledIcon,
	setToolVisualState,
	toolIconColor,
} from "./tool-state.ts";
import { showMoreHintText } from "./names.ts";
import { oneLine } from "../../utils/format.ts";
import {
	isFailedSubagentStatus,
	measuredStats,
	agentStatusLabel,
} from "./subagent-notification.ts";

/** 成功勾：亮绿 truecolor（与 message-display 一致）。 */
const BRIGHT_GREEN = "[38;2;80;220;100m";
const ANSI_FG_RESET = "[39m";

/** `(+A -D)`：plain 用于占宽，styled 用于上屏。default 写标题与 compact edit/write 标题共用。 */
export function styleChangeCounts(
	fg: (color: string, text: string) => string,
	added: number,
	removed: number,
): { text: string; styled: string } {
	return {
		text: ` (+${added} -${removed})`,
		styled: ` ${fg("dim", "(")}${fg("success", `+${added}`)} ${fg("error", `-${removed}`)}${fg("dim", ")")}`,
	};
}

/** rich diff 的两个入口（本处与 compact 的 paintCompactEditWrite）都靠 renderRichToolResult
 * 返回 undefined 让位，这里只判断模式与工具名，避免多一个可能与让位不一致的 gate。 */
export function shouldRenderRichDiff(
	mode: CompactStyleMode,
	toolName: string,
	isError: boolean,
): boolean {
	return mode === "on" && !isError && (toolName === "edit" || toolName === "write");
}

function renderDefault(tool: any, slot: "renderCall" | "renderResult", args: any[], fallback = "") {
	try {
		if (typeof tool?.[slot] === "function") return tool[slot](...args);
	} catch {
		// Fall through to raw fallback.
	}
	return new Text(fallback, 0, 0);
}

export const AGENT_TOOL_NAME = "Agent";

type ParsedTask = { id: string; status: string; subject: string };

function parseTaskList(text: string): ParsedTask[] {
	return text
		.split("\n")
		.map((line) => line.match(/^#(\d+) \[([^\]]+)] (.+)$/))
		.filter((match): match is RegExpMatchArray => Boolean(match))
		.map((match) => ({ id: match[1]!, status: match[2]!, subject: match[3]! }));
}

function taskListSummary(tasks: ParsedTask[]): string {
	const counts = { pending: 0, in_progress: 0, completed: 0 };
	for (const task of tasks) {
		if (task.status in counts) counts[task.status as keyof typeof counts]++;
	}
	return [
		`${tasks.length} tasks`,
		counts.in_progress ? `${counts.in_progress} in progress` : "",
		counts.pending ? `${counts.pending} pending` : "",
		counts.completed ? `${counts.completed} completed` : "",
	]
		.filter(Boolean)
		.join(" · ");
}

function renderExpandedTaskResult(
	toolName: string,
	text: string,
	theme: any,
	isError: boolean,
): any | undefined {
	if (isError) return undefined;
	if (toolName === "TaskList") {
		const tasks = parseTaskList(text);
		if (!tasks.length) return undefined;
		const limit = Math.max(1, config.expandedPreviewMaxLines);
		const rows = tasks.slice(0, limit).map((task) => {
			const color =
				task.status === "completed"
					? "success"
					: task.status === "in_progress"
						? "warning"
						: "muted";
			return `${theme.fg("accent", `#${task.id}`)} ${theme.fg(color, task.status)} ${theme.fg("dim", task.subject)}`;
		});
		if (tasks.length > rows.length)
			rows.push(theme.fg("muted", `… ${tasks.length - rows.length} more tasks`));
		// 贴左：外层展开卡片 Box(1,1) 提供 1 格 padding
		return new Text(
			`↳ ${theme.fg("muted", taskListSummary(tasks))}\n${rows.map((r) => `  ${r}`).join("\n")}`,
			0,
			0,
		);
	}
	const line = text.trim();
	if (!line || line.includes("\n")) return undefined;
	let formatted: string | undefined;
	let match: RegExpMatchArray | null;
	if (
		toolName === "TaskCreate" &&
		(match = line.match(/^Task #(\d+) created successfully: (.+)$/))
	) {
		formatted = `${theme.fg("success", "Created task")} ${theme.fg("accent", `#${match[1]}`)} ${theme.fg("muted", match[2])}`;
	} else if (toolName === "TaskUpdate" && (match = line.match(/^Updated task #(\d+) (.+)$/))) {
		formatted = `${theme.fg("success", "Updated task")} ${theme.fg("accent", `#${match[1]}`)} ${theme.fg("muted", match[2])}`;
	} else if (toolName === "TaskExecute") {
		formatted = `${theme.fg("success", "Started")} ${theme.fg("muted", line)}`;
	} else if (toolName === "TaskStop") {
		formatted = `${theme.fg("success", "Stopped")} ${theme.fg("muted", line)}`;
	}
	return formatted ? new Text(`↳ ${formatted}`, 0, 0) : undefined;
}

/**
 * 工具耗时（毫秒）。结束时优先用 pi 记在结果上的 durationMs（单调，restore 出来的行也带得到）；
 * 运行中 pi 不给（partial 期间渲染上下文里恒为 undefined），退回 renderCall 记下的时钟。
 * 拿不到返回 undefined。时钟回拨时钳到 0。
 */
function toolElapsedMs(context: any, isPartial: boolean): number | undefined {
	const recorded = context?.durationMs;
	if (!isPartial && typeof recorded === "number" && Number.isFinite(recorded) && recorded >= 0) {
		return recorded;
	}
	const startedAt = context?.state?.ccstyleShellStartedAt;
	if (typeof startedAt !== "number") return undefined;
	const endedAt = context?.state?.ccstyleShellEndedAt;
	const end = typeof endedAt === "number" ? endedAt : Date.now();
	return Math.max(0, end - startedAt);
}

/**
 * shell 的耗时文本。Pi 原生 shell 渲染器会在结果底部报一行，ccstyle 的通用折叠行把它盖掉了。
 *
 * 两条路都要：新 Pi 在渲染上下文里给 `durationMs`（单调，restore 出来的行也带得到），优先用它；
 * 拿不到（旧 Pi、无耗时的结果）再退回自己的时钟——开始时间在 renderCall 记，结束时间在结果定型时定一次。
 * 运行中的实时计时也只能走时钟。
 */
function shellDurationText(toolName: string, context: any, isPartial: boolean): string {
	if (!SHELL_TOOL_NAMES.has(toolName)) return "";
	const elapsed = toolElapsedMs(context, isPartial);
	return elapsed === undefined ? "" : formatToolDuration(elapsed);
}

/**
 * 运行中的展开视图：与结束后同一份 Input / Output。
 * 还没输出时用 Pending… 占位：空正文会被视图画成 Done，像已经跑完了。
 * 纯空白（空格、换行、tab）同样算还没输出；非空正文保留原始缩进，不整体 trim。
 * shell 的已用时间挂到视图尾部；取值函数每帧重算，秒数才跟着动画 tick 走。
 */
function renderRunningExpandedResult(toolName: string, result: any, context: any, theme: any): any {
	const text = textFromResult(result);
	const view = renderExpandedToolResult(
		text.trim() ? text : "Pending…",
		theme,
		false,
		context?.lastComponent,
		context?.args,
		context,
		true,
	);
	if (isExpandedToolIoView(view) && SHELL_TOOL_NAMES.has(toolName)) {
		view.setFooter(() => shellDurationText(toolName, context, true) || undefined);
	}
	return view;
}

/**
 * 运行中的折叠行：`   ↳ Pending… · 12.4s · click to show more`。
 * 提示必须留在行尾：collapsedHintHitbox 只认行尾，没有它这行既点不动也看不出能点。
 * 已用时间在 render() 内取，动画 tick 才能带上新值。
 */
function renderRunningCollapsedResult(options: {
	toolName: string;
	context: any;
	theme: any;
	/** ask_user_question 的结果树用 1 格缩进，与它的 ├/└ 对齐。 */
	prefix?: string;
}): any {
	const { toolName, context, theme, prefix } = options;
	const toolCallId = context?.toolCallId;
	const hintPrefix = theme.fg("dim", " · ");
	const hint = hintPrefix + theme.fg("dim", showMoreHintText());
	const hoveredHint = hintPrefix + theme.fg("text", showMoreHintText());
	let cachedWidth: number | undefined;
	let cachedBody: string | undefined;
	let cachedLine: string | undefined;
	let cachedHoveredLine: string | undefined;
	return {
		render(width: number) {
			const elapsed = shellDurationText(toolName, context, true);
			const body = elapsed ? `Pending… · ${elapsed}` : "Pending…";
			if (cachedLine === undefined || cachedWidth !== width || cachedBody !== body) {
				cachedWidth = width;
				cachedBody = body;
				cachedLine = theme.fg("muted", renderCollapsedToolResultToWidth(body, hint, width, prefix));
				cachedHoveredLine = theme.fg(
					"muted",
					renderCollapsedToolResultToWidth(body, hoveredHint, width, prefix),
				);
			}
			return [isToolCallHovered(toolCallId) ? cachedHoveredLine! : cachedLine];
		},
		invalidate(): void {},
	};
}

/**
 * Agent 的 renderResult：与 pi-subagents 保持同样的分支，但收敛成 ccstyle 的 ↳ 行。
 * running/partial 转交原渲染器（只有它有 spinner frame 和 activity 文案）；
 * background/completed/stopped/error 画单行摘要，展开态结果正文交给通用展开视图。
 */
function renderAgentResult(
	originalTool: any,
	result: any,
	options: any,
	theme: any,
	context: any,
	expanded: boolean,
	isError: boolean,
): any | undefined {
	const details = result?.details;
	const text = textFromResult(result);
	// 没拿到子代理状态（pi-subagents 原始路径的兜底）就沿用通用渲染。
	if (!details?.status) return undefined;

	const isPartial = Boolean(options?.isPartial);
	const status = String(details.status);

	// running：pi-subagents 的 spinner/activity 组件才能实时动，原样转交。
	if (isPartial || status === "running") {
		return renderDefault(originalTool, "renderResult", [result, options, theme, context], text);
	}

	const stats = measuredStats(details).join(" · ");

	const agentId = details.agentId ? `ID: ${details.agentId}` : "";
	const tail = (body: string) => (stats ? `${body} · ${stats}` : body);

	if (status === "background") {
		if (!expanded) {
			const body = tail(`Running in background${agentId ? ` · ${agentId}` : ""}`);
			return new Text(theme.fg("muted", renderCollapsedToolResult(body, "")), 0, 0);
		}
		const view = renderExpandedToolResult(
			`Running in background${agentId ? ` · ${agentId}` : ""}`,
			theme,
			false,
			context?.lastComponent,
			context?.args,
			context,
			true,
		);
		return view;
	}

	if (status === "completed" || status === "steered") {
		if (!expanded) {
			const label = status === "steered" ? "Wrapped up (turn limit)" : "Done";
			const body = [label, stats].filter(Boolean).join(" · ");
			return new Text(theme.fg("muted", renderCollapsedToolResult(body, "")), 0, 0);
		}
		const view = renderExpandedToolResult(
			text || "Done",
			theme,
			Boolean(isError),
			context?.lastComponent,
			context?.args,
			context,
			true,
		);
		return view;
	}

	if (status === "stopped") {
		const body = tail("Stopped");
		return new Text(theme.fg("muted", renderCollapsedToolResult(body, "")), 0, 0);
	}

	// error / aborted：首行错误文案 + 统计，与通用失败行口径一致。
	const label = agentStatusLabel(status);
	const firstLine = text.split("\n").find((line) => line.trim()) ?? label;
	const body = tail(oneLine(firstLine, 72));
	return new Text(
		theme.fg(
			isFailedSubagentStatus(status) ? "error" : "muted",
			renderCollapsedToolResult(body, ""),
		),
		0,
		0,
	);
}

/** 用 ccstyle call/result 包装任意工具定义。 */
export function createCcstyleTool(
	originalTool: any,
	writeExecutionMetadata: WriteExecutionMetadataStore,
	toolName: string,
): any {
	const label = originalTool.label || toolName;
	const defaultTitle = label === toolName ? humanizeToolLabel(label) : label;
	// MCP 工具直接用 adapter 暴露的真实工具名，不做人性化
	const title = mcpToolTitle({ toolName, definition: originalTool }) ?? defaultTitle;

	return {
		...originalTool,
		renderShell: "self",
		renderCall(args: any, theme: any, context: any) {
			if (config.mode === "off") {
				return renderDefault(originalTool, "renderCall", [args, theme, context], String(toolName));
			}

			// shell 的耗时从执行开始算；restore 出来的行没有 executionStarted，不参与。
			if (
				SHELL_TOOL_NAMES.has(toolName) &&
				context?.executionStarted &&
				context.state &&
				context.state.ccstyleShellStartedAt === undefined
			) {
				context.state.ccstyleShellStartedAt = Date.now();
			}

			const visualState = resolveToolVisualState(context);
			const isPending =
				visualState === "pending" ||
				(!visualState && (context?.isPartial || context?.executionStarted));
			// 等待窗口（声明流式中或等待派发）也要转：Pi 要到 assistant 消息结束
			// 才派发执行，这段只靠 executionStarted 会一直冻在第一帧。
			const animating =
				isPending && (Boolean(context?.executionStarted) || isLiveToolCall(context?.toolCallId));
			if (animating) scheduleAnimation(context, { light: true });
			const settledRawIcon = isPending ? "" : settledIcon(toolName, visualState);
			const settledIconStyled =
				visualState === "success"
					? `${BRIGHT_GREEN}${settledRawIcon}${ANSI_FG_RESET}`
					: theme.fg(toolIconColor(context), settledRawIcon);
			// 逐帧 spinner：帧在 render() 内取，动画定时器只需 requestRender，
			// 不再每次 tick 走 updateDisplay 把整张卡重建一遍。
			const pendingIconStyled = () => theme.fg(toolIconColor(context), pendingIcon(toolName));
			const summary = toolCallSummary(toolName, args, {
				title,
				variant: "default",
				cwd: context?.cwd,
			});
			// ask_user_question：问题原文在折叠结果树里逐条列出，标题只留工具名和问题数，
			// 否则第一个问题会在标题和树里各出现一次。
			if (toolName === ASK_USER_QUESTION_TOOL_NAME) {
				// Pi 的渲染上下文不带 result，问题数从这里取。
				const questionCount = askUserQuestionCount(context?.result, args);
				summary.main = title;
				summary.detail = questionCount === undefined ? "" : ` (+${questionCount})`;
				summary.payload = undefined;
			}
			let writeStatsText = "";
			let writeStatsStyled = "";
			// 折叠 0 行预览时计数由正文那行（↳ diff +A -D · created …）显示，标题不重复。
			const statsInBody = writeStatsInCollapsedBody(
				Boolean(context?.expanded),
				getToolDisplayConfig(),
			);
			if (toolName === "write" && visualState === "success" && !statsInBody) {
				const meta = writeExecutionMetadata.get(context?.toolCallId);
				const stats = countWriteDiffStats(
					typeof args?.content === "string" ? args.content : undefined,
					meta?.previousContent,
					meta?.fileExistedBeforeWrite,
				);
				if (stats) {
					const counts = styleChangeCounts(
						(color, text) => theme.fg(color, text),
						stats.added,
						stats.removed,
					);
					writeStatsText = counts.text;
					writeStatsStyled = counts.styled;
				}
			}
			const extraText = writeStatsText || summary.detail;
			const extraStyled = writeStatsStyled || theme.fg("dim", summary.detail);
			let cachedWidth: number | undefined;
			let cachedLine: string | undefined;
			let cachedIcon: string | undefined;
			const expanded = Boolean(context?.expanded);
			return {
				render(width: number) {
					// 轻量 tick 只会 requestRender，靠这里续期，动画才能自维持。
					if (animating) scheduleAnimation(context, { light: true });
					const icon = isPending ? pendingIconStyled() : settledIconStyled;
					if (cachedLine !== undefined && cachedWidth === width && cachedIcon === icon) {
						return [cachedLine];
					}
					const viewportWidth = toolViewportWidth(width);
					// 展开态贴左（外层 Box 已 pad 1）；折叠 self-shell 保留 1 格前导空格
					const lead = expanded ? "" : " ";
					const callWidth = Math.max(
						0,
						viewportWidth - visibleWidth(icon) - 1 - (expanded ? 0 : 1),
					);
					const mainWidth = Math.max(0, callWidth - visibleWidth(extraText));
					cachedWidth = width;
					cachedIcon = icon;
					// 路径按最终可用宽度中间截断，避免整行二次截断隐藏文件名。
					cachedLine = `${lead}${icon} ${renderToolSummary(summary, mainWidth, theme.fg.bind(theme))}${extraStyled}`;
					return [truncateToWidth(cachedLine, viewportWidth, "")];
				},
				invalidate() {
					cachedLine = undefined;
					cachedIcon = undefined;
				},
			};
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (config.mode === "off") {
				return renderDefault(
					originalTool,
					"renderResult",
					[result, options, theme, context],
					textFromResult(result),
				);
			}

			const expanded = isToolExpanded(options, context);
			const isError = Boolean(options?.isError || context?.isError);
			// Agent：running 转交原渲染器（spinner/activity 只有它有）；其余画 ↳ 摘要行。
			// toolName 大小写宽松匹配：上游改名也不静默失效。
			if (toolName.toLowerCase() === AGENT_TOOL_NAME.toLowerCase()) {
				const agentResult = renderAgentResult(
					originalTool,
					result,
					options,
					theme,
					context,
					expanded,
					isError,
				);
				if (agentResult) return agentResult;
			}
			// codemode：折叠态自己画子调用树，展开态给全部子调用与去掉脚本头的输出
			if (toolName === CODEMODE_TOOL_NAME) {
				if (!options?.isPartial) setToolVisualState(context, isError ? "error" : "success");
				if (expanded) {
					return renderExpandedToolResult(
						codemodeExpandedBody(result),
						theme,
						isError,
						context?.lastComponent,
						context?.args,
						context,
						true,
					);
				}
				// 折叠态不再复用展开视图，免得 hover/鼠标命中指向已隐藏的组件
				if (context?.state) context.state.ccstyleIoView = undefined;
				const toolCallId = context?.toolCallId;
				return createCodemodeResultComponent({
					result,
					theme,
					running: Boolean(options?.isPartial),
					isError,
					isHovered: () => isToolCallHovered(toolCallId),
					code: context?.args?.code,
				});
			}
			// ask_user_question：折叠态摊成问答树，展开态按问题逐条列出选择。
			if (toolName === ASK_USER_QUESTION_TOOL_NAME) {
				if (!options?.isPartial) setToolVisualState(context, isError ? "error" : "success");
				if (options?.isPartial) {
					// 等待回答时也能展开看问题原文（Input 即 args.questions）；折叠态 1 格缩进。
					if (expanded) return renderRunningExpandedResult(toolName, result, context, theme);
					// 折叠后清掉展开视图，与通用 partial 折叠一致。
					if (context?.state) context.state.ccstyleIoView = undefined;
					return renderRunningCollapsedResult({ toolName, context, theme, prefix: " ↳ " });
				}
				if (expanded) {
					return renderExpandedToolResult(
						askUserExpandedBody(result),
						theme,
						isError,
						context?.lastComponent,
						context?.args,
						context,
						true,
					);
				}
				if (context?.state) context.state.ccstyleIoView = undefined;
				const toolCallId = context?.toolCallId;
				return createAskUserResultComponent({
					result,
					theme,
					isError,
					isHovered: () => isToolCallHovered(toolCallId),
				});
			}
			if (options?.isPartial) {
				// 运行中也给和结束后同一份 Input / Output：命令全文与已产生的输出。
				if (expanded) return renderRunningExpandedResult(toolName, result, context, theme);
				// 折叠态保持 3 格：与完成后的 `   ↳ …` 同列，工具跑完那行不横跳。
				if (context?.state) context.state.ccstyleIoView = undefined;
				return renderRunningCollapsedResult({ toolName, context, theme });
			}

			// shell：结果定型时定一次结束时间，这一行之后不再变。
			if (
				SHELL_TOOL_NAMES.has(toolName) &&
				context?.state &&
				context.state.ccstyleShellEndedAt === undefined
			) {
				context.state.ccstyleShellEndedAt = Date.now();
			}
			// 折叠行接在摘要后，展开态接在 Output 正文后（原生也是在结果底部报一行）。
			const duration = shellDurationText(toolName, context, false);

			setToolVisualState(context, isError ? "error" : "success");
			const toolCallId = context?.toolCallId;
			if (shouldRenderRichDiff(config.mode, toolName, Boolean(isError))) {
				// getter 保证 Diff indicator / wrap / limits 下次绘制即更新
				const richResult = renderRichToolResult(
					toolName,
					result,
					{
						...options,
						expanded,
						// 全局共享状态避免 /reload 后旧 result renderer 闭包失联
						isHovered: () => isToolCallHovered(toolCallId),
					},
					theme,
					context,
					writeExecutionMetadata,
					getToolDisplayConfig,
				);
				// 展开态由 Box(1,1) 提供内边距，首行再缩 2 格与标题文字列对齐；折叠态 inset 一级缩进
				if (richResult)
					return expanded ? expandedBodyComponent(richResult) : insetComponent(richResult);
			}

			const text = textFromResult(result, expanded);
			const args = context?.args;
			if (expanded) {
				const taskResult = renderExpandedTaskResult(toolName, text, theme, Boolean(isError));
				if (taskResult) return taskResult;
			}
			const tasks = !isError && toolName === "TaskList" ? parseTaskList(text) : [];
			const rendered = tasks.length
				? taskListSummary(tasks)
				: collapsedResultSummary({ result, toolName, text, isError });
			const expandable = !expanded && (tasks.length > 0 || hasExpandableDetail(text, args));
			const hintText = showMoreHintText();
			const hintPrefix = expandable ? theme.fg("dim", " · ") : "";
			const hint = expandable ? hintPrefix + theme.fg("dim", hintText) : "";
			const hoveredHint = expandable ? hintPrefix + theme.fg("text", hintText) : "";
			if (expanded) {
				const view = renderExpandedToolResult(
					text || "",
					theme,
					Boolean(isError),
					context?.lastComponent,
					args,
					context,
					true, // mode=on：贴左，由外层 Box(1,1) 提供 1 格 padding
				);
				// 尾部附注只能挂在 IoView 上：鼠标层按对象识别它，包一层会断掉命中。
				// 与折叠态保持同一写法：裸值，不写 Took。
				if (isExpandedToolIoView(view)) view.setFooter(duration || undefined);
				return view;
			}
			if (context?.state) context.state.ccstyleIoView = undefined;
			// 折叠态的耗时接在摘要后、展开提示前（提示必须留在行尾供鼠标层识别）。
			const body = duration ? `${rendered}${theme.fg("dim", ` · ${duration}`)}` : rendered;
			let cachedWidth: number | undefined;
			let cachedLine: string | undefined;
			let cachedHoveredLine: string | undefined;
			return {
				render(width: number) {
					if (cachedLine === undefined || cachedWidth !== width) {
						cachedWidth = width;
						cachedLine = theme.fg(
							isError ? "error" : "muted",
							renderCollapsedToolResultToWidth(body, hint, width),
						);
						cachedHoveredLine = theme.fg(
							isError ? "error" : "muted",
							renderCollapsedToolResultToWidth(body, hoveredHint, width),
						);
					}
					return [isToolCallHovered(toolCallId) ? cachedHoveredLine! : cachedLine];
				},
				invalidate() {},
			};
		},
	};
}
