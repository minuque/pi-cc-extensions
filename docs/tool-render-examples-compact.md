# 工具 Render 示例（ccstyle · compact）

> 由真实 renderer 驱动生成的示例快照，已剥离 ANSI。
> 实际 TUI 中包含状态色、背景色和 hover 高亮；Braille loading 帧会随时间变化。
> 当前版本：ccstyle 0.9.4 · mode=`compact`。
> renderer 变更后请运行 `npm run docs:tool-render` 同步本文件。

## 1. 消息折叠摘要行

含 toolCall 的 assistant 折叠为单行摘要（运行时长 + 工具计数）：

```text
 Running... · 9s, bash×1, read×2, grep×1 • click to show more
```

展开（Ctrl+O / 点击摘要行）后恢复原生渲染：

```text
   $ npm test

   pass 79/79

   read a.ts

  Thinking...
```

- 进行中：`Running... · <时长>`；结束后：`Ran for <时长>`。
- 时长 = max(thinking, 回合挂钟)；thinking 冻结后挂钟继续抬高。
- 工具按消息内首次出现顺序；`read` 按非空路径去重。
- `edit` / `write` **不进**摘要计数（各自独立单行）。
- Agent/Task 调用只进摘要；tool 卡始终折叠。底部面板走独立 widget。
- abort/error/length 状态行挂在摘要外层，不被折叠吞掉。
- 行末 `click to show more`；摘要永不换行。
- 展开后：摘要行隐藏，thinking 与工具卡恢复原生渲染，子卡片背景更深且带内部 padding。

纯函数口径（`buildMessageSummary`）：

```text
Ran for 9s, read×2, bash×1, grep×1
Running... · 9s, bash×1, read×1
```

## 2. 普通工具行隐藏

折叠时普通工具 **不渲染独立行**（摘要已统计）：

```text
read 折叠行数: 0
bash 折叠行数: 0
```

展开（Ctrl+O / 点击）后恢复 default 风格工具卡或原生 renderer。

## 3. edit / write 独立行

edit/write 标题行带统计；折叠预览与展开正文复用 mode=on 的 Diff 配置：

```text
 ✓ edit sample.ts (+1 -1)
   ↳ diff • +1 • -1 • unified [━━━━━━━━]
 ───────────────────────────────────────────────────────────────────────
 @@ -1 +1 @@
 ▌  1 │ const x = 1
 ▌  1 │ const x = 2
 ───────────────────────────────────────────────────────────────────────

 ✓ write out.ts (+1 -0)
   ↳ created • click to show more
```

展开 edit：

```text
 ✓ edit sample.ts (+1 -1)
 ↳ diff • +1 • -1 • unified [━━━━━━━━]
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
- 运行时长跨消息累加（thinking query + 回合挂钟 floor）。
- 最终 agent 回合摘要仍由 `feature/agent-summary` 独占（bash/read/edit/write/other）。
- mode 切回 `on`/`off` 后，assistant 与 tool 均恢复对应原生/default 渲染。

## 6. Working footer

与 default 相同，保留 Pi 原生 spinner，仅扩展文本：

```text
⠋ Working...
⠋ Working... (↓ 1,234 tokens · 12s)
```
