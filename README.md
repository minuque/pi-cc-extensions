<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="pi-cc-extensions：为 Pi 提供 Claude Code 风格界面、上下文可视化和历史 Session 引用">
</p>

<p align="center">
  一组面向 Pi coding agent 的个人扩展 · <a href="https://github.com/minuque/pi-cc-extensions">查看源码</a>
</p>

## 预览

真实运行截图：

<p align="center">
  <img src="./assets/readme/showcase.webp" width="100%" alt="Pi 终端中的 Claude Code 风格扩展界面，包含工具调用摘要、Diff 预览、Powerline 状态栏和上下文信息">
</p>

## 包含什么

### Claude Code 风格界面

`extensions/claude-code-style.ts` 提供：

- Claude Code 风格的工具调用行与结果摘要
- Powerline 状态栏和工作状态提示
- Edit / Write 的 Diff 预览
- 工具结果的折叠与展开
- `/ccstyle` 配置命令和 `Ctrl+Shift+O` 快捷键

常用命令：

```text
/ccstyle             # 切换开关
/ccstyle status      # 查看状态
/ccstyle compact     # 紧凑摘要
/ccstyle minimal     # 最小化输出
/ccstyle powerline   # 查看 Powerline 预设
```

### 上下文窗口查看

`extensions/context.ts` 注册 `/context`，展示当前上下文窗口的使用分布，并可进一步预览：

- System prompt
- Tools
- Context files
- Skills
- User / assistant messages
- Tool results
- Compaction summaries

### 历史 Session 引用

`extensions/session-reference/index.ts` 将历史 Session 接入 `@` 补全：

1. 在提示词中输入 `@`。
2. 从 `[Session] ...` 补全项中选择历史 Session。
3. 提交时以 `@session:<session-id>` 引用其当前有效上下文。

一次提示词可以引用多个 Session；扩展会自动去重，并限制注入规模以避免上下文无限膨胀。更多细节见 [`extensions/session-reference/README.md`](./extensions/session-reference/README.md)。

## 快速开始

### 从 Git 安装

```bash
pi install git:github.com/minuque/pi-cc-extensions@v0.1.0
```

安装后启动 Pi，即可使用上述扩展。更新到主分支版本：

```bash
pi install git:github.com/minuque/pi-cc-extensions
```

### 第一次使用

```text
/context
/ccstyle status
```

修改扩展后，在 Pi 中执行：

```text
/reload
```

## 本地开发

```bash
npm test
pi -e .
```

也可以把当前仓库作为本地 Pi 包安装：

```bash
pi install /absolute/path/to/pi-cc-extensions
```

## 兼容性

- Node.js `>=22.19.0`
- 作为 Pi package 加载，入口由根目录 `package.json` 的 `pi.extensions` 显式声明

## 发布检查

```bash
npm test
npm pack --dry-run
```
