# 工具 Render 示例（ccstyle · default）

> 由真实 renderer 驱动生成的示例快照，已剥离 ANSI。
> 实际 TUI 中包含状态色、背景色和 hover 高亮；Braille loading 帧会随时间变化。
> 当前版本：ccstyle 0.9.4 · mode=`on`。
> renderer 变更后请运行 `npm run docs:tool-render` 同步本文件。

## 1. 运行态 / 完成态 / 失败态

```text
 ⠦ Bash rg -n 'renderCall' extensions/ --type ts

 ✓ Bash rg -n 'renderCall' extensions/ --type ts
   ↳ 2 lines returned • click to show more

 ✗ Read missing.ts
   ↳ ENOENT: no such…en 'missing.ts' • click to show more
```

- 运行中：call 行使用 Braille 转轮。
- 完成/失败：`✓` / `✗`；结果行缩进 3 格（`   ↳`）。
- 可展开结果附带 `click to show more`（fullscreen 文案）。

## 2. read 参数详情

```text
 ✓ Read extensions/index.ts (offset=10, limit=50)
   ↳ 40 lines loaded • click to show more
```

## 3. 单工具展开（Input/Output 树）

```text
 ✓ Bash rg -n 'renderCall' extensions/
 ├ Input
 │ command: rg -n 'renderCall' extensions/
 │
 └ Output
   extensions/renderer/default-mode.ts:300:
   renderCall(args, theme,
   context) {
```

Input/Output 之间有一个空白 rail 行（`│`）。展开最外层卡片上下左右内间距各 1 格（内容贴左，由 Box padding 提供）。

## 4. edit/write rich diff

```text
 ✓ Edit sample.ts
   ↳ diff • +2 • -1 • unified [━━━━━━━━]
 ─────────────────────────────────────────────
 @@ -1,3 +1,4 @@
    1 │ import { run } from "./runner";
 ▌  2 │ const threshold = 41;
 ▌  2 │ const threshold = 42;
    3 │ export default run;
 ▌  4 │ export const version = "0.8.30";
 ─────────────────────────────────────────────
```

长 diff 提示：

```text
… (79 more diff lines • click to show more)
```

- hover `click to show more` 时由 muted 切换为白色 text。
- 点击提示展开工具，展开态 diff 全量显示，不再截断。
- 折叠态 diff 行数提示为 muted 色。

write 新建 / 覆盖：

```text
↳ created
────────────────────────────────────────────────────────────────────────
▌  1 │ const x = 1
────────────────────────────────────────────────────────────────────────

↳ overwritten
────────────────────────────────────────────────────────────────────────
▌  1 │ const y = 2
▌  1 │ const x = 1
────────────────────────────────────────────────────────────────────────
```

## 5. Task 系列

```text
 ✓ Task List task list
   ↳ 3 tasks • 1 … 1 completed • click to show more
 ↳ 3 tasks • 1 in progress • 1 pending • 1 completed
   #1 in_progress 重构 renderer
   #2 pending 补充测试
   #3 completed 发布 0.8.29

 ✓ Task Create 重构 renderer
 ↳ Created task #1 重构 renderer

 ✓ Task Execute 1 (+2 tasks)
 ↳ Started Tasks #1, #2, #3

 ✓ Task Update 3
 ↳ Updated task #3 发布 0.8.29

 ✓ Task Stop 1
 ↳ Stopped Task #1

 ✓ Task Get 3
   ↳ 2 lines returned • click to show more

 ✓ Task Output 1
   ↳ 2 lines returned • click to show more
```

## 6. Agent 家族

```text
 Agent                                            ← Agent 有专用 renderer：无状态图标
 {
   "description": "探活 subagent",
   "prompt": "…",
   "subagent_type": "explore",
   "run_in_background": true
 }
 Agent started in background.
 Agent ID: 7d535698-4ad6-47a

 ✓ Get Subagent Result 7d535698-4ad6-47a
   ↳ 4 lines returned • click to show more

 ✓ Steer Subagent 7d535698-4ad6-47a
   ↳ 1 line returned • click to show more

 ✓ Agents 并行调研
   ↳ 1 line returned • click to show more
```

## 7. 外部工具

```text
 ✓ Skill ponytail
   ↳ 1 line returned • click to show more

 ✓ Enter Plan Mode enable read-only planning
   ↳ 1 line returned

 ✓ Exit Plan Mode present plan
   ↳ 3 lines returned • click to show more

 ✓ Web Search pi coding agent extension
   ↳ 3 lines returned • click to show more

 ✓ Fetch Content https://example.com
   ↳ 1 line returned • click to show more
```

- Enter Plan Mode 短结果可能无 `click to show more`。

## 8. MCP / 自定义工具

```text
 ✓ MCP call github_search_code {"query":"pi"}
   ↳ 1 line returned • click to show more

 ✓ MCP list chrome-devtools
   ↳ 1 line returned • click to show more

 ✓ MCP search screenshot (regex)
   ↳ 1 line returned • click to show more

 ✓ MCP Script emit(1)
   ↳ 1 line returned • click to show more

 ✓ mcp__github_search_code pi
   ↳ 1 line returned • click to show more

 ✓ Custom Translate {"text":"hi"}
   ↳ 1 line returned • click to show more
```

网关的标题沿用 mcp-adapter 自己的 `mcp <动作> <目标>` 风格（`list` / `search` / `describe` / `call` / `connect` / `status`），内层工具入参跟其他载荷一样用 dim 接在后面；开关类参数（`regex` / `includeSchemas`）作为 dim 附注。具体工具的标题用 adapter 暴露的真实工具名（如 `mcp__github_search_code`），入参先走字段链（`query` / `url` / `command` / `path` …），字段链认不出的键（命名空间代理的 `tool`+`args`、第三方自定义键）回退完整入参 JSON；入口两个跟普通工具一样人性化：`MCP` / `MCP Script`。超过卡片宽度与 Input clip 的部分尾部截断。

## 9. 工具组（tool-grouping）

### 收起：运行中

```text
 ● Multiple Tools: 3 running • read, bash, ffgrep • click to show more
 ├ ⠧ Read extensions/index.ts
 ├ ⠧ Bash npm test
 └ ⠧ Ffgrep "renderCall" in extensions/
```

### 收起：完成/失败

```text
 ● Multiple Tools: 2 done • 1 failed • read, bash, ffgrep • click to sh…
 ├ ✓ Read extensions/index.ts
 ├ ✓ Bash npm test
 └ ✗ Ffgrep "renderCall" in extensions/
```

### 展开：完整背景卡片

```text
 ● Multiple Tools: 2 done • 1 failed • read, bash, ffgrep • click to sh…
 ├ ✓ Read extensions/index.ts
 │ ├ Input
 │ │ path: extensions/index.ts
 │ │
 │ └ Output
 │   L0
 │   L1
 │   L2
 │   L3
 │   L4
 │   L5
 │   L6
 │   L7
 │   L8
 │   L9
 │   … +30 more lines • click to show more
 ├ ✓ Bash npm test
 │ ├ Input
 │ │ command: npm test
 │ │
 │ └ Output
 │   pass 79/79
 └ ✗ Ffgrep "renderCall" in extensions/
   ├ Input
   │ path: extensions/
   │ pattern: renderCall
   │
   └ Output
     no match
```

ANSI 剥离后无法展示背景，实际 TUI 行为如下：

- 组头始终使用状态色圆点 `●`。
- 内部工具使用 `✓`、`✗` 或 Braille loading spinner。
- 展开区统一绘制完整状态背景，左右和底部各 1 格 padding，无顶部 padding。
- 外层树在收起/展开时位置不变；Input/Output 树线与上方状态图标对齐。
- Input/Output 之间各有一个空白 rail 行。
- 点击展开区任意行、任意列（含底部 padding）均可收起。
- 组末尾不再额外追加空白行。

## 10. Working footer

保留 Pi 原生 spinner，仅扩展文本：

```text
⠋ Working...
⠋ Working... (↓ 1,234 tokens · 12s)
```

- 流式阶段按文本字符数 `/ 4` 估算 token。
- provider 提供 `usage.output` 时优先使用真实值。
- 支持多文本块、`text_end`/`done`/`error` 校准和跨 turn 重置。
- turn 结束后立即恢复默认状态，不显示 `✻ Turn took ...`。
