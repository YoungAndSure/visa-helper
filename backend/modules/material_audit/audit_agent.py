"""材料审核 Agent 的可替换编排骨架。

当前只实现请求边界、Checklist 加载和 FAKE 结果合成。知识库检索、模型调用和真实规则
审核保留为明确步骤，后续可以逐个替换，而不改变 /material-audit/run 的外部契约。
"""
from __future__ import annotations

import logging

from .checklist_store import load_checklist
from .schemas import (
    AgentStep,
    RunItemResult,
    RunRequest,
    RunResponse,
    RunSummary,
    VerifyResponse,
)

log = logging.getLogger("material_audit.agent")

_FAKE_STATUS_CYCLE = ["PASS", "PASS", "WARNING", "FAIL", "N/A"]


class AuditAgent:
    """按固定阶段编排审核；每个 stub 都可在后续替换成真实实现。"""

    def run(self, req: RunRequest) -> RunResponse:
        trace = [self._intake(req)]
        checklist = load_checklist(req.country)
        if checklist is None:
            trace.append(AgentStep(
                name="checklist",
                status="failed",
                detail="未找到对应国家和签证类型的 Checklist",
            ))
            return RunResponse(
                country=req.country,
                results=[],
                summary=RunSummary(
                    total=0,
                    warnings=[
                        f"未找到 country={req.country!r} 的 checklist；"
                        "先跑 tools/checklist/import_checklist.py 生成。",
                    ],
                ),
                agent_trace=trace,
            )

        results, summary = self._fake_checklist_review(req, checklist.items)
        trace.append(AgentStep(
            name="checklist_review",
            status="completed",
            detail=f"已加载 {len(checklist.items)} 项要求；当前返回 FAKE 状态",
        ))
        trace.append(AgentStep(
            name="knowledge_retrieval",
            status="pending" if "risk" in req.review_scopes else "skipped",
            detail="知识库检索接口待实现" if "risk" in req.review_scopes else "请求未包含 risk scope",
        ))
        trace.append(AgentStep(
            name="model_review",
            status="pending" if req.use_llm else "skipped",
            detail="模型审核编排待实现" if req.use_llm else "use_llm=false",
        ))
        trace.append(AgentStep(
            name="report",
            status="completed",
            detail="已生成示例报告",
        ))

        return RunResponse(
            country=req.country,
            results=results,
            summary=summary,
            markdown_report=self._fake_markdown(checklist.country, results, summary),
            agent_trace=trace,
        )

    @staticmethod
    def _intake(req: RunRequest) -> AgentStep:
        if req.materials and (
            not req.privacy.processed_locally
            or req.privacy.raw_files_uploaded
            or not req.privacy.user_reviewed
        ):
            return AgentStep(
                name="privacy_intake",
                status="failed",
                detail="安全材料缺少本地处理或用户确认标记",
            )
        return AgentStep(
            name="privacy_intake",
            status="completed",
            detail=f"收到 {len(req.materials)} 个用户确认的脱敏文件；未接收原始文件",
        )

    @staticmethod
    def _fake_checklist_review(req: RunRequest, checklist_items) -> tuple[list[RunItemResult], RunSummary]:
        results: list[RunItemResult] = []
        counts = {"PASS": 0, "FAIL": 0, "WARNING": 0, "N/A": 0}
        source_refs = [material.source_ref for material in req.materials]

        for index, item in enumerate(checklist_items):
            status = _FAKE_STATUS_CYCLE[index % len(_FAKE_STATUS_CYCLE)]
            counts[status] += 1
            matched = [] if status == "N/A" else (
                [source_refs[index % len(source_refs)]] if source_refs else ["<fake>/material.pdf"]
            )
            llm_checks = []
            if req.use_llm and status != "N/A":
                llm_checks = [VerifyResponse(
                    value="YES" if status == "PASS" else "UNCERTAIN",
                    rationale="[FAKE] 模型步骤尚未实装",
                    confidence=0.5,
                )]
            results.append(RunItemResult(
                item_id=item.id,
                status=status,
                matched=matched,
                llm_checks=llm_checks,
                details=f"[FAKE] 第 {item.id} 项示例状态={status}",
            ))

        warnings = [
            "⚠️ 这是示例（FAKE）数据：Audit Agent 编排框架已接入，"
            "真实 Checklist、知识库和模型审核步骤尚未实装。",
        ]
        if req.materials:
            warnings.append(
                f"隐私边界：后端收到 {len(req.materials)} 个用户确认的脱敏文件，"
                "未收到原始文件、文件名或本地路径。"
            )
        return results, RunSummary(
            total=len(results),
            PASS=counts["PASS"],
            FAIL=counts["FAIL"],
            WARNING=counts["WARNING"],
            N_A=counts["N/A"],
            warnings=warnings,
        )

    @staticmethod
    def _fake_markdown(
        country: str,
        results: list[RunItemResult],
        summary: RunSummary,
    ) -> str:
        lines = [
            f"# 材料审核报告（{country}）",
            "",
            "> ⚠️ **示例数据（FAKE）** — Agent 流程已搭建，真实审核逻辑尚未实装。",
            "",
            f"- 合计 {summary.total} 项：PASS {summary.PASS} / "
            f"WARNING {summary.WARNING} / FAIL {summary.FAIL} / N/A {summary.N_A}",
            "",
            "| # | 状态 | 安全材料引用 |",
            "|---|------|--------------|",
        ]
        for result in results:
            matched = ", ".join(result.matched) if result.matched else "—"
            lines.append(f"| {result.item_id} | {result.status} | {matched} |")
        return "\n".join(lines)
