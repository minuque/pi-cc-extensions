import assert from "node:assert/strict";
import test from "node:test";

import { UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	ScrollView,
	stripTerminalSequences,
	Text,
	TuiAltScreen,
	VStack,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
import { config, formatConfigStatus, normalizeConfig } from "../extensions/config/config.ts";
import { setToolTuiFullscreen } from "../extensions/renderer/tool/names.ts";
import {
	computeStickyPrompt,
	disposeStickyPromptPatches,
	handleStickyPromptClick,
	installStickyPromptPatches,
	renderStickyPromptScreen,
	resetStickyPromptState,
	setStickyPromptTheme,
	stickyPromptBar,
	updateStickyPromptHover,
} from "../extensions/renderer/mouse/sticky-prompt.ts";
import {
	getScrollButtonVisible,
	resetScrollButtonState,
} from "../extensions/renderer/mouse/scroll.ts";

initTheme("dark");

const START = "\x1b_cc:p\x07";
const END = "\x1b_cc:P\x07";
const VIEWPORT_WIDTH = 80;

/** 消息正文行：首行带 START，末行带 END，正文首行固定为索引 1。 */
function messageLines(text: string, height: number): string[] {
	const lines = Array.from({ length: height }, (_, index) => (index === 1 ? text : ""));
	lines[0] = START + lines[0];
	lines[height - 1] += END;
	return lines;
}

function assistantLines(height: number): string[] {
	return Array.from({ length: height }, (_, index) => `assistant ${index}`);
}

/** 合成结果会包一层样式重置与 OSC8 关闭符，断言只看可见文本。 */
function plain(line: string): string {
	return stripTerminalSequences(line);
}

/** 伪造 fullscreen 布局帧：主滚动盒 + 视口高度 + 内容行。 */
function makeFrame(content: string[], scrollTop: number, viewportHeight: number, clipX = 0) {
	let renders = 0;
	const scrollView: any = {
		scrollTop,
		followEnd: true,
		isFollowingEnd: false,
		isScrollbarVisible: false,
		lastScroll: null as { row: number; options: any } | null,
		scrollTo(row: number, options?: any) {
			scrollView.scrollTop = row;
			scrollView.lastScroll = { row, options };
		},
	};
	const contentBox: any = {
		component: { render: () => content },
		rect: { x: 0, y: -scrollTop, width: VIEWPORT_WIDTH, height: content.length },
		clip: { x: clipX, y: 0, width: VIEWPORT_WIDTH, height: viewportHeight },
		children: [],
	};
	const scrollBox: any = {
		component: {},
		rect: { x: 0, y: 0, width: VIEWPORT_WIDTH, height: viewportHeight },
		clip: { x: clipX, y: 0, width: VIEWPORT_WIDTH, height: viewportHeight },
		children: [contentBox],
		scrollView,
		scrollContentLines: content,
	};
	const layout: any = {
		root: {
			component: {},
			rect: { x: 0, y: 0, width: VIEWPORT_WIDTH, height: viewportHeight },
			clip: { x: 0, y: 0, width: VIEWPORT_WIDTH, height: viewportHeight },
			children: [scrollBox],
		},
		width: VIEWPORT_WIDTH,
		height: viewportHeight,
		lines: [],
		primaryScrollView: scrollView,
	};
	const tui: any = {
		mode: "fullscreen",
		currentLayout: layout,
		getPrimaryScrollView: () => scrollView,
		requestRender() {
			renders += 1;
		},
	};
	return {
		layout,
		scrollView,
		tui,
		screen: Array.from({ length: viewportHeight }, () => ""),
		renders: () => renders,
	};
}

function fakeTheme() {
	const slots: string[] = [];
	return {
		slots,
		theme: {
			fg: (_color: string, text: string) => text,
			bg: (slot: string, text: string) => {
				slots.push(slot);
				return text;
			},
		},
	};
}

/** 每个用例后复原全局状态：配置开关、补丁、跨帧缓存。 */
function withSticky<T>(body: () => T): T {
	const mode = config.mode;
	const enabled = config.stickyUserMessage;
	try {
		return body();
	} finally {
		config.mode = mode;
		config.stickyUserMessage = enabled;
		setToolTuiFullscreen(undefined as any);
		disposeStickyPromptPatches();
		resetStickyPromptState();
		resetScrollButtonState();
	}
}

test("sticky prompt: config defaults to on and shows in status", () => {
	assert.equal(normalizeConfig({}).stickyUserMessage, true);
	assert.equal(normalizeConfig({ stickyUserMessage: false }).stickyUserMessage, false);
	assert.match(formatConfigStatus(normalizeConfig({})), /stickyUserMessage=on/);
	assert.match(
		formatConfigStatus(normalizeConfig({ stickyUserMessage: false })),
		/stickyUserMessage=off/,
	);
});

test("sticky prompt: markers only injected in fullscreen", () => {
	withSticky(() => {
		installStickyPromptPatches();
		const text = "Long pasted compiler output";

		setToolTuiFullscreen(true);
		const fullscreen = new UserMessageComponent(text).render(VIEWPORT_WIDTH);
		assert.ok(fullscreen[0]?.endsWith(START), "首行带 START 标记");
		assert.ok(fullscreen[fullscreen.length - 1]?.endsWith(END), "末行带 END 标记");
		assert.equal(visibleWidth(fullscreen[0] ?? ""), VIEWPORT_WIDTH);

		setToolTuiFullscreen(false);
		const regular = new UserMessageComponent(text).render(VIEWPORT_WIDTH);
		assert.ok(
			regular.every((line) => !line.includes(START) && !line.includes(END)),
			"regular 不注入标记：没有消费方，标记不该写进终端",
		);
	});
});

test("sticky prompt: tall user message pins its first line at the viewport top", () => {
	withSticky(() => {
		const content = [...messageLines("Long pasted compiler output", 60), ...assistantLines(20)];
		const { layout, tui, screen } = makeFrame(content, 30, 10);
		const { theme, slots } = fakeTheme();
		setStickyPromptTheme(theme);

		const info = computeStickyPrompt(tui, layout);
		assert.equal(info?.row, 0, "粘性行落在视口首行");
		assert.equal(info?.jumpRow, 0, "跳转目标是消息首行（含顶部衬白）");
		assert.equal(info?.text, "Long pasted compiler output");
		assert.equal(info?.width, VIEWPORT_WIDTH);

		const rendered = renderStickyPromptScreen(tui, screen, layout, VIEWPORT_WIDTH);
		assert.equal(
			plain(rendered[0] ?? ""),
			stickyPromptBar(info!.text, VIEWPORT_WIDTH, false, theme),
		);
		assert.match(plain(rendered[0] ?? ""), /^ Long pasted compiler output/);
		assert.match(plain(rendered[0] ?? ""), /\[click to jump\]$/);
		assert.equal(visibleWidth(rendered[0] ?? ""), VIEWPORT_WIDTH);
		assert.deepEqual([...new Set(slots)], ["userMessageBg"], "底色与用户消息同槽位");
		assert.ok(
			rendered.every((line) => !line.includes(START) && !line.includes(END)),
			"标记不得写进终端",
		);
	});
});

test("sticky prompt: any user message pins once its first line scrolls off the top", () => {
	withSticky(() => {
		const content = [...messageLines("short instruction", 3), ...assistantLines(20)];

		// 正文首行还在视口内（滚动位置 = 正文首行）：不钉。
		const natural = makeFrame(content, 1, 10);
		assert.equal(computeStickyPrompt(natural.tui, natural.layout), null);

		// 正文首行已滚出上沿（短指令也一样）：钉住。
		const offTop = makeFrame(content, 2, 10);
		assert.equal(computeStickyPrompt(offTop.tui, offTop.layout)?.text, "short instruction");

		// 整条消息滚过视口：仍钉住，直到下一条指令接手。
		const past = makeFrame(content, 12, 10);
		assert.equal(computeStickyPrompt(past.tui, past.layout)?.text, "short instruction");
	});
});

test("sticky prompt: the next instruction takes over once it scrolls off the top", () => {
	withSticky(() => {
		const content = [
			...messageLines("first instruction", 3),
			...assistantLines(20),
			...messageLines("second instruction", 3),
			...assistantLines(20),
		];

		// 第一条指令的助手区：仍然钉第一条。
		const firstTurn = makeFrame(content, 10, 10);
		assert.equal(computeStickyPrompt(firstTurn.tui, firstTurn.layout)?.text, "first instruction");
		const beforeNext = makeFrame(content, 22, 10);
		assert.equal(computeStickyPrompt(beforeNext.tui, beforeNext.layout)?.text, "first instruction");

		// 第二条指令的正文首行进入视口：不需要钉，它本就在场。
		const nextVisible = makeFrame(content, 24, 10);
		assert.equal(computeStickyPrompt(nextVisible.tui, nextVisible.layout), null);

		// 第二条指令也滚出上沿：切到第二条。
		const secondTurn = makeFrame(content, 27, 10);
		assert.equal(
			computeStickyPrompt(secondTurn.tui, secondTurn.layout)?.text,
			"second instruction",
		);

		// 往上滚回第一条指令内：重新钉第一条。
		const back = makeFrame(content, 3, 10);
		assert.equal(computeStickyPrompt(back.tui, back.layout)?.text, "first instruction");
	});
});

test("sticky prompt: the header in place does not stick", () => {
	withSticky(() => {
		const content = [...messageLines("tall message", 40), ...assistantLines(40)];

		// 正文首行仍在视口内：消息头本来就在场。
		const visible = makeFrame(content, 1, 10);
		assert.equal(computeStickyPrompt(visible.tui, visible.layout), null);

		// 视口在消息之前的顶部：没有指令可钉。
		const top = makeFrame(content, 0, 10);
		assert.equal(computeStickyPrompt(top.tui, top.layout), null);
	});
});

test("sticky prompt: hover marks the row and keeps one highlight", () => {
	withSticky(() => {
		const content = [...messageLines("tall message", 40), ...assistantLines(10)];
		const frame = makeFrame(content, 20, 10);
		renderStickyPromptScreen(frame.tui, frame.screen, frame.layout, VIEWPORT_WIDTH);

		assert.equal(updateStickyPromptHover(frame.tui, { row: 1, col: 5 } as any), true, "粘性行命中");
		assert.equal(frame.renders() >= 1, true, "hover 变化触发重绘");
		const hovered = renderStickyPromptScreen(frame.tui, frame.screen, frame.layout, VIEWPORT_WIDTH);
		assert.match(plain(hovered[0] ?? ""), /^ tall message/);
		assert.equal(updateStickyPromptHover(frame.tui, { row: 4, col: 5 } as any), false);
		const moved = renderStickyPromptScreen(frame.tui, frame.screen, frame.layout, VIEWPORT_WIDTH);
		assert.equal(moved[0], hovered[0], "离开粘性行后回到普通态");
	});
});

test("sticky prompt: scrollbar column is not part of the bar", () => {
	withSticky(() => {
		const content = [...messageLines("tall message", 40), ...assistantLines(10)];
		const frame = makeFrame(content, 2, 10);
		frame.scrollView.isScrollbarVisible = true;
		renderStickyPromptScreen(frame.tui, frame.screen, frame.layout, VIEWPORT_WIDTH);

		const scrollbarCol = VIEWPORT_WIDTH;
		assert.equal(updateStickyPromptHover(frame.tui, { row: 1, col: scrollbarCol } as any), false);
		assert.equal(handleStickyPromptClick(frame.tui, { row: 1, col: scrollbarCol } as any), false);
		assert.equal(frame.scrollView.lastScroll, null);
		assert.equal(handleStickyPromptClick(frame.tui, { row: 1, col: 5 } as any), true);
	});
});

test("sticky prompt: the full row stays clickable when no scrollbar is drawn", () => {
	withSticky(() => {
		const content = [...messageLines("tall message", 40), ...assistantLines(10)];
		const frame = makeFrame(content, 25, 10);
		renderStickyPromptScreen(frame.tui, frame.screen, frame.layout, VIEWPORT_WIDTH);

		assert.equal(handleStickyPromptClick(frame.tui, { row: 1, col: VIEWPORT_WIDTH } as any), true);
		assert.deepEqual(frame.scrollView.lastScroll, { row: 0, options: { disableFollow: true } });
	});
});

test("sticky prompt: a click left of the bar misses", () => {
	withSticky(() => {
		const content = [...messageLines("tall message", 40), ...assistantLines(10)];
		const frame = makeFrame(content, 25, 10, 8);
		frame.scrollView.isScrollbarVisible = true;
		renderStickyPromptScreen(frame.tui, frame.screen, frame.layout, VIEWPORT_WIDTH);

		assert.equal(updateStickyPromptHover(frame.tui, { row: 1, col: 8 } as any), false);
		assert.equal(handleStickyPromptClick(frame.tui, { row: 1, col: 8 } as any), false);
		assert.equal(frame.scrollView.lastScroll, null);
		assert.equal(updateStickyPromptHover(frame.tui, { row: 1, col: 9 } as any), true);
	});
});

test("sticky prompt: click jumps to the message top", () => {
	withSticky(() => {
		const content = [...messageLines("tall message", 40), ...assistantLines(10)];
		const frame = makeFrame(content, 25, 10);
		renderStickyPromptScreen(frame.tui, frame.screen, frame.layout, VIEWPORT_WIDTH);

		assert.equal(
			handleStickyPromptClick(frame.tui, { row: 3, col: 1 } as any),
			false,
			"非粘性行不接管",
		);
		assert.equal(handleStickyPromptClick(frame.tui, { row: 1, col: 1 } as any), true);
		assert.deepEqual(frame.scrollView.lastScroll, { row: 0, options: { disableFollow: true } });
		assert.equal(getScrollButtonVisible(), true, "跳走即脱离底部跟随，亮出回到底部按钮");
		assert.equal(
			handleStickyPromptClick(frame.tui, { row: 1, col: 1 } as any),
			false,
			"跳转后本帧粘性行失效",
		);
	});
});

test("sticky prompt: stale frame state does not act", () => {
	withSticky(() => {
		const content = [...messageLines("tall message", 40), ...assistantLines(10)];
		const frame = makeFrame(content, 25, 10);
		renderStickyPromptScreen(frame.tui, frame.screen, frame.layout, VIEWPORT_WIDTH);
		// 下一帧换了布局对象：上一帧的行号不再可信。
		frame.tui.currentLayout = { root: null };
		assert.equal(handleStickyPromptClick(frame.tui, { row: 1, col: 1 } as any), false);
		assert.equal(updateStickyPromptHover(frame.tui, { row: 1, col: 1 } as any), false);
	});
});

test("sticky prompt: switched off keeps the transcript unchanged", () => {
	withSticky(() => {
		const content = [...messageLines("tall message", 40), ...assistantLines(10)];
		const frame = makeFrame(content, 25, 10);
		config.stickyUserMessage = false;
		const rendered = renderStickyPromptScreen(
			frame.tui,
			frame.screen,
			frame.layout,
			VIEWPORT_WIDTH,
		);
		assert.deepEqual(rendered, frame.screen);
		assert.equal(updateStickyPromptHover(frame.tui, { row: 1, col: 1 } as any), false);
		assert.equal(handleStickyPromptClick(frame.tui, { row: 1, col: 1 } as any), false);

		// off 模式还原原生渲染，同样不合成。
		config.mode = "off";
		assert.deepEqual(
			renderStickyPromptScreen(frame.tui, frame.screen, frame.layout, VIEWPORT_WIDTH),
			frame.screen,
		);
	});
});

test("sticky prompt: frame patch composites through the alt-screen hook and restores", () => {
	withSticky(() => {
		const original = (TuiAltScreen.prototype as any).compositeScrollToEndIndicator;
		installStickyPromptPatches();
		const installed = (TuiAltScreen.prototype as any).compositeScrollToEndIndicator;
		assert.notEqual(installed, original, "安装后包装原型方法");

		const content = [...messageLines("tall message", 40), ...assistantLines(10)];
		const frame = makeFrame(content, 25, 10);
		const screen = installed.call(
			{ scrollToEndIndicator: undefined, requestRender() {} },
			frame.screen,
			frame.layout,
			VIEWPORT_WIDTH,
		);
		assert.match(plain(screen[0] ?? ""), /^ tall message/);

		disposeStickyPromptPatches();
		assert.equal(
			(TuiAltScreen.prototype as any).compositeScrollToEndIndicator,
			original,
			"卸载后还原原型方法",
		);
	});
});

test("sticky prompt: a stale dispose leaves the replacement patches alive", async () => {
	const load = async () => {
		const jiti = createJiti(import.meta.url, { moduleCache: false });
		const path = new URL("../extensions/renderer/mouse/sticky-prompt.ts", import.meta.url).pathname;
		return (await jiti.import(path)) as any;
	};
	const first = await load();
	const second = await load();
	assert.notEqual(
		first.installStickyPromptPatches,
		second.installStickyPromptPatches,
		"两个模块实例（等价 /reload）",
	);
	const prototype = TuiAltScreen.prototype as any;
	const original = prototype.compositeScrollToEndIndicator;
	const hasMarker = () =>
		new UserMessageComponent("hi").render(40).some((line) => line.includes(START));
	try {
		// pi 的真实顺序：旧实例 shutdown 先跑，新实例 session_start 后跑。
		first.installStickyPromptPatches();
		first.disposeStickyPromptPatches();
		second.installStickyPromptPatches();
		assert.equal(hasMarker(), true, "新实例注入标记");

		// 旧实例的 dispose 后到：不得停掉已接手的补丁。
		first.disposeStickyPromptPatches();
		assert.equal(hasMarker(), true, "旧实例 dispose 后标记仍在注入");
		assert.notEqual(prototype.compositeScrollToEndIndicator, original, "帧合成补丁仍在");
	} finally {
		second.disposeStickyPromptPatches();
		first.disposeStickyPromptPatches();
		prototype.compositeScrollToEndIndicator = original;
	}
});

/** 真实帧路径：官方布局 + 真 ScrollView/UserMessageComponent，走完整 doRender。 */
function realFrame(userText: string, assistantLines: number) {
	const width = 100;
	const height = 20;
	const terminal: any = {
		columns: width,
		rows: height,
		isTTY: true,
		write() {},
		onData: () => () => {},
		setRawMode() {},
		getColorMode: () => "truecolor",
		start() {},
		stop() {},
	};
	const messages = new Container();
	messages.addChild(new UserMessageComponent(userText));
	for (let i = 0; i < assistantLines; i++) messages.addChild(new Text(`assistant line ${i}`));
	const scroll = new ScrollView(messages, { follow: "none", primary: true, scrollbar: "auto" });
	const tui: any = new TuiAltScreen(terminal, false, undefined, { mouse: true });
	tui.altScreenActive = true;
	tui.setLayoutRoot(
		new VStack([
			{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{
				component: new VStack([{ component: new Text("> "), shrink: 1, minSize: 1 }]),
				basis: "auto",
				grow: 0,
				shrink: 1,
				minSize: 1,
			},
		]),
	);
	return {
		tui,
		scroll,
		firstRow: () => stripTerminalSequences(tui.getScreenLines()[0] ?? ""),
		render(top: number) {
			scroll.scrollTo(top, { disableFollow: true });
			tui.doRender();
			return stripTerminalSequences(tui.getScreenLines()[0] ?? "");
		},
	};
}

test("sticky prompt: real alt-screen frame pins the row and strips markers", () => {
	withSticky(() => {
		setToolTuiFullscreen(true);
		installStickyPromptPatches();
		const firstRow = () => stripTerminalSequences(frame.tui.getScreenLines()[0] ?? "");
		const longPrompt = [
			"click 文本前不要有点，同时点击跳转后由于原生 userMessage box 有上有 padding，上方展示不全",
			...Array.from({ length: 40 }, (_, i) => `log ${i}`),
		].join("\n");
		const frame = realFrame(longPrompt, 120);

		assert.doesNotMatch(frame.render(0), /\[click to jump\]/, "消息头在场时不钉");
		assert.doesNotMatch(frame.render(1), /\[click to jump\]/, "正文首行在视口上沿时不钉");
		assert.match(frame.render(3), /^ click 文本前/, "正文首行滚出后钉住");
		assert.match(firstRow(), /… \[click to jump\]/, "截断处有省略号，提示在同一行");
		assert.match(frame.render(100), /^ click 文本前/, "消息滚过、进入助手区仍钉住");
		assert.ok(
			frame.tui.getScreenLines().every((line: string) => !line.includes(START)),
			"标记不得进终端帧",
		);
		// 截断插入的样式重置不得把后面的提示踢出底色。
		const rawRow = frame.tui.getScreenLines()[0] ?? "";
		const barStart = rawRow.indexOf("click 文本前");
		const hintEnd = rawRow.indexOf("[click to jump]") + "[click to jump]".length;
		assert.ok(barStart >= 0 && hintEnd > barStart, "粘性行在帧里");
		assert.equal(rawRow.slice(barStart, hintEnd).includes("[0m"), false, "提示之前不得有样式重置");

		// 点击粘性行：回到消息首行（含顶部衬白），整块都在视口内。
		frame.render(30);
		assert.equal(handleStickyPromptClick(frame.tui, { row: 1, col: 5 } as any), true);
		assert.equal(frame.scroll.scrollTop, 0, "跳转目标是消息首行");
		frame.tui.doRender();
		assert.doesNotMatch(firstRow(), /\[click to jump\]/, "指令可见后粘性行收走");
	});
});

test("sticky prompt: the scrollbar track on the pinned row does not jump to the top", () => {
	withSticky(() => {
		setToolTuiFullscreen(true);
		installStickyPromptPatches();
		const terminal: any = {
			columns: 100,
			rows: 20,
			isTTY: true,
			write() {},
			onData: () => () => {},
			setRawMode() {},
			getColorMode: () => "truecolor",
			start() {},
			stop() {},
		};
		const messages = new Container();
		const prompt = ["pinned prompt", ...Array.from({ length: 40 }, (_, i) => `log ${i}`)];
		messages.addChild(new UserMessageComponent(prompt.join("\n")));
		for (let i = 0; i < 300; i++) messages.addChild(new Text(`assistant line ${i}`));
		const scroll = new ScrollView(messages, { follow: "none", primary: true, scrollbar: "always" });
		const tui: any = new TuiAltScreen(terminal, false, undefined, { mouse: true });
		tui.altScreenActive = true;
		tui.setLayoutRoot(
			new VStack([
				{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: new Text("> "), basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			]),
		);
		const trackPress = { code: 0, row: 1, col: 100, final: "M" } as any;
		// 先渲染一帧让 ScrollView 算出 maxScrollTop，scrollTo 才拿得到目标位置。
		tui.doRender();
		const at = (top: number) => {
			scroll.scrollTo(top, { disableFollow: true });
			tui.doRender();
		};

		// 粘性条显示、滑块在下方：顶端那格是轨道，按下被吞掉，阅读位置不动。
		at(300);
		assert.match(stripTerminalSequences(tui.getScreenLines()[0] ?? ""), /pinned prompt/);
		assert.equal(handleStickyPromptClick(tui, trackPress), true);
		assert.equal(scroll.scrollTop, 300, "轨道顶端按下不跳到会话开头");

		// 粘性条还在、滑块也在顶端：不拦，交给 Pi 拖动。
		at(30);
		assert.match(stripTerminalSequences(tui.getScreenLines()[0] ?? ""), /pinned prompt/);
		assert.equal(handleStickyPromptClick(tui, trackPress), false, "滑块在顶端照常拖动");
		assert.equal(scroll.scrollTop, 30);

		// 粘性条不显示：顶端那格照旧交给滚动条，行为不变。
		at(0);
		assert.doesNotMatch(
			stripTerminalSequences(tui.getScreenLines()[0] ?? ""),
			/pinned prompt/,
			"粘性条消失后第 1 行只剩滚动条",
		);
		assert.equal(handleStickyPromptClick(tui, trackPress), false, "无粘性条时不拦");
		assert.equal(scroll.scrollTop, 0, "无粘性条时轨道顶端照常跳到开头");
	});
});

test("sticky prompt: truncated text keeps the bar styling across the whole row", () => {
	// CJK 长文本必被截断，而 truncateToWidth 会在截断处插入 \x1b[0m。
	const wrapped: string[] = [];
	let textColor = "";
	const theme = {
		fg: (color: string, text: string) => {
			textColor = color;
			return text;
		},
		bg: (_slot: string, text: string) => {
			wrapped.push(text);
			return text;
		},
	};
	const bar = stickyPromptBar(
		"click 文本前不要有点，同时点击跳转后由于原生 userMessage box 有上有 padding",
		40,
		false,
		theme,
	);
	assert.equal(visibleWidth(bar), 40);
	assert.equal(wrapped.length, 1, "整行只包一层底色");
	assert.doesNotMatch(wrapped[0] ?? "", /\x1b\[/, "底色内部不得残留样式重置");
	assert.match(wrapped[0] ?? "", /\[click to jump\]$/, "提示与正文同时色同底");
	assert.equal(textColor, "dim");
	assert.match(bar, /…/);
});

test("sticky prompt: narrow viewport drops the click hint before the text", () => {
	const { theme } = fakeTheme();
	const narrow = stickyPromptBar("a much longer user message than fits", 16, false, theme);
	assert.equal(visibleWidth(narrow), 16);
	assert.doesNotMatch(narrow, /\[click to jump\]/);
	assert.match(narrow, /^ /);
});
