/**
 * ask_user_question 的结果渲染。
 *
 * 这个工具来自第三方扩展，没有自己的渲染器，通用渲染只把结果收成
 * 「N lines returned」，用户选了什么要展开才看得到，而且是一段给模型的英文。
 * 选择在 `result.details.answers` 里，这里直接用它。
 *
 * 折叠态摊成树（与 codemode 子调用同一套衔接符，缩进单独对齐本工具标题的勾）：
 *   ├ 问题1 -> 回答1
 *   └ 问题2（多选）-> 回答2, 回答2
 * 标题行在后面追加 (+N) 报问题数。展开态按「问题 / 所选 / 备注」逐条列出。
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../utils/ansi-text.ts";
import { oneLine } from "../../utils/format.ts";
import { showMoreHintText } from "./names.ts";
import { headTruncateToWidth, toolViewportWidth } from "./result.ts";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

/** 折叠态正文缩进：1 格，让 ├/└ 落在标题行勾号（" ✓"）的正下方。 */
const INDENT = " ";
/** 没选、取消、或答案为空时的占位。 */
const NO_ANSWER = "(no answer)";

export type AskUserAnswer = {
	questionIndex?: unknown;
	question?: unknown;
	kind?: unknown;
	answer?: unknown;
	selected?: unknown;
	notes?: unknown;
};

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

export function askUserAnswers(result: any): AskUserAnswer[] {
	const answers = result?.details?.answers;
	return Array.isArray(answers) ? answers : [];
}

/** 按问题下标排序；下标缺失的排到最后，保持原有相对顺序。 */
function orderedAnswers(result: any): AskUserAnswer[] {
	return askUserAnswers(result)
		.map((answer, index) => ({ answer, index }))
		.sort((left, right) => {
			const leftIndex = Number(left.answer.questionIndex);
			const rightIndex = Number(right.answer.questionIndex);
			const leftMissing = !Number.isFinite(leftIndex);
			const rightMissing = !Number.isFinite(rightIndex);
			if (leftMissing || rightMissing) {
				if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
				return left.index - right.index;
			}
			return leftIndex - rightIndex;
		})
		.map((entry) => entry.answer);
}

/** 一个问题的作答文本：多选取全部标签，其余取 answer；空则占位。 */
export function askUserAnswerText(answer: AskUserAnswer): string {
	if (answer?.kind === "multi") {
		const selected = Array.isArray(answer.selected)
			? answer.selected.map(text).filter(Boolean)
			: [];
		return selected.length > 0 ? selected.join(", ") : NO_ANSWER;
	}
	return text(answer?.answer) || NO_ANSWER;
}

/**
 * 标题行追加的问题数。结果还没到时从参数里数，这样调用期间标题也只留工具名，
 * 不会先闪出第一个问题再缩回去。
 */
export function askUserQuestionCount(result: any, args?: any): number | undefined {
	const answered = askUserAnswers(result).length;
	if (answered > 0) return answered;
	const questions = Array.isArray(args?.questions) ? args.questions.length : 0;
	return questions > 0 ? questions : undefined;
}

function answerRows(result: any): { question: string; answer: string }[] {
	return orderedAnswers(result).map((answer) => ({
		question: text(answer?.question) || "Question",
		answer: askUserAnswerText(answer),
	}));
}

/**
 * 折叠态的问答树。问题行一律用 ├，最后一行用 └ 收汇总，
 * 展开提示只挂在收尾行上，不追加到问题行（与 codemode 子调用一致）。
 * 没有作答（取消、校验失败）时退回一行摘要。
 */
export function askUserCollapsedLines(options: {
	result: any;
	theme: any;
	isError: boolean;
	width: number;
	hovered?: boolean;
}): string[] {
	const { result, theme, isError } = options;
	const fg = theme.fg.bind(theme);
	const rowWidth = toolViewportWidth(options.width);
	const rows = answerRows(result);
	if (rows.length === 0) {
		const label = result?.details?.cancelled === true ? "Declined" : "Done";
		return [truncateToWidth(`${INDENT}${fg(isError ? "error" : "muted", label)}`, rowWidth, "")];
	}
	const lines = rows.map((row) => {
		const prefix = `${INDENT}${fg("dim", "├")} `;
		const separator = fg("dim", " -> ");
		const fixed = visibleWidth(prefix) + visibleWidth(separator);
		const share = Math.max(1, Math.floor((rowWidth - fixed) / 2));
		// 问题只是标签，低一档对比度；亮色留给标题和回答。
		const question = fg("muted", headTruncateToWidth(row.question, share));
		const answerWidth = Math.max(1, rowWidth - fixed - visibleWidth(question));
		const answer = fg(isError ? "error" : "success", headTruncateToWidth(row.answer, answerWidth));
		return truncateToWidth(`${prefix}${question}${separator}${answer}`, rowWidth, "");
	});
	// 圆点保持 dim；hover 只高亮可点击文字。
	const prefix = `${INDENT}${fg("dim", "└")} `;
	const hint = ` ${fg("dim", "·")} ${fg(options.hovered ? "text" : "dim", showMoreHintText())}`;
	const bodyWidth = Math.max(1, rowWidth - visibleWidth(prefix) - visibleWidth(hint));
	const summary = headTruncateToWidth(`${rows.length} answered`, bodyWidth);
	lines.push(
		truncateToWidth(`${prefix}${fg(isError ? "error" : "muted", summary)}${hint}`, rowWidth, ""),
	);
	return lines;
}

/** 展开态正文：每个问题一段，所选在下一行，备注和总备注附在后面。 */
export function askUserExpandedBody(result: any): string {
	const parts = orderedAnswers(result).map((answer) => {
		const lines = [text(answer?.question) || "Question", `  ${askUserAnswerText(answer)}`];
		const notes = text(answer?.notes);
		if (notes) lines.push(`  notes: ${oneLine(notes, 4_000)}`);
		return lines.join("\n");
	});
	const globalNote = text(result?.details?.globalNote);
	if (globalNote) parts.push(`Note: ${oneLine(globalNote, 4_000)}`);
	if (parts.length === 0 && result?.details?.cancelled === true) return "Declined";
	return parts.join("\n\n");
}

/**
 * 折叠态结果组件。只有最后一行是展开入口；行本身很便宜，不自己缓存
 * （settled 卡另有整行 paint 缓存）。hover 状态在 render() 内取。
 */
export function createAskUserResultComponent(options: {
	result: any;
	theme: any;
	isError: boolean;
	isHovered?: () => boolean;
}): any {
	const { result, theme, isError } = options;
	return {
		render(width: number): string[] {
			return askUserCollapsedLines({
				result,
				theme,
				isError,
				width,
				hovered: options.isHovered?.() ?? false,
			});
		},
		invalidate(): void {},
		isCollapsedHintLine(plainLine: string): boolean {
			return /(click to show more|to show more)\s*$/.test(stripAnsi(plainLine));
		},
	};
}
