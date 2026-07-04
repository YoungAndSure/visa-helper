"""material-audit 的核心 service: 单条 LLM 内容核对 (audit-verify)。"""
from __future__ import annotations

import logging

from ...shared.llm import call_json, llm_available
from .prompts import AUDIT_SYSTEM
from .schemas import VerifyRequest, VerifyResponse

log = logging.getLogger("material_audit.service")


def verify_item(req: VerifyRequest) -> VerifyResponse:
    """audit-verify: 给 requirement + pdf_text_snippet,返回 YES/NO/UNCERTAIN。"""
    if not llm_available():
        return VerifyResponse(
            value="UNCERTAIN",
            rationale="LLM 未配置（缺 ANTHROPIC_AUTH_TOKEN）",
            confidence=0.0,
        )
    user = (
        f"要求材料:\n{req.requirement}\n\n"
        f"文档文本片段 (前 2 页):\n{req.pdf_text_snippet}"
    )
    try:
        out = call_json(
            system=AUDIT_SYSTEM,
            user=user,
            schema_hint='{"value": "YES|NO|UNCERTAIN", "rationale": str, "confidence": float}',
            max_tokens=200,
        )
        verdict = out.get("value", "UNCERTAIN")
        if verdict not in {"YES", "NO", "UNCERTAIN"}:
            verdict = "UNCERTAIN"
        return VerifyResponse(
            value=verdict,
            rationale=str(out.get("rationale", ""))[:200],
            confidence=float(out.get("confidence", 0.0)),
        )
    except Exception as e:
        log.exception("audit-verify failed")
        return VerifyResponse(
            value="UNCERTAIN",
            rationale=f"LLM 调用失败: {e}",
            confidence=0.0,
        )