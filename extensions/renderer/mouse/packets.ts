import type { ExpandedToolIoView, ToolIoSection } from "../tool/tool-io.ts";
import { walkComponentTree } from "../../utils/component-tree.ts";
export {
	stripTerminalSequences,
	stripTerminalSequencesPreservingLayout,
} from "../../utils/ansi-text.ts";
export {
	parseSgrMousePackets,
	isSgrLeftPress,
	isSgrLeftRelease,
	isSgrIdleMotion,
	type SgrMousePacket,
} from "../../utils/sgr-mouse.ts";

/** Final painted placement of one outermost tool/group row after parent layout. */
export type FrameToolPlacement = {
	component: any;
	componentRow: number;
	lineIndex: number;
	/** Marker-stripped final line text as painted after parent layout. */
	finalLine: string;
	view?: ExpandedToolIoView;
	section?: ToolIoSection;
};

/** Zero-width APC row marker (like pi CURSOR_MARKER); stripped before terminal output. */
const TOOL_FRAME_MARKER_RE = /\x1b_cc:t(\d+):(\d+)\x07/g;
const TOOL_VIEW_MARKER_RE = /\x1b_cc:v(\d+):([io])\x07/g;
export const toolFrameMarker = (id: number, row: number) => `\x1b_cc:t${id}:${row}\x07`;

/** 工具执行组件识别（toolCallId + setExpanded + render）。 */
export function isToolExecutionComponent(value: any): boolean {
	return Boolean(
		value &&
			typeof value === "object" &&
			typeof value.toolCallId === "string" &&
			typeof value.setExpanded === "function" &&
			typeof value.render === "function",
	);
}

/** 深度收集组件树中的工具执行组件（含 getMountedRoots 分支）。 */
export function collectToolComponents(component: any, tools: any[]): void {
	walkComponentTree(component, (value: any) => {
		if (isToolExecutionComponent(value)) {
			tools.push(value);
			return false;
		}
	});
}

/** 剥离一行中的零宽帧/视图 marker。 */
export function stripToolFrameMarkers(line: string): string {
	return line.replace(TOOL_FRAME_MARKER_RE, "").replace(TOOL_VIEW_MARKER_RE, "");
}

/**
 * 从渲染行中提取工具帧 placement（component/componentRow/lineIndex/finalLine
 * 及其所属视图与 section），同时返回剥离 marker 后的行。
 */
export function extractToolFramePlacements(
	lines: string[],
	idToComponent: Map<number, any>,
	idToView: Map<number, ExpandedToolIoView>,
): { lines: string[]; placements: FrameToolPlacement[] } {
	const placements: FrameToolPlacement[] = [];
	const cleaned = lines.map((line, lineIndex) => {
		const toolMatches = [...line.matchAll(TOOL_FRAME_MARKER_RE)];
		const viewMatches = [...line.matchAll(TOOL_VIEW_MARKER_RE)];
		const finalLine = stripToolFrameMarkers(line);
		let view: ExpandedToolIoView | undefined;
		let section: ToolIoSection | undefined;
		for (const match of viewMatches) {
			const candidate = idToView.get(Number(match[1]));
			if (!candidate) continue;
			view = candidate;
			section = match[2] === "i" ? "input" : "output";
			break;
		}
		for (const match of toolMatches) {
			const component = idToComponent.get(Number(match[1]));
			if (!component) continue;
			placements.push({
				component,
				componentRow: Number(match[2]),
				lineIndex,
				finalLine,
				view,
				section,
			});
		}
		return finalLine;
	});
	return { lines: cleaned, placements };
}
