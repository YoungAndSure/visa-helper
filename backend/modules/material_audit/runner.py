"""material-audit 的 runner：包 audit.audit 的 CLI 行为给 FastAPI 用。

⚠️ 当前阶段：**真实审核逻辑尚未实装**。为了让前端页面能端到端跑通、
把界面 / 交互先做出来，`run_audit()` 会基于该国 checklist 合成一份
**结构完整但内容是假的** RunResponse（状态循环分配、matched 文件是占位名）。

每条结果与 summary 都带 "FAKE" 标记，前端也会显式提示「示例数据」，
避免被误当成真实审核结论。

真实实装（后续）计划：
1. 加载 checklist via checklist_store.load_checklist(req.country)
2. import audit.audit.{audit_item, detect_applicants, render_report}
3. 用 detect_applicants 找申请人目录
4. 对每条 checklist item 调 audit_item 拿 ItemResult
5. 如果 req.use_llm，再调 verify_item 做 LLM 二次核对
6. 用 render_report 输出 markdown
"""
from __future__ import annotations

import logging

from .checklist_store import load_checklist
from .schemas import (
    RunItemResult,
    RunRequest,
    RunResponse,
    RunSummary,
    VerifyResponse,
)

log = logging.getLogger("material_audit.runner")

# fake 状态循环表：让示例结果里各种状态都出现，方便前端调样式。
_FAKE_STATUS_CYCLE = ["PASS", "PASS", "WARNING", "FAIL", "N/A"]


def run_audit(req: RunRequest) -> RunResponse:
    """跑某国材料全量审核。

    ⚠️ FAKE 实现：不读 materials_dir、不做任何真实核对，只根据 checklist
    合成示例结果，供前端展示用。真实逻辑见模块 docstring。
    """
    log.warning(
        "/material-audit/run FAKE invoked: country=%s dir=%s use_llm=%s",
        req.country,
        req.materials_dir,
        req.use_llm,
    )

    checklist = load_checklist(req.country)
    if checklist is None:
        return RunResponse(
            country=req.country,
            results=[],
            summary=RunSummary(
                total=0,
                warnings=[
                    f"未找到 country={req.country!r} 的 checklist；"
                    "先跑 audit/extract_checklist.py 生成。",
                ],
            ),
            markdown_report=None,
        )

    results: list[RunItemResult] = []
    counts = {"PASS": 0, "FAIL": 0, "WARNING": 0, "N/A": 0}

    for i, item in enumerate(checklist.items):
        status = _FAKE_STATUS_CYCLE[i % len(_FAKE_STATUS_CYCLE)]
        counts[status] += 1

        # 占位 matched 文件名：用 checklist 的 match_keywords 拼一个像样的假路径。
        if status == "N/A":
            matched: list[str] = []
        else:
            kw = (item.match_keywords or ["material"])[0]
            matched = [f"<fake>/{kw}.pdf"]

        llm_checks: list[VerifyResponse] = []
        if req.use_llm and status != "N/A":
            llm_checks = [
                VerifyResponse(
                    value="YES" if status == "PASS" else "UNCERTAIN",
                    rationale="[FAKE] 示例 LLM 核对结果，非真实判定",
                    confidence=0.5,
                )
            ]

        results.append(
            RunItemResult(
                item_id=item.id,
                status=status,
                matched=matched,
                llm_checks=llm_checks,
                details=f"[FAKE] 第 {item.id} 项示例状态={status}",
            )
        )

    summary = RunSummary(
        total=len(results),
        PASS=counts["PASS"],
        FAIL=counts["FAIL"],
        WARNING=counts["WARNING"],
        N_A=counts["N/A"],
        warnings=[
            "⚠️ 这是示例（FAKE）数据：/material-audit/run 尚未实装真实审核逻辑，"
            "结果仅供前端展示。",
        ],
    )

    markdown_report = _fake_markdown(checklist.country, results, summary)

    return RunResponse(
        country=req.country,
        results=results,
        summary=summary,
        markdown_report=markdown_report,
    )


def _fake_markdown(
    country: str,
    results: list[RunItemResult],
    summary: RunSummary,
) -> str:
    """拼一份示例 markdown 报告字符串。"""
    lines = [
        f"# 材料审核报告（{country}）",
        "",
        "> ⚠️ **示例数据（FAKE）** — 真实审核逻辑尚未实装。",
        "",
        f"- 合计 {summary.total} 项："
        f"PASS {summary.PASS} / WARNING {summary.WARNING} / "
        f"FAIL {summary.FAIL} / N/A {summary.N_A}",
        "",
        "| # | 状态 | 匹配文件 |",
        "|---|------|----------|",
    ]
    for r in results:
        matched = ", ".join(r.matched) if r.matched else "—"
        lines.append(f"| {r.item_id} | {r.status} | {matched} |")
    return "\n".join(lines)
