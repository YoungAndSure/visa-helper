"""Material Audit API 到 Audit Agent 的薄适配层。"""
from __future__ import annotations

import logging

from .audit_agent import AuditAgent
from .schemas import RunRequest, RunResponse

log = logging.getLogger("material_audit.runner")
agent = AuditAgent()


def run_audit(req: RunRequest) -> RunResponse:
    """把隐私安全请求交给可替换的 Agent 编排器。"""
    log.warning(
        "/material-audit/run Agent scaffold invoked: country=%s materials=%d use_llm=%s",
        req.country,
        len(req.materials),
        req.use_llm,
    )
    return agent.run(req)
