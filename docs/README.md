# docs/ —— 五层文档

> 这个目录是**产品的真身**：做了什么、为什么这么做、以及怎么验证它真的做到了。
> 仓根的 `AGENTS.md` 是**规则层**（怎么改不出错），不是这里的内容。

## 为什么分五层

一份文档只能服务一个读者，混着写必然有人要跳读。所以按**读者**切，不按主题切：

| 层 | 目录 | 读者想知道的 | 一句话 |
|---|---|---|---|
| 意图 | `intention/` | **为什么要有这东西** | 需求 N1–N23，一条一句，不写实现 |
| 规格 | `specification/` | **什么算做对了** | 十域 F1–F10，每条 SR 能判真假 |
| 契约 | `contracts/` | **两边怎么对上** | 操作 OP-1~6、流程 FLOW-1~4、逐域验收 |
| 实现 | `implementation/` | **代码长什么样、怎么跑** | 模块地图、覆盖矩阵、架构图、运维、自检 |
| 品味 | `taste/` | **往上取的东西** | 判断力：哪些事宁可不做 |

**编号规则**（跨层唯一，别自造）：
- `N1–N23` 需求，只在 `intention/needs.md` 定义
- `SR-F{n}.{m}` 规格条款，`n` 是域号、`m` 是序号，在 `specification/domains/` 定义
- `OP-n` 操作、`FLOW-n` 流程，在 `contracts/` 定义
- `M1–M13` 模块，在 `implementation/modules.md` 定义

## 三条硬规矩

1. **一层只回答一个读者的问题。** 规格层不写文件名和函数名，实现层不复述需求。
2. **每条结论要有判据落点。** 没自动化判据就老实写「人工核对方式：…」，不许拿「实现上应该没问题」充当证据。
3. **删掉过时的话，不要打补丁。** 上游在动，留一堆「曾在此处」只会让人读错。历史在 git 里。

## 从哪儿开始读

- **刚接手、不知道这项目要干嘛** → `intention/needs.md`
- **要判断一个改动算不算完成** → `specification/traceability.md` 找到对应的 SR，再查 `implementation/coverage.md` 看它有没有判据
- **要改代码** → `implementation/modules.md`（先看你改的是哪一层）
- **要起服务 / 跑生产构建 / 建 worktree** → `implementation/运维.md`
- **要改文档** → `文档架构.md`（这一份讲这五层自己怎么维护）

## 维护

改完代码后固定四步（详见 `AGENTS.md` §3.1）：

```
node node_modules/prettier/bin/prettier.cjs --write <改过的文件>   # 只管代码，*.md 它不看
npx tsc --noEmit
node scripts/check-i18n-keys.mjs
python -X utf8 scripts/check-layers.py     # ← 这个目录自己的门禁
```

★ 第一步对本文档**不管用**：`.prettierignore` 有 `*.md` ⇒ `--check` 恒绿，写坏了也不报。文档的判据是最后一条与人眼。

最后一条会检查：需求编号闭合、规格条款都能追溯到需求、约定层的每条规则都标了来源、契约层文件齐全、反引号里的 md 文件名引用都真实存在、覆盖矩阵包含全部十域。末行 `LAYER CHECKS: PASS ✅` 才算数。

**新写一份文档时最容易踩的坑**：不要在 `docs/` 里用反引号包通配符。检查器 `scripts/check-layers.py` 用正则把所有反引号里的 md 文件名当真实引用，一个星号就会让你多一条断链 —— 写这份 README 时就现场撞了一次。要举通配符的例子，用不带反引号的行内文字写：F 加星号加 .md。
