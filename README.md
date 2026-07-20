# pi-cc-extensions

> 借鉴了claude code tui 交互设计并结合了自己的喜好自定义扩展集合。

![预览](image/README/1784513908237.png)

## 扩展

- `extensions/claude-code-style.ts`：Claude Code 风格界面、Powerline 状态栏、工具调用摘要、Diff 预览及工作状态提示。
- `extensions/context.ts`：通过 `/context` 查看当前上下文窗口分布，并预览系统提示词、工具、上下文文件和 Skills。
- `extensions/session-reference/index.ts`：在提示词中使用 `@session:<session-id>` 引用历史 Session；输入 `@` 可从补全列表选择历史 Session。

## 本地开发

```bash
npm test
pi -e .
```

也可将当前仓库作为本地包安装：

```bash
pi install /absolute/path/to/pi-cc-extensions
```

修改扩展后，在 Pi 中执行 `/reload`。

## Git 安装

本仓库地址：<https://github.com/minuque/pi-cc-extensions>

安装主分支：

```bash
pi install git:github.com/minuque/pi-cc-extensions
```

固定到已发布的 `v0.1.0` 标签：

```bash
pi install git:github.com/minuque/pi-cc-extensions@v0.1.0
```

## 发布检查

```bash
npm test
npm pack --dry-run
```
