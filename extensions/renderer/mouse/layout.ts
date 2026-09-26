import { visibleWidth } from "@earendil-works/pi-tui";
import { ThinkingPreviewBlock } from "../../feature/compact-thinking.ts";
import { isCompactAssistantComponent } from "../compact-mode.ts";
import { ToolGroupComponent } from "../tool/grouping.ts";
import { isMessageDisplayComponent } from "../tool/message-display.ts";
import { isToolExecutionComponent, stripTerminalSequencesPreservingLayout } from "./packets.ts";
import { getScrollButtonWidget } from "./scroll.ts";

export type ComponentRowHit = {
	component: any;
	row: number;
	/** 内部工具命中时所属的展开 group；普通卡点击仍折叠整个 group。 */
	group?: ToolGroupComponent;
};

/** 行内 [click to show more] / [↑ Collapse] 提示的命中列区间（1-based，含两端）。 */
export function collapsedHintHitbox(line: string): { startCol: number; endCol: number } | null {
	const plain = stripTerminalSequencesPreservingLayout(line);
	const match =
		/(\([^()\n]* \/ click\)|click to show more|to show more|↑ Collapse|to collapse)(?=\)?\s*$)/.exec(
			plain,
		);
	if (!match?.[1]) return null;
	const startCol = visibleWidth(plain.slice(0, match.index)) + 1;
	return { startCol, endCol: startCol + visibleWidth(match[1]) - 1 };
}

/** 布局树点查询：返回 (x,y) 处最深含行 leaf box（屏幕行 → 组件局部行）。 */
export function fullscreenLeafAt(
	layout: any,
	x: number,
	y: number,
): { box: any; localRow: number } | null {
	const root = layout?.root;
	if (!root) return null;
	let best: { box: any; localRow: number } | null = null;
	let bestDepth = -1;
	const visit = (box: any, depth: number) => {
		if (!box) return;
		const clip = box.clip;
		if (!clip || x < clip.x || x >= clip.x + clip.width || y < clip.y || y >= clip.y + clip.height)
			return;
		const isLeaf = !Array.isArray(box.children) || box.children.length === 0;
		if (
			isLeaf &&
			y >= box.rect.y &&
			y < box.rect.y + Math.max(1, box.rect.height) &&
			depth > bestDepth
		) {
			best = { box, localRow: Math.max(0, y - box.rect.y) };
			bestDepth = depth;
		}
		for (const child of box.children ?? []) visit(child, depth + 1);
	};
	visit(root, 0);
	return best;
}

/** leaf 自身不带 scrollView；内容宽度由最近的 scroll 祖先决定。 */
export function fullscreenContentWidth(box: any, terminalWidth: number): number {
	for (let current = box; current; current = current.parent) {
		if (typeof current.scrollView?.getContentWidth === "function") {
			return Math.max(1, current.scrollView.getContentWidth(terminalWidth));
		}
	}
	return terminalWidth;
}

/** 点击列是否为官方滚动条列（放行官方拖动）。 */
export function isScrollbarColumnAt(layout: any, x: number): boolean {
	let hit = false;
	const visit = (box: any) => {
		if (hit || !box) return;
		if (box.scrollView?.isScrollbarVisible && x === box.rect.x + box.rect.width - 1) {
			hit = true;
			return;
		}
		for (const child of box.children ?? []) visit(child);
	};
	visit(layout?.root);
	return hit;
}

/** compact 展开卡用 childAtRow 映射 thinking；其余按 render 行数下钻。 */
function nestedChildAtRow(node: any, localRow: number, width: number): any {
	if (typeof node?.childAtRow === "function") {
		return node.childAtRow(localRow, width);
	}
	if (!Array.isArray(node?.children)) return null;
	let offset = 0;
	for (const child of node.children) {
		let count = 0;
		try {
			const rendered = child.render?.(width);
			if (Array.isArray(rendered)) count = rendered.length;
		} catch {
			count = 0;
		}
		if (localRow < offset + count) {
			return nestedChildAtRow(child, localRow - offset, width);
		}
		offset += count;
	}
	return null;
}

/**
 * 布局 leaf box 的组件通常是容器（documentContainer/dock 容器等），工具卡与
 * widget 在其 children 内。按局部行遍历组件树，定位实际命中的子组件。
 */
export function componentAtLocalRow(
	component: any,
	localRow: number,
	width: number,
): ComponentRowHit | null {
	if (component instanceof ToolGroupComponent) {
		// 展开的 group：头两行（空行 + 头行）归 group，其余行映射到内部工具。
		const child = component.childAtRow(localRow, width);
		return child ? { ...child, group: component } : { component, row: localRow };
	}
	if (isToolExecutionComponent(component)) {
		return { component, row: localRow };
	}
	if (isCompactAssistantComponent(component)) {
		// 折叠：整行摘要。展开：先命中内部 thinking hint，其余仍归外层卡片。
		if (component.expanded === true) {
			const inner = nestedChildAtRow(component, localRow, width);
			if (inner instanceof ThinkingPreviewBlock) {
				return { component: inner, row: localRow };
			}
		}
		return { component, row: localRow };
	}
	if (component instanceof ThinkingPreviewBlock) {
		return { component, row: localRow };
	}
	if (isMessageDisplayComponent(component)) {
		return { component, row: localRow };
	}
	if (component === getScrollButtonWidget()) {
		return { component, row: localRow };
	}
	if (!Array.isArray(component.children)) return null;
	let offset = 0;
	for (const child of component.children) {
		let lines: string[] = [];
		try {
			const rendered = child.render?.(width);
			if (Array.isArray(rendered)) lines = rendered.map((line) => String(line));
		} catch {
			lines = [];
		}
		if (localRow < offset + lines.length) {
			return (
				componentAtLocalRow(child, localRow - offset, width) ?? {
					component: child,
					row: localRow - offset,
				}
			);
		}
		offset += lines.length;
	}
	return null;
}

/** fullscreen single-expand：group 作为整体，不继续递归其内部工具。 */
export function collectFullscreenToolCards(
	component: any,
	out: any[],
	seen = new Set<any>(),
): void {
	if (!component || typeof component !== "object" || seen.has(component)) return;
	seen.add(component);
	if (
		isToolExecutionComponent(component) ||
		component instanceof ToolGroupComponent ||
		isCompactAssistantComponent(component) ||
		component instanceof ThinkingPreviewBlock ||
		isMessageDisplayComponent(component)
	) {
		out.push(component);
		return;
	}
	if (!Array.isArray(component.children)) return;
	for (const child of component.children) collectFullscreenToolCards(child, out, seen);
}
