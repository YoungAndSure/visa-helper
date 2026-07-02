"""
POST /suggest

两种模式：
- form-fill   : 给一个 VFS 字段标签，返回建议值（基于 applicant_context）
- audit-verify: 验证「这份 PDF 文本片段是否对应所要求材料」，返回 YES/NO/UNCERTAIN

Phase 0 兼容无 LLM 配置：返回 mock 响应，提示「LLM 未配置」。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from .llm import call_json, call_text, llm_available
from .redact import redact_applicant_context
from .schemas import SuggestRequest, SuggestResponse

router = APIRouter()
log = logging.getLogger("visa-helper.suggest")

# ---------------------------------------------------------------------------
# System prompts
# ---------------------------------------------------------------------------
_FORM_FILL_SYSTEM = """\
你是签证填表助手。你会看到：
1) 一个 VFS / 移民局在线表单的字段标签（中英混合）
2) 已有的「申请人上下文」（KYC 字段值，可能含部分脱敏占位符）

任务：基于上下文，给出该字段应该填什么值。规则：
- 严格只输出 JSON：{"value": "...", "rationale": "...(≤40字)", "confidence": 0.0-1.0}
- value 必须是字符串或 null
- 如果上下文不足 → value=null, confidence≤0.3, rationale 写明缺失什么
- 上下文被脱敏时不要自己补全具体数字
- 日期统一 ISO 8601 (YYYY-MM-DD)，姓名用罗马拼音（不加音调）
"""


_AUDIT_SYSTEM = """\
你是签证材料审核助手。判断「给定文档文本片段」是否对应所要求的材料类型。

判定：
- YES       : 文本片段明确表明这份材料就是所要求类别
- NO        : 文本片段明确表明这是其他类别（明显不是）
- UNCERTAIN : 信息不足 / 需要全文才能判断 / 是扫描件

你只看到前 2 页文本；当不确定时优先 UNCERTAIN，不要轻易 NO。

严格只输出 JSON：{"value": "YES|NO|UNCERTAIN", "rationale": "<≤30字>", "confidence": 0.0-1.0}
"""


@router.post("/suggest", response_model=SuggestResponse)
def suggest(req: SuggestRequest) -> SuggestResponse:
    if not llm_available():
        # Phase 0：无 LLM 时返回 mock，避免阻塞前端联调
        return SuggestResponse(
            value=None,
            rationale="LLM 未配置（缺 ANTHROPIC_AUTH_TOKEN）。请在 form/backend 启动前 source .env。",
            confidence=0.0,
        )

    if req.mode == "form-fill":
        return _suggest_form_fill(req)
    elif req.mode == "audit-verify":
        return _suggest_audit_verify(req)
    else:
        raise HTTPException(400, f"unknown mode: {req.mode}")


def _suggest_form_fill(req: SuggestRequest) -> SuggestResponse:
    redacted = redact_applicant_context(req.applicant_context)
    user = (
        f"字段标签: {req.field_label}\n\n"
        f"申请人上下文 (可能含 [REDACTED]):\n"
        f"{_json_dump(redacted)}"
    )
    try:
        out = call_json(
            system=_FORM_FILL_SYSTEM,
            user=user,
            schema_hint='{"value": str|null, "rationale": str, "confidence": float}',
            max_tokens=300,
        )
        return SuggestResponse(
            value=out.get("value"),
            rationale=str(out.get("rationale", ""))[:200],
            confidence=float(out.get("confidence", 0.0)),
        )
    except Exception as e:
        log.exception("form-fill suggest failed")
        return SuggestResponse(
            value=None,
            rationale=f"LLM 调用失败: {e}",
            confidence=0.0,
        )


def _suggest_audit_verify(req: SuggestRequest) -> SuggestResponse:
    if not (req.requirement and req.pdf_text_snippet is not None):
        raise HTTPException(400, "audit-verify mode requires 'requirement' and 'pdf_text_snippet'")
    user = (
        f"要求材料:\n{req.requirement}\n\n"
        f"文档文本片段 (前 2 页):\n{req.pdf_text_snippet}"
    )
    try:
        out = call_json(
            system=_AUDIT_SYSTEM,
            user=user,
            schema_hint='{"value": "YES|NO|UNCERTAIN", "rationale": str, "confidence": float}',
            max_tokens=200,
        )
        verdict = out.get("value", "UNCERTAIN")
        if verdict not in {"YES", "NO", "UNCERTAIN"}:
            verdict = "UNCERTAIN"
        return SuggestResponse(
            value=verdict,
            rationale=str(out.get("rationale", ""))[:200],
            confidence=float(out.get("confidence", 0.0)),
        )
    except Exception as e:
        log.exception("audit-verify failed")
        return SuggestResponse(
            value="UNCERTAIN",
            rationale=f"LLM 调用失败: {e}",
            confidence=0.0,
        )


def _json_dump(obj) -> str:
    import json
    return json.dumps(obj, ensure_ascii=False, indent=2)
