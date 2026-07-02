#!/usr/bin/env python3
"""
audit.py
========
根据 extract_checklist.py 生成的 checklist.json，按要求逐条核验
iceland/ 目录下的签证材料，输出审核报告。

设计原则：
- 严格只读用户材料 (iceland/)，只在 audit/ 目录内写输出
- 关键字匹配为主（基于 extract_checklist 的 match_keywords）
- --llm 开启后，对匹配到的 PDF 抽文本送 LLM 二次确认内容
- 报告输出 audit/report.md

用法:
    python3 audit/audit.py                              # 仅文件名匹配
    python3 audit/audit.py --llm                        # 加 LLM 内容验证
    python3 audit/audit.py --materials iceland/ \
        --checklist audit/checklist.json \
        --output audit/report.md
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterable

# pdfplumber 在解析含中文字体的 PDF 时会刷 FontBBox warning，噪音过大，关掉
logging.getLogger("pdfminer").setLevel(logging.ERROR)
logging.getLogger("pdfplumber").setLevel(logging.ERROR)

import pdfplumber  # noqa: E402


# ---------------------------------------------------------------------------
# 共享 / 申请人 目录识别
# ---------------------------------------------------------------------------
SHARED_FOLDERS = {
    "accommodation", "flights", "car-rental", "tours", "insurance",
    "transport", "hotel", "hostel", "camping",
}

# 个人材料的特征文件名（出现其一即认为是申请人目录）
PERSONAL_DOC_HINTS = {
    "passport", "id-card", "hukou", "employment-letter",
    "bank-statement", "consent-letter", "visa-application",
    "driving-license", "business-license",
}


def detect_applicants(materials_dir: Path) -> list[str]:
    """
    自动识别申请人子目录。
    启发式：子目录不匹配 SHARED_FOLDERS，且递归子文件命中任一 PERSON_DOC_HINT。
    """
    out: list[str] = []
    for sub in sorted(materials_dir.iterdir()):
        if not sub.is_dir() or sub.name.startswith("."):
            continue
        if sub.name in SHARED_FOLDERS:
            continue
        if any(
            hint in f.name.lower()
            for f in sub.rglob("*") if f.is_file()
            for hint in PERSONAL_DOC_HINTS
        ):
            out.append(sub.name)
    return out


# ---------------------------------------------------------------------------
# 文件匹配
# ---------------------------------------------------------------------------
def file_matches(file: Path, keywords: list[str]) -> bool:
    """
    文件名（含后缀）或其父目录名小写化后，是否包含任一 keyword。
    例：keywords=["flight"], file=flights/faroe-to-iceland.pdf → 父目录 "flights" 命中。
    """
    name = file.name.lower()
    if any(kw.lower() in name for kw in keywords):
        return True
    for parent in file.parts[:-1]:
        if any(kw.lower() in parent.lower() for kw in keywords):
            return True
    return False


def list_files(scope: Path) -> list[Path]:
    """列出 scope 下所有文件（不含隐藏）。"""
    return [p for p in scope.rglob("*") if p.is_file() and not p.name.startswith(".")]


def find_matches(scope: Path, keywords: list[str]) -> list[Path]:
    """在 scope 下找出所有文件名匹配任一 keyword 的文件。"""
    return [f for f in list_files(scope) if file_matches(f, keywords)]


IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff"}


def find_image_files(scope: Path) -> list[Path]:
    """列出 scope 下的图片文件。"""
    return [f for f in list_files(scope) if f.suffix.lower() in IMAGE_EXTS]


# ---------------------------------------------------------------------------
# LLM 推理（可选）
# ---------------------------------------------------------------------------
def llm_available() -> bool:
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False
    import os
    return bool(os.environ.get("ANTHROPIC_AUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY"))


def pdf_text_snippet(pdf_path: Path, max_chars: int = 2000) -> str:
    """从 PDF 抽前 1-2 页文字，截断到 max_chars。只用于本地核对，不上传文件。"""
    try:
        with pdfplumber.open(pdf_path) as pdf:
            txt = "\n".join((p.extract_text() or "") for p in pdf.pages[:2])
    except Exception as e:  # 损坏的 PDF 等
        return f"[PDF 读取失败: {e}]"
    return txt[:max_chars]


def llm_verify_document(
    requirement_text: str,
    pdf_path: Path,
    model: str,
) -> dict:
    """
    把 PDF 抽出的文本片段送给 LLM，让它判断「这份文档是否是所要求材料」。
    只发文本片段（不传文件二进制），且截断到 max_chars。
    返回 {"verdict": "YES"|"NO"|"UNCERTAIN", "reason": "..."}
    """
    import os
    import anthropic

    base_url = os.environ.get("ANTHROPIC_BASE_URL")
    auth_token = os.environ.get("ANTHROPIC_AUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY")

    client = anthropic.Anthropic(
        api_key=auth_token,
        base_url=base_url,
    )

    snippet = pdf_text_snippet(pdf_path)
    is_scanned = (len(snippet.strip()) < 30)
    if is_scanned:
        # 扫描件 PDF：文本抽不出来，LLM 看不到内容只能猜
        return {
            "verdict": "UNCERTAIN",
            "reason": "PDF 为扫描件，无可提取文字（建议人工核对）",
            "scanned": True,
        }

    msg = client.messages.create(
        model=model,
        max_tokens=300,
        system=(
            "你是一个签证材料审核助手。判断下面给出的文档文本片段（来自 PDF 前 2 页）"
            "是否对应所要求的材料类型。\n"
            "判定标准：\n"
            "- YES: 文本片段明确表明这份材料就是所要求的类别（申请表、护照、银行流水、保险单等）。\n"
            "- NO: 文本片段明确表明这是其他类别的材料（明显不是）。\n"
            "- UNCERTAIN: 文本片段信息不足、涉及金额/有效期等具体数字未在片段中出现、"
            "或材料类型需要全文才能判断。\n"
            "注意：你只看到了前 2 页文本，看不到完整文档。当不确定时优先 UNCERTAIN，不要轻易 NO。"
            "某些要求允许多种材料之一（如「在职证明 或 营业执照」），"
            "只要命中其一即可判为 YES。\n"
            "回答格式: 第一行 YES / NO / UNCERTAIN，第二行简短理由（不超过 30 字）。"
        ),
        messages=[{
            "role": "user",
            "content": (
                f"要求材料:\n{requirement_text}\n\n"
                f"文件路径: {pdf_path.name}\n"
                f"文件内容片段:\n{snippet}"
            ),
        }],
    )
    text = msg.content[0].text.strip() if msg.content else ""
    lines = text.splitlines()
    verdict = (lines[0].strip().upper() if lines else "UNCERTAIN")
    reason = lines[1].strip() if len(lines) > 1 else ""
    if verdict not in {"YES", "NO", "UNCERTAIN"}:
        verdict = "UNCERTAIN"
        reason = text[:60]
    return {"verdict": verdict, "reason": reason, "scanned": False}


# ---------------------------------------------------------------------------
# 审核主逻辑
# ---------------------------------------------------------------------------
@dataclass
class ItemResult:
    item_id: int
    description: str
    status: str  # PASS / FAIL / N/A / WARNING
    details: list[str] = field(default_factory=list)
    matched: list[Path] = field(default_factory=list)
    llm_checks: list[dict] = field(default_factory=list)


def first_line(text: str, n: int = 60) -> str:
    line = text.split("\n", 1)[0].strip()
    return line if len(line) <= n else line[:n] + "…"


def audit_item(
    item: dict,
    materials_dir: Path,
    applicants: list[str],
    use_llm: bool,
    model: str,
) -> ItemResult:
    res = ItemResult(
        item_id=item["id"],
        description=first_line(item["description"]),
        status="FAIL",
    )

    # 条件性条目
    if item["applies_to"] == "conditional":
        cond = item.get("condition")
        if cond == "minor_only":
            res.status = "N/A"
            res.details.append("未成年人专属材料，本批次申请人不适用")
            return res
        if cond == "volunteer_only":
            res.status = "N/A"
            res.details.append("志愿活动专属材料，本批次为旅游签证不适用")
            return res

    keywords = item["match_keywords"]
    if not keywords:
        res.status = "WARNING"
        res.details.append("无可用匹配关键词，跳过")
        return res

    # 决定搜索范围
    if item["applies_to"] == "per_applicant":
        per_applicant_matches: dict[str, list[Path]] = {}
        for app in applicants:
            app_dir = materials_dir / app
            if not app_dir.is_dir():
                per_applicant_matches[app] = []
                continue
            per_applicant_matches[app] = find_matches(app_dir, keywords)

        any_found = any(matches for matches in per_applicant_matches.values())
        all_found = all(matches for matches in per_applicant_matches.values())

        for app, matches in per_applicant_matches.items():
            if matches:
                rel = [str(m.relative_to(materials_dir)) for m in matches]
                res.details.append(f"✓ {app}: {len(matches)} 份 — {', '.join(rel)}")
            else:
                res.details.append(f"✗ {app}: 未找到匹配文件")
                # 软提示：申请人目录下还有哪些图片文件（可能即所需材料）
                app_dir = materials_dir / app
                imgs = find_image_files(app_dir)
                if imgs:
                    rel = [str(m.relative_to(materials_dir)) for m in imgs]
                    res.details.append(
                        f"  · 提示：{app} 目录下有 {len(imgs)} 张图片 — {', '.join(rel)}"
                    )

        res.matched = [m for ms in per_applicant_matches.values() for m in ms]

        if all_found:
            res.status = "PASS"
        elif any_found:
            res.status = "WARNING"  # 部分申请人有部分没有
        else:
            res.status = "FAIL"

    else:  # shared
        # 在 materials_dir 下搜索，但排除申请人子目录
        candidates = [
            f for f in list_files(materials_dir)
            if not any(part in applicants for part in f.relative_to(materials_dir).parts[:-1])
        ]
        matches = [f for f in candidates if file_matches(f, keywords)]
        # 额外：在共享子目录里找
        for sub in materials_dir.iterdir():
            if sub.is_dir() and sub.name in SHARED_FOLDERS:
                matches += [f for f in find_matches(sub, keywords) if f not in matches]

        # 去重
        seen = set()
        unique = []
        for m in matches:
            if m not in seen:
                seen.add(m)
                unique.append(m)
        matches = unique
        res.matched = matches

        if matches:
            rel = [str(m.relative_to(materials_dir)) for m in matches]
            res.details.append(f"✓ 找到 {len(matches)} 份 — {', '.join(rel)}")
            res.status = "PASS"
        else:
            res.details.append("✗ 未找到匹配文件")
            res.status = "FAIL"

    # LLM 二次验证
    if use_llm and res.matched:
        if not llm_available():
            res.details.append("[LLM] 不可用（缺 anthropic SDK 或 API key）")
        else:
            for pdf in res.matched[:3]:  # 限流：每条最多验证前 3 份
                if pdf.suffix.lower() != ".pdf":
                    continue
                try:
                    check = llm_verify_document(
                        requirement_text=item["description"][:1500],
                        pdf_path=pdf,
                        model=model,
                    )
                    res.llm_checks.append({"file": str(pdf.relative_to(materials_dir)), **check})
                    tag = "[LLM·扫描]" if check.get("scanned") else "[LLM]"
                    res.details.append(
                        f"{tag} {pdf.name} → {check['verdict']} ({check['reason']})"
                    )
                except Exception as e:
                    res.details.append(f"[LLM] {pdf.name} 调用失败: {e}")

            # 根据 LLM 结论调整状态
            # 只在有至少一个明确结论时调整；扫描件 (UNCERTAIN) 不算否定
            no_count = sum(1 for c in res.llm_checks if c["verdict"] == "NO")
            yes_count = sum(1 for c in res.llm_checks if c["verdict"] == "YES")
            unc_count = sum(1 for c in res.llm_checks if c["verdict"] == "UNCERTAIN")
            if no_count > 0 and yes_count == 0:
                res.status = "FAIL"
                res.details.append("[LLM] 警告：匹配到的文件经 LLM 核对均与要求不符")
            elif no_count > 0 and yes_count > 0:
                # 有 NO 也有 YES，混在一起时给 WARNING
                res.status = "WARNING"
            elif yes_count > 0:
                res.details.append(f"[LLM] 全部 {yes_count} 份 LLM 核对一致")
            elif unc_count > 0 and not no_count:
                res.details.append(f"[LLM] 共 {unc_count} 份为扫描件或无明确结论（建议人工核对）")

    return res


# ---------------------------------------------------------------------------
# 报告渲染
# ---------------------------------------------------------------------------
STATUS_ICON = {"PASS": "✅", "FAIL": "❌", "WARNING": "⚠️", "N/A": "➖"}


def render_report(
    checklist: dict,
    results: list[ItemResult],
    materials_dir: Path,
    applicants: list[str],
    use_llm: bool,
) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines: list[str] = []
    lines.append(f"# 签证材料审核报告\n")
    lines.append(f"- 生成时间: {now}")
    lines.append(f"- 材料目录: `{materials_dir}`")
    lines.append(f"- 签证类型: {checklist.get('visa_type', '?')}")
    lines.append(f"- 清单来源: `{checklist.get('source_pdf', '?')}`")
    lines.append(f"- 检测到申请人: {', '.join(applicants) if applicants else '(无)'}")
    lines.append(f"- LLM 二次核对: {'开启' if use_llm else '关闭'}")
    lines.append("")

    # 汇总
    counts = {"PASS": 0, "FAIL": 0, "WARNING": 0, "N/A": 0}
    for r in results:
        counts[r.status] = counts.get(r.status, 0) + 1
    lines.append("## 汇总")
    lines.append("")
    lines.append(f"| 状态 | 数量 |")
    lines.append(f"|---|---|")
    for k in ("PASS", "FAIL", "WARNING", "N/A"):
        lines.append(f"| {STATUS_ICON[k]} {k} | {counts[k]} |")
    lines.append(f"| **合计** | **{sum(counts.values())}** |")
    lines.append("")

    # 申请人个人材料
    personal = [r for r in results if r.item_id <= 11 and r.item_id != 4]
    # 1-3, 5, 7-11 是个人或行程；这里简单按 applies_to 字段筛
    # 重新用 checklist 里的 applies_to 字段判断（更准确）
    by_applies: dict[str, list[tuple[dict, ItemResult]]] = {
        "per_applicant": [], "shared": [], "conditional": [],
    }
    for item, res in zip(checklist["items"], results):
        by_applies[item["applies_to"]].append((item, res))

    for section, label in [
        ("per_applicant", "👤 申请人个人材料（每人各一份）"),
        ("shared", "🧳 行程 / 公共材料"),
        ("conditional", "🅾️ 条件性材料（仅特定情况需要）"),
    ]:
        items = by_applies[section]
        if not items:
            continue
        lines.append(f"## {label}\n")
        for item, res in items:
            icon = STATUS_ICON.get(res.status, "?")
            lines.append(f"### {icon} {res.item_id}. {res.description}")
            lines.append("")
            # 详细要求
            full_desc = item["description"].strip()
            for dl in full_desc.split("\n"):
                dl = dl.strip()
                if dl:
                    lines.append(f"> {dl}")
            lines.append("")
            # 匹配详情
            for d in res.details:
                lines.append(f"- {d}")
            lines.append("")

    # 行动建议
    if counts["FAIL"] > 0 or counts["WARNING"] > 0:
        lines.append("## ⚠️ 行动建议\n")
        for r in results:
            if r.status in ("FAIL", "WARNING"):
                lines.append(f"- **{r.item_id}. {r.description}** — 状态 {r.status}")
        lines.append("")
    else:
        lines.append("## ✅ 全部要求已满足\n")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(description="签证材料审核")
    parser.add_argument(
        "--materials", default="iceland",
        help="材料根目录（默认 iceland/）",
    )
    parser.add_argument(
        "--checklist", default="audit/checklist.json",
        help="checklist JSON 路径（默认 audit/checklist.json）",
    )
    parser.add_argument(
        "--output", default="audit/report.md",
        help="报告输出路径（默认 audit/report.md）",
    )
    parser.add_argument(
        "--applicants", default=None,
        help="手动指定申请人目录（逗号分隔），不指定则自动检测",
    )
    parser.add_argument(
        "--llm", action="store_true",
        help="启用 LLM 二次核对（需要 ANTHROPIC_AUTH_TOKEN + anthropic SDK）",
    )
    parser.add_argument(
        "--model", default=None,
        help="LLM 模型名（默认从 $ANTHROPIC_MODEL 读取）",
    )
    args = parser.parse_args()

    import os
    materials_dir = Path(args.materials)
    checklist_path = Path(args.checklist)
    output_path = Path(args.output)

    if not materials_dir.is_dir():
        print(f"[ERROR] materials dir not found: {materials_dir}", file=sys.stderr)
        return 1
    if not checklist_path.is_file():
        print(f"[ERROR] checklist JSON not found: {checklist_path}", file=sys.stderr)
        print(f"  请先运行: python3 audit/extract_checklist.py", file=sys.stderr)
        return 1

    checklist = json.loads(checklist_path.read_text(encoding="utf-8"))
    applicants = (
        [a.strip() for a in args.applicants.split(",") if a.strip()]
        if args.applicants
        else detect_applicants(materials_dir)
    )
    model = args.model or os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")

    print(f"[INFO] 材料目录: {materials_dir}")
    print(f"[INFO] 检测到申请人: {applicants}")
    print(f"[INFO] 共 {len(checklist['items'])} 项要求")
    if args.llm:
        print(f"[INFO] LLM 模型: {model}")
    print()

    results: list[ItemResult] = []
    for item in checklist["items"]:
        res = audit_item(item, materials_dir, applicants, args.llm, model)
        results.append(res)
        icon = STATUS_ICON.get(res.status, "?")
        print(f"  {icon} [{res.status:<7}] {res.item_id:>2}. {res.description}")

    # 写报告
    report = render_report(checklist, results, materials_dir, applicants, args.llm)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(report, encoding="utf-8")
    print(f"\n[OK] 报告已写入 {output_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
