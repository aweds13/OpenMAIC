"""五层对齐检查（护栏）：intention → spec(含 conventions) → contracts → impl ← taste。

层级（本项目文档体系）：
  intention/        为什么做（N1–N46）
  specification/    必须做到什么（SR-F / SR-NF）+ conventions.md（横切约定）
  contracts/        怎样才算真的做成（interactions 操作闭环 / flows 动线）
  implementation/   哪个模块负责
  taste/            技术品味与红线

检查项：
1. 编号闭合：每个 N 都在 spec 追踪里被引用；每个 SR 都在 impl 追踪里有模块
   （支持范围简写 SR-F1.1~F1.9 / SR-NF1~NF5 / SR-NF6~NF8,NF13~NF15）。
2. 词表护栏：留「已砍概念」则失败；但否定语境（如"不设目标实体"）豁免。
3. 约定层存在性：conventions.md 必须存在，且其规则条目须标注来源 N。
4. 契约层存在性与覆盖：interactions.md / flows.md 必须存在；
   contracts 中引用的 SR 须能在 specification 中找到。
5. 引用完整性：文档中引用的 docs 内相对路径必须真实存在；
   被 git 忽略的产物路径（如 gates/diag/ 下的过程文件，不随树分发）跳过存在性检查，
   只打印一行说明 —— 判据问 git（check-ignore），不硬编码目录名（T-G127）。
6. 覆盖矩阵：coverage.md 存在、含 SR-F1~F10，且每域详细规格/契约文件存在。

用法：python scripts/check_layers.py [--root <路径>]
      `--root` 换一棵树来查（默认 = 本脚本所在仓库根）—— 自检拿它在临时目录里喂
      合成坏样例，**真实仓库一个字节都不写**。
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple

# 真仓库根：这份脚本所在仓库的根。★ `git` 永远在它下面问（口径见 is_git_ignored）。
ROOT = Path(__file__).resolve().parent.parent


class LayerPaths(NamedTuple):
    """一棵「五层文档树」的全部落点（默认真仓库根，`--root` 可换成合成小树）。"""

    root: Path
    intention: Path
    spec_trace: Path
    impl_trace: Path
    conventions: Path
    contracts: Path
    interactions: Path
    flows: Path
    coverage: Path
    spec_domains: Path
    contract_domains: Path


def layer_paths(root: Path | str | None = None) -> LayerPaths:
    """按给定根算出五层检查用到的每一个路径 —— 全部门路都从这一个根派生。

    不给 `root` = 真仓库根：与加 `--root` 之前的行为逐字一致。
    """
    base = Path(root).resolve() if root is not None else ROOT
    contracts = base / "docs" / "contracts"
    return LayerPaths(
        root=base,
        intention=base / "docs" / "intention" / "needs.md",
        spec_trace=base / "docs" / "specification" / "traceability.md",
        impl_trace=base / "docs" / "implementation" / "traceability.md",
        conventions=base / "docs" / "specification" / "conventions.md",
        contracts=contracts,
        interactions=contracts / "interactions.md",
        flows=contracts / "flows.md",
        coverage=base / "docs" / "implementation" / "coverage.md",
        spec_domains=base / "docs" / "specification" / "domains",
        contract_domains=contracts / "domains",
    )


PATHS = layer_paths(ROOT)

# 兼容旧写法：模块级常量仍指向真仓库根（外部引用照旧，公共面不变）。
INT = PATHS.intention
SPEC_TRACE = PATHS.spec_trace
IMPL_TRACE = PATHS.impl_trace
CONVENTIONS = PATHS.conventions
CONTRACTS = PATHS.contracts
INTERACTIONS = PATHS.interactions
FLOWS = PATHS.flows
COVERAGE = PATHS.coverage
SPEC_DOMAINS = PATHS.spec_domains
CONTRACT_DOMAINS = PATHS.contract_domains

FORBIDDEN = ["目标实体", "时间折算", "折算成", "学期分账", "Assigned to me"]
NEG = ["不", "无", "砍", "去", "免", "禁", "避免", "杜绝", "不要", "不设"]

N_RE = r"\bN\d+\b"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore") if path.exists() else ""


def extract_n(text: str) -> set[str]:
    return set(re.findall(N_RE, text))


def extract_srs(text: str) -> set[str]:
    """提取 SR 引用，展开范围简写（SR-F1.1~F1.9 / SR-NF1~NF5 / SR-NF6~NF8,NF13~NF15）。"""
    srs: set[str] = set()
    # 范围 F：SR-F{d}.{a}~F{d}.{b}
    for m in re.finditer(r"SR-F(\d+)\.(\d+)~F\d+\.(\d+)", text):
        for i in range(int(m.group(2)), int(m.group(3)) + 1):
            srs.add(f"SR-F{m.group(1)}.{i}")
    # 范围 NF：SR-NF{a}~NF{b}
    for m in re.finditer(r"SR-NF(\d+)~NF(\d+)", text):
        for i in range(int(m.group(1)), int(m.group(2)) + 1):
            srs.add(f"SR-NF{i}")
    # 单项 F / NF
    for m in re.finditer(r"SR-F(\d+)\.(\d+)", text):
        srs.add(f"SR-F{m.group(1)}.{m.group(2)}")
    for m in re.finditer(r"SR-NF(\d+)", text):
        srs.add(f"SR-NF{m.group(1)}")
    return srs


def forbidden_hits(text: str) -> list[str]:
    hits: list[str] = []
    for kw in FORBIDDEN:
        for m in re.finditer(re.escape(kw), text):
            pre = text[max(0, m.start() - 8): m.start()]
            if any(neg in pre for neg in NEG):
                continue
            hits.append(kw)
    return hits


def is_git_ignored(path: Path, base: Path | None = None) -> bool:
    """问 git：这个路径是否被忽略（T-G127）。

    语义是「这条**仓库相对路径**会不会被 gitignore」，所以 `git` 一律在**真仓库根**
    （`ROOT`）问；只是问之前先把路径化成仓库相对：
      ① 先按调用方给的那棵树 `base`（`--root`，默认真仓库根）化 —— 合成小树里的
         `<tmp>/gates/diag/x.md` ⇒ 问 git 的就是 `gates/diag/x.md`；
      ② 不在 `base` 下却在真仓库根下的，按真仓库根化。

    check-ignore 退出码：0 = 忽略 / 1 = 未忽略 / 其余 = 出错。
    出错时按「未忽略」处理（从严）：宁可多报一条断链，也不悄悄放过真断链。
    """
    rel: str | None = None
    for candidate_base in (base, ROOT):
        if candidate_base is None:
            continue
        try:
            rel = str(path.relative_to(candidate_base))
            break
        except ValueError:
            continue
    if rel is None:
        rel = str(path)
    p = subprocess.run(
        ["git", "check-ignore", "-q", "--", rel],
        capture_output=True, cwd=str(ROOT),
    )
    return p.returncode == 0


def check_link_integrity(root: Path | None = None) -> tuple[list[str], list[str], int]:
    """检查 docs 内文档引用的相对路径是否真实存在。

    路径可能相对「当前文档」或相对「docs/ 根」书写（两种约定都常见），
    故对每个候选路径依次尝试多个基准目录，命中其一即算通过。
    已显式声明"待建/不存在"的目标（见 known_missing）豁免。
    绝对路径（项目外引用，如引上一项目的 TASTE）不属本检查范围，豁免。
    被 git 忽略的产物（gitignored，不随 worktree 分发，如 gates/diag/ 的过程文件）
    跳过存在性检查，只记一行说明 —— 判据问 git，不硬编码目录名（T-G127）。

    ★ 卡 159（T-G259 / INV-37）：判据要能**证明它看得到东西** ——
      ① 返回值多了第三位 `checked`（这次**实际检查**的引用条数），门的输出要打出来；
      ② 接受 `root` 参数（自检喂合成坏样例：中文文件名断链必须被抓 ——
         老的正则漏中文路径那种「对中文视而不见」，用这条钉住）。

    返回（problems, notes, checked）：problems 是断链，notes 是 gitignored 跳过说明，
    checked 是实际核对过的引用条数（豁免 URL/绝对路径/待建之后仍数进去的）。

    `root` 换一棵树（默认 = 真仓库根）：路径与输出里的相对路径都从它派生 ——
    喂合成小树时不会 `relative_to` 到真仓库根上去（那会 ValueError）。
    """
    base = Path(root).resolve() if root is not None else ROOT
    known_missing = {"DESIGN.md", "LEARN.md"}  # 文档中已标注为"待建"，不算断链
    problems: list[str] = []
    notes: list[str] = []
    checked = 0
    docs_root = base / "docs"
    # 匹配反引号内的 .md 路径（支持中文文件名；相对当前文档 / docs 根 / 仓库根三种写法）
    pattern = re.compile(r"`([^\s`]*?\.md)`")
    for md in docs_root.rglob("*.md"):
        text = read(md)
        for m in pattern.finditer(text):
            rel = m.group(1)
            # 豁免：URL、绝对路径（含盘符）、待建文件
            if rel.startswith(("http", "/")) or re.match(r"^[A-Za-z]:[\\/]", rel):
                continue
            if Path(rel).name in known_missing:
                continue
            checked += 1
            # 多基准尝试：相对当前文档 / 相对 docs 根 / 相对仓库根
            candidates = [
                (md.parent / rel).resolve(),
                (docs_root / rel).resolve(),
                (base / rel).resolve(),
            ]
            # 裸文件名（无目录分隔）时，在 docs 下递归查找同名文件
            if "/" not in rel and "\\" not in rel:
                candidates += [p.resolve() for p in docs_root.rglob(rel)]
            if not any(c.exists() for c in candidates):
                # gitignored 产物：不随树分发，worktree 里必然没有 → 跳过（T-G127）
                if any(is_git_ignored(c, base) for c in candidates):
                    notes.append(
                        f"跳过 gitignored 产物引用: {md.relative_to(base)} → {rel}"
                    )
                    continue
                problems.append(f"{md.relative_to(base)} 引用了不存在的 {rel}")
    return problems, notes, checked


def main(root: Path | str | None = None) -> int:
    """检查一棵「五层文档树」；`root` 不给 = 真仓库根。

    命令行 `--root <路径>` 换树（自检喂合成小树用）；公共面 `main()` 不变。
    """
    ok = True
    p = layer_paths(root)

    # --- 1. 编号闭合 ---
    n_ids = extract_n(read(p.intention))
    spec_n_refs = extract_n(read(p.spec_trace))
    spec_srs = extract_srs(read(p.spec_trace))
    impl_srs = extract_srs(read(p.impl_trace))

    missing_n = {n for n in n_ids if n not in spec_n_refs}
    if missing_n:
        print(f"[FAIL] N 未在 spec 追踪被引用: {sorted(missing_n, key=lambda s: int(s[1:]))}")
        ok = False

    missing_sr = spec_srs - impl_srs
    if missing_sr:
        print(f"[FAIL] SR 未在 impl 追踪有模块: {sorted(missing_sr)}")
        ok = False

    # --- 2. 词表护栏 ---
    for path in (p.intention, p.spec_trace, p.impl_trace):
        hits = forbidden_hits(read(path))
        if hits:
            print(f"[FAIL] 已砍概念残留 {path.name}: {hits}")
            ok = False

    # --- 3. 约定层存在性 + 来源 N 标注 ---
    conv_text = read(p.conventions)
    if not conv_text:
        print("[FAIL] 约定层缺失: docs/specification/conventions.md")
        ok = False
    else:
        rule_lines = [
            (i + 1, ln) for i, ln in enumerate(conv_text.splitlines())
            if ln.strip().startswith("- ") and not ln.strip().startswith("- *")
        ]
        unlabeled = [(i, ln) for i, ln in rule_lines if not extract_n(ln)]
        if unlabeled:
            n = len(unlabeled)
            # ★ 报**行号**而不是只报一条示例（T-G52）：这条红每次都是"我新写的规则忘了标来源"，
            #   而原来的输出只说"有 1 条未标注 + 前 40 个字"，还得自己去文件里找 —— 白花两分钟。
            print(f"[FAIL] 约定层有 {n} 条规则未标注来源 N：")
            for i, ln in unlabeled[:5]:
                print(f"         conventions.md:{i}  {ln.strip()[:70]}")
            if n > 5:
                print(f"         …另有 {n - 5} 条")
            ok = False

    # --- 4. 契约层存在性与 SR 可追溯 ---
    for contract in (p.interactions, p.flows):
        if not contract.exists():
            print(f"[FAIL] 契约层缺失: {contract.relative_to(p.root)}")
            ok = False
    if p.interactions.exists() and p.flows.exists():
        contract_text = read(p.interactions) + read(p.flows)
        contract_srs = extract_srs(contract_text)
        unknown = contract_srs - spec_srs - impl_srs
        if unknown:
            print(f"[FAIL] 契约层引用了 specification 中不存在的 SR: {sorted(unknown)}")
            ok = False

    # --- 5. 引用完整性 ---
    broken, skipped_gitignored, checked_refs = check_link_integrity(p.root)
    # ★ 卡 159（INV-37）：打出「这次实际检查了几条引用」—— 判据要证明它看得到东西
    print(f"[info] 引用完整性：这次实际检查了 {checked_refs} 条引用（断链 {len(broken)} 处）")
    for s in skipped_gitignored:
        print(f"[skip] {s}")
    if broken:
        for b in broken[:10]:
            print(f"[FAIL] 引用断裂: {b}")
        if len(broken) > 10:
            print(f"       …等共 {len(broken)} 处")
        ok = False

    # --- 6. 覆盖矩阵 ---
    cov_text = read(p.coverage)
    if not cov_text:
        print("[FAIL] 覆盖矩阵缺失: docs/implementation/coverage.md")
        ok = False
    else:
        for i in range(1, 11):
            sr = f"SR-F{i}"
            if sr not in cov_text:
                print(f"[FAIL] 覆盖矩阵缺 {sr}")
                ok = False
            if not list(p.spec_domains.glob(f"F{i}-*.md")):
                print(f"[FAIL] 缺详细规格: docs/specification/domains/F{i}-*.md")
                ok = False
            if not list(p.contract_domains.glob(f"F{i}-*.md")):
                print(f"[FAIL] 缺域契约: docs/contracts/domains/F{i}-*.md")
                ok = False

    print("LAYER CHECKS:", "PASS ✅" if ok else "FAIL ❌")
    return 0 if ok else 1


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """命令行接口：`--root` 换一棵树（默认 = 真仓库根，行为与老版一致）。"""
    parser = argparse.ArgumentParser(
        description="五层对齐检查（intention → specification(+conventions) → contracts → "
                    "implementation ← taste）"
    )
    parser.add_argument(
        "--root",
        default=None,
        help="查哪棵树（默认 = 本脚本所在仓库根）。自检拿它在临时目录里搭合成小树喂坏样例，"
             "真实仓库一个字节都不写。",
    )
    return parser.parse_args(argv)


if __name__ == "__main__":
    sys.exit(main(parse_args().root))
