"""material-audit 的 runner：包 audit.audit 的 CLI 行为给 FastAPI 用。

Phase A2 阶段：仅做接口骨架 — /material-audit/run 返回 mock 结果，
不实装。等 frontend RPC 接进来时再实装（Phase D）。
"""
from __future__ import annotations

import logging

from .schemas import RunRequest, RunResponse, RunSummary

log = logging.getLogger("material_audit.runner")


def run_audit(req: RunRequest) -> RunResponse:
    """跑某国材料全量审核。

    Phase A2 stub：直接返回空 results + 提示。后续实装将：
    1. 加载 checklist via checklist_store.load_checklist(req.country)
    2. import audit.audit.{audit_item, detect_applicants, render_report}
    3. 用 detect_applicants 找申请人目录
    4. 对每条 checklist item 调 audit_item 拿 ItemResult
    5. 如果 req.use_llm，再调 verify_item 做 LLM 二次核对
    6. 用 render_report 输出 markdown
    """
    log.warning(
        "/material-audit/run stub invoked: country=%s dir=%s use_llm=%s",
        req.country,
        req.materials_dir,
        req.use_llm,
    )
    return RunResponse(
        country=req.country,
        results=[],
        summary=RunSummary(
            total=0,
            warnings=[
                "Phase A2 stub: /material-audit/run 尚未实装,Phase D 接 RPC 时再补完。"
            ],
        ),
        markdown_report=None,
    )