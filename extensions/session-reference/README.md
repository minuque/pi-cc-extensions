# Session Reference

在 pi 编辑器中输入 `@`，从统一补全列表选择 `[Session] ...`，即可把历史 Session 绑定为：

```text
@session:<session-id>
```

提交 prompt 时，扩展读取该 Session 当前有效分支（遵循分支与 compaction），以自定义上下文消息注入当前 Session。历史内容被标记为不可信背景上下文，不会切换或合并 Session。

## 行为

- 搜索全部 pi 历史 Session；当前 Workspace 的 Session 优先。
- Session 模糊查询默认最多显示 3 个候选。
- 与 pi 原有 `@` 文件补全并存：普通查询按 1:2 交错排列 Session 与文件，路径型查询优先显示文件。
- 若已加载 `pi-subagents`，`@` 补全会同时显示现有 SubAgent，并引用其当前有效上下文。
- 支持一个 prompt 引用多个 Session，并自动去重；单次最多注入前 5 个。
- 跳过历史 Session 中嵌套的 Session 引用，避免递归膨胀。
- 上下文限制：单条消息 8 KB、单 Session 24 KB、总计 48 KB；超限保留开头和结尾。
- 选择后仅插入引用标记；真正读取和注入发生在提交 prompt 时。

项目扩展可通过 `/reload` 热重载。

## 验证

```bash
node --test .pi/extensions/session-reference/core.test.ts
```
