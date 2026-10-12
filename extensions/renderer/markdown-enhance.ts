import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { render as renderMermaid, sourceBox } from "grok-mermaid";

// ============================================================================
// Mermaid 方言渲染
// ============================================================================

// 内置 mermaid transformer 只认 ```mermaid，这里补上 grok-mermaid 支持的其他方言
const DIAGRAM_FENCE =
	/^(`{3,})\s*(mermaid|statediagram|statediagram-v2|classdiagram|classdiagram-v2|erdiagram|sequencediagram)\s*$/i;
const FENCE_OPEN = /^(`{3,})/;
const FENCE_CLOSE = /^`{3,}\s*$/;

/** 把一行图内容包成行内代码（保持空格与框线字符对齐）。 */
function codeSpan(line: string): string {
	const content = line || "\u00a0";
	const longestRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (m) => m[0].length));
	const fence = "`".repeat(longestRun + 1);
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${padding}${content}${padding}${fence}`;
}

/** 渲染失败或图宽超出终端宽度时，把源码包进带标题的框里显示。 */
function framedSource(src: string, width: number): string {
	const box = sourceBox(src, Math.max(8, width - 2));
	return `\`\`\`\n${box.plain.join("\n")}\n\`\`\``;
}

/** 解析 ```diagram 代码块，返回 { 源码, 块内行数 }；未闭合返回 null。 */
function collectFence(lines: string[], i: number): { diagram: string; next: number } | null {
	const open = lines[i].match(FENCE_OPEN)?.[0] ?? "```";
	const src: string[] = [];
	let j = i + 1;
	while (j < lines.length) {
		if (lines[j].match(FENCE_CLOSE) && lines[j].startsWith(open)) {
			return { diagram: src.join("\n"), next: j + 1 };
		}
		src.push(lines[j]);
		j++;
	}
	return null; // 未闭合：放弃转换，保持原文
}

// ============================================================================
// GitHub 风格提示框（admonition）
// ============================================================================

const ADMONITION = /^>\s*\[\s*!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\s*\]\s*(.*)$/i;
const ADMONITION_STYLE: Record<string, { icon: string; label: string }> = {
	NOTE: { icon: "💡", label: "NOTE" },
	TIP: { icon: "✅", label: "TIP" },
	IMPORTANT: { icon: "❗", label: "IMPORTANT" },
	WARNING: { icon: "⚠️", label: "WARNING" },
	CAUTION: { icon: "⚠️", label: "CAUTION" },
};

/**
 * 把 > [!TYPE] 及其后续 > 行转成带加粗标签的引用块，视觉上成提示框。
 * 多行内容用空格合并为一行。返回 null 表示该行不是提示框。
 */
function renderAdmonition(lines: string[], i: number): { output: string[]; next: number } | null {
	const m = lines[i].match(ADMONITION);
	if (!m) return null;
	const style = ADMONITION_STYLE[m[1].toUpperCase()];
	const body: string[] = [m[2]];
	let j = i + 1;
	while (j < lines.length && /^>\s?/.test(lines[j]) && !ADMONITION.test(lines[j])) {
		body.push(lines[j].replace(/^>\s?/, ""));
		j++;
	}
	while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
	// 内容合并为一行，作为引用块正文
	const content = body.join(" ").trim();
	// 保留引用块形态（pi 渲染为左侧竖线），标签加粗
	return {
		output: [`> **${style.icon} ${style.label}**${content ? ` ${content}` : ""}`, ""],
		next: j,
	};
}

// ============================================================================
// 裸 URL 转可点击超链接
// ============================================================================

const URL_RE = /(?<!<)(?<!\]\()https?:\/\/[^\s<>'"|，。；：！？、」』】（）【】《》『』「」]+/g;
const TRIM_URL_RE = /[.,;:!?】」』"'》）}]+$/;

/**
 * 去掉 URL 尾部标点；括号按平衡保留（如 Wikipedia 链接含括号、
 * IPv6 地址含 [::1]），尾部不成对的 ] 与 ) 会截掉。
 */
function trimUrl(url: string): string {
	let t = url.replace(TRIM_URL_RE, "");
	for (;;) {
		if (t.endsWith(")") && (t.match(/\(/g)?.length ?? 0) < (t.match(/\)/g)?.length ?? 0)) {
			t = t.slice(0, -1);
		} else if (t.endsWith("]") && (t.match(/\[/g)?.length ?? 0) < (t.match(/\]/g)?.length ?? 0)) {
			t = t.slice(0, -1);
		} else {
			break;
		}
	}
	return t;
}

/**
 * 把代码块和行内代码外的裸 URL 转成 markdown 链接。
 * 已有的 [text](url) / ![alt](url) / <url> 自动链接用 lookbehind 排除。
 */
function linkifyUrls(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let fence: MarkdownFence | undefined;
	for (const line of lines) {
		const scanned = scanMarkdownFence(line, fence);
		fence = scanned.fence;
		if (scanned.protected) {
			out.push(line);
			continue;
		}
		// 行内代码（`...`）按反引号分片，只处理偶数片（代码外）
		const parts = line.split("`");
		for (let p = 0; p < parts.length; p++) {
			if (p % 2 === 0) {
				parts[p] = parts[p].replace(URL_RE, (url) => {
					const trimmed = trimUrl(url);
					if (trimmed.length === 0) return url;
					return `[${trimmed}](${trimmed})`;
				});
			}
		}
		out.push(parts.join("`"));
	}
	return out.join("\n");
}

// ============================================================================
// 圈数字 → 半角括号
// ============================================================================

// Nerd Font 补丁字形（U+2460-U+2473）ink 超界，DirectWrite 下渲染会压住相邻字符；
// 转成 ASCII "(n)" 后任何字体下宽度一致。U+2460-U+2473 连续，差值即序号。
const CIRCLED_RE = /[①-⑳]/g;

const BLOCKQUOTE_PREFIX = /^ {0,3}>[ \t]?/;
const CODE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const CODE_FENCE_CLOSE = /^ {0,3}(`+|~+)[ \t]*$/;

type MarkdownFence = { marker: string; blockquoteDepth: number };

function parseFenceLine(line: string): { blockquoteDepth: number; content: string } {
	let content = line;
	let blockquoteDepth = 0;
	while (BLOCKQUOTE_PREFIX.test(content)) {
		content = content.replace(BLOCKQUOTE_PREFIX, "");
		blockquoteDepth++;
	}
	return { blockquoteDepth, content };
}

function scanMarkdownFence(
	line: string,
	fence: MarkdownFence | undefined,
): { protected: boolean; fence: MarkdownFence | undefined } {
	const parsed = parseFenceLine(line);
	if (fence && parsed.blockquoteDepth >= fence.blockquoteDepth) {
		const close = parsed.content.match(CODE_FENCE_CLOSE)?.[1];
		const closed =
			parsed.blockquoteDepth === fence.blockquoteDepth &&
			close?.[0] === fence.marker[0] &&
			close.length >= fence.marker.length;
		return { protected: true, fence: closed ? undefined : fence };
	}
	const marker = parsed.content.match(CODE_FENCE_OPEN)?.[1];
	return {
		protected: Boolean(marker),
		fence: marker ? { marker, blockquoteDepth: parsed.blockquoteDepth } : undefined,
	};
}

function deCircled(markdown: string): string {
	let fence: MarkdownFence | undefined;
	return markdown
		.split("\n")
		.map((line) => {
			const scanned = scanMarkdownFence(line, fence);
			fence = scanned.fence;
			if (scanned.protected) return line;
			return line.replace(CIRCLED_RE, (ch) => `(${ch.codePointAt(0)! - 0x2460 + 1})`);
		})
		.join("\n");
}

// ============================================================================
// 跨行链接规整
// ============================================================================

const MULTILINE_LINK_RE = /\[([^\]\n]*(?:\n[^\]\n]*)+)\](?=\()/g;

/** 防止 Markdown 跨行链接把行尾填充空格纳入 OSC 8 点击区。 */
function normalizeMultilineLinks(markdown: string): string {
	const out: string[] = [];
	let prose: string[] = [];
	let fence: MarkdownFence | undefined;
	const flush = () => {
		if (prose.length === 0) return;
		out.push(
			prose.join("\n").replace(MULTILINE_LINK_RE, (_match, label: string) => {
				const normalized = label.replace(/[ \t]*\n[ \t]*/g, " ").trim();
				return `[${normalized}]`;
			}),
		);
		prose = [];
	};
	for (const line of markdown.split("\n")) {
		const scanned = scanMarkdownFence(line, fence);
		const opening = !fence && scanned.fence;
		const closing = fence && !scanned.fence;
		fence = scanned.fence;
		if (opening || closing) flush();
		if (scanned.protected) out.push(line);
		else prose.push(line);
	}
	flush();
	return out.join("\n");
}

// ============================================================================
// 注册
// ============================================================================

export default function (pi: ExtensionAPI): void {
	// 注意：pi 每个扩展只有一个 markdownTransformer 槽位，多次注册会互相覆盖，
	// 所以三个转换合并为一次注册，内部按序链式执行。
	pi.registerMarkdownTransformer((markdown, context) => {
		const { messageType, isStreaming = false } = context ?? {};
		// thinking 保持原文；普通回复即使流式中也先关闭跨行链接的空白点击区。
		if (messageType === "assistant-thinking") return markdown;
		markdown = normalizeMultilineLinks(markdown);
		if (isStreaming) return markdown;
		// 0. 圈数字转半角括号（Nerd Font 补丁字形缺陷规避）
		markdown = deCircled(markdown);
		// 1. Mermaid 方言渲染
		markdown = renderDiagrams(markdown, context);
		// 2. GitHub 风格提示框
		markdown = renderAdmonitions(markdown);
		// 3. 裸 URL 转超链接
		return linkifyUrls(markdown);
	});
}

// grok-mermaid 渲染结果缓存：resize/restored 重绘会重复转换，按源码缓存 art。
// ponytail: 固定上限 50 条，防长期会话膨胀；超出后清空重来。
const ART_CACHE = new Map<string, ReturnType<typeof renderMermaid>>();
const ART_CACHE_MAX = 50;

/** 获取/计算 mermaid art（带缓存）。 */
function getArt(src: string): ReturnType<typeof renderMermaid> | null {
	const cached = ART_CACHE.get(src);
	if (cached) return cached;
	let art = null;
	try {
		art = renderMermaid(src);
	} catch {
		art = null;
	}
	if (ART_CACHE.size >= ART_CACHE_MAX) ART_CACHE.clear();
	if (art) ART_CACHE.set(src, art);
	return art;
}

/** Mermaid 方言代码块 → ASCII 图（流式跳过）。 */
function renderDiagrams(
	markdown: string,
	context?: { isStreaming?: boolean; availableWidth?: number },
): string {
	const { isStreaming = false, availableWidth } = context ?? {};
	if (isStreaming) return markdown;
	const lines = markdown.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const fence = line.match(DIAGRAM_FENCE);
		if (fence) {
			const collected = collectFence(lines, i);
			if (collected) {
				const { diagram, next } = collected;
				// grok-mermaid 需要源码自带类型头，方言头在 fence 标签里时补回去
				const label = fence[2];
				const src = label.toLowerCase() === "mermaid" ? diagram : `${label}\n${diagram}`;
				const art = getArt(src);
				const width = availableWidth ?? 80;
				if (art && art.width <= width) {
					// 图行用硬换行（行尾两空格）连接，防止 Markdown 软换行合并行
					out.push(art.plain.map(codeSpan).join("  \n"));
				} else {
					out.push(framedSource(src, width));
				}
				i = next;
				continue;
			}
			// 未闭合：保持原文
		}
		out.push(line);
		i++;
	}
	return out.join("\n");
}

/** GitHub 风格提示框 → 加粗标签引用块（跳过代码块）。 */
function renderAdmonitions(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let fence: MarkdownFence | undefined;
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const scanned = scanMarkdownFence(line, fence);
		fence = scanned.fence;
		if (scanned.protected) {
			out.push(line);
			i++;
			continue;
		}
		if (/^>\s*\[\s*!/i.test(line)) {
			const result = renderAdmonition(lines, i);
			if (result) {
				out.push(...result.output);
				i = result.next;
				continue;
			}
		}
		out.push(line);
		i++;
	}
	return out.join("\n");
}
