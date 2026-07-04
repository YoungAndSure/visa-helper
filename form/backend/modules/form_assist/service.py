"""form-assist 的核心 service: 字段推荐 (form-fill)。"""
from __future__ import annotations

import json
import logging

from ...shared.llm import call_json, llm_available
from ...shared.redact import redact_applicant_context
from .prompts import FORM_FILL_SYSTEM
from .schemas import FormSuggestRequest, FormSuggestResponse

log = logging.getLogger("form_assist.service")


def suggest_form_fill(req: FormSuggestRequest) -> FormSuggestResponse:
    """form-fill: 给字段标签 + 上下文，返回建议值。"""
    if not llm_available():
        return FormSuggestResponse(
            value=None,
            rationale="LLM 未配置（缺 ANTHROPIC_AUTH_TOKEN）。请在 form/backend 启动前 source .env。",
            confidence=0.0,
        )
    redacted = redact_applicant_context(req.applicant_context)
    user = (
        f"字段标签: {req.field_label}\n\n"
        f"申请人上下文 (可能含 [REDACTED]):\n"
        f"{json.dumps(redacted, ensure_ascii=False, indent=2)}"
    )
    try:
        out = call_json(
            system=FORM_FILL_SYSTEM,
            user=user,
            schema_hint='{"value": str|null, "rationale": str, "confidence": float}',
            max_tokens=300,
        )
        return FormSuggestResponse(
            value=out.get("value"),
            rationale=str(out.get("rationale", ""))[:200],
            confidence=float(out.get("confidence", 0.0)),
        )
    except Exception as e:
        log.exception("form-fill suggest failed")
        return FormSuggestResponse(
            value=None,
            rationale=f"LLM 调用失败: {e}",
            confidence=0.0,
        )