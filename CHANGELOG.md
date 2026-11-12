# Changelog

## [1.0.17]

适配 pi 1.5.x。
Pi 1.5.x compatibility.

### 变更 / Changed

- `Ctrl+O` 让位：对话区有可展开的 `!` / `!!` 命令输出时，展开键交回 pi 收起或展开命令行输出；其余情况仍打开会话浏览层。
  `Ctrl+O` yields: when the conversation has an expandable `!` / `!!` command output, the expand key goes back to pi to collapse or expand that output; otherwise it still opens the transcript browser.
- 标准 ```mermaid 交给 pi 内置渲染器（1.5.1 起支持饼图、自定义样式、可点击标签，并会画在展开的 summary 里）。插件只接管 `statediagram`、`classdiagram`、`erdiagram`、`sequencediagram` 这类方言 fence。
  Plain ```mermaid blocks go back to pi's built-in renderer, which draws pie charts, custom styles and clickable labels since 1.5.1, and also draws inside expanded summaries. The plugin only takes dialect fences such as `statediagram`, `classdiagram`, `erdiagram` and `sequencediagram`.
- Markdown 转换新增 `custom` 与 `summary` 两个作用面：自定义消息和展开的 summary 里，圈数字与方言图不再变回原样。
  Markdown conversion also runs on `custom` and `summary`: circled numbers and dialect diagrams no longer revert to raw text there.
- 按键提示改用 pi 注入的按键管理器与 `keyText()`：`keybindings.json` 里的自定义绑定在启动头、工具卡提示和浏览层里都能正确显示。
  Key hints now read pi's injected keybinding manager and `keyText()`, so bindings from `keybindings.json` show up correctly in the startup header, tool-card hints and the transcript browser.
- `/ccstyle` 面板与 `/context` 弹层报告「等待用户输入」（OSC 7501）；面板内切换 ❯ 前缀立即生效，不再等面板关闭。
  The `/ccstyle` panel and the `/context` overlay report "waiting for user input" (OSC 7501), and switching the ❯ prefix inside the panel takes effect at once instead of after it closes.
- 开发依赖对齐 pi 1.5.2，`typecheck` 与测试不再对着 1.1.0 的类型运行。
  Dev dependencies align with pi 1.5.2, so `typecheck` and the tests no longer run against 1.1.0 types.
- 新增 `footerContextLimit`：上下文芯片分母可选完整窗口（`window`，默认）、Pi 的自动压缩触发点（`compaction`）或两者兼显（`both`）。
  New `footerContextLimit`: the context chip denominator can be the full window (`window`, default), Pi's auto-compaction point (`compaction`), or both (`both`).

### 修复 / Fixed

- 方言 fence 的正文自带类型头时不再重复补 fence 名：重复头会让 grok-mermaid 解析失败退成源码框，或把类型头画成一个节点。
  A dialect fence body that already carries its type header no longer gets a second one: the duplicate made grok-mermaid fail and fall back to a source box, or drew the header as a node.
- README 的兼容性与全屏启动方式更正为 Pi `^1.5.1` 和 `--tui-mode fullscreen`。
  README compatibility and fullscreen launch corrected to Pi `^1.5.1` and `--tui-mode fullscreen`.
