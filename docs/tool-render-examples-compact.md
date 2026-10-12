# 工具 Render 示例（ccstyle · compact）

> 由真实 renderer 驱动生成的示例快照，已剥离 ANSI。
> 实际 TUI 中包含状态色、背景色和 hover 高亮；Braille loading 帧与耗时快照取固定时钟。
> 当前版本：ccstyle 1.0.1 · mode=`compact`。
> renderer 变更后请运行 `npm run docs:tool-render` 同步本文件。

## 1. 消息折叠摘要行

含 toolCall 的 assistant 折叠为一行摘要（运行时长 + 工具计数）。普通工具不单独成行。独立渲染下摘要跟在正文后（如下）；挂进 transcript 容器后，摘要行是回合末尾的独立尾行组件：

```text
 Running... · 9s, bash×1, read×2, grep×1 · click to show more
 ↳ ✓ Grep "x"
     ↳ 1 line returned
```

展开（Ctrl+O / 点击摘要行）后助手文本按原生渲染，thinking 与工具卡装进展开卡背景面板（`expandedCardBackground`，默认 userMessageBg）：

```text
 checking the diff

  Thinking...

  ✓ Bash npm test
    ↳ 1 line returned · click to show more

  ✓ Read a.ts
    ↳ 2 lines loaded · click to show more
```

- 进行中：`Running... · <时长>`；结束后：`Ran for <时长>`。
- 摘要行挂在 transcript 容器内回合末尾（工具卡/diff 之下）：运行中恒在视口底缘可写区刷新，回合结束就地落成 `Ran for` 随 transcript 进入 scrollback；新工具卡追加时自动归位，不会越出回合。
- 时长 = max(thinking, 回合挂钟)；thinking 冻结后挂钟继续抬高。
- 工具按消息内首次出现顺序；`read` 按非空路径去重。
- `edit` / `write` / `ask_user_question` **不进**摘要计数（各自独立单行）。
- Agent/Task 调用只进摘要；tool 卡始终折叠。底部面板走独立 widget。
- abort/error/length 状态行挂在回合内摘要之上，不被折叠吞掉。
- 行末 `click to show more`；摘要永不换行。
- 展开后：摘要行隐藏，助手文本按原生渲染（不进面板），thinking 与工具卡进面板；展开的 thinking 再套一层更深的内卡，工具卡只用外卡底色。
- 点击展开前先停住底部跟随：内容变高不会把点的那行顶出屏幕（工具卡与摘要行同一口径，收起时还原展开前的视口）。

纯函数口径（`buildMessageSummary`）：

```text
Ran for 9s, read×2, bash×1, grep×1
Running... · 9s, bash×1, read×1
```

## 2. 普通工具行隐藏

折叠时普通工具卡 **不渲染独立行**（卡自身已被摘要统计）：

```text
read 折叠行数: 0
bash 折叠行数: 0
```

展开（Ctrl+O / 点击）后恢复 default 风格工具卡或原生 renderer。

## 3. edit / write 独立行

edit/write 折叠预览与展开正文复用 mode=on 的 Diff 配置。计数只显示一处：正文带 +A -D（diff 头行或多行预览的摘要行）时标题不重复：

```text
 ✓ edit sample.ts
   ↳ diff · +1 · -1 · unified [━━━━━━━━]
 ───────────────────────────────────────────────────────────────────────
 @@ -1 +1 @@
 ▌  1 │ const x = 1
 ▌  1 │ const x = 2
 ───────────────────────────────────────────────────────────────────────

 ✓ write out.ts
   ↳ diff +1 -0 · created · click to show more
```

`editDiffCollapsedLines: 0` also applies in compact mode; edit calls stay individually visible and do not join the round's tool counts. The zero-line summary row carries the counts, colored the same as the diff header:

```text
 ✓ edit sample.ts
   ↳ diff +1 -1 · click to show more
```

挂进 transcript 容器后的回合布局——摘要尾行落在 diff 之下、回合末尾：

```text
 updated sample.ts
 ✓ edit sample.ts
   ↳ diff · +1 · -1 · unified [━━━━━━━━]
 ───────────────────────────────────────────────────────────────────────
 @@ -1 +1 @@
 ▌  1 │ const x = 1
 ▌  1 │ const x = 2
 ───────────────────────────────────────────────────────────────────────
 Ran for 1s · click to show more
 task done
```

展开 edit：

```text
 ✓ edit sample.ts
 ↳ diff · +1 · -1 · unified [━━━━━━━━]
 ────────────────────────────────────────────
 @@ -1 +1 @@
 ▌  1 │ const x = 1
 ▌  1 │ const x = 2
 ────────────────────────────────────────────
```

## 4. 无 toolCall 的最终回复

不含 toolCall 的 assistant 走原生渲染：

```text
 task done
```

## 5. 回合聚合规则

- 连续含 toolCall 的 assistant 消息累加进同一回合摘要，直到出现可见最终文本。
- 用户消息是回合的硬边界：steer 消息插进回合中间、或上一回合没正文就收尾时，回合就地收口、后续消息另起一回合。区间里的用户消息不会被当成外来行挪走，摘要行与展开面板都留在自己回合的位置上。
- 运行时长跨消息累加（thinking query + 回合挂钟 floor）。
- 最终 agent 回合摘要仍由 `feature/agent-summary` 独占（bash/read/edit/write/other）。
- mode 切回 `on`/`off` 后，assistant 与 tool 均恢复对应原生/default 渲染。

## 6. Working footer

与 default 相同，保留 Pi 原生 spinner，仅扩展文本：

```text
⠋ Working...
⠋ Working... (↓ 1,234 tokens · 12s)
```
