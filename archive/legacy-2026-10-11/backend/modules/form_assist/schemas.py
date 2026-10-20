"""form-assist 端点的 Pydantic schema。

包含：
- FormSuggestRequest/Response    — /form-assist/suggest
- ExtractRequest/Response         — /form-assist/extract
- ApplicantContext                — 来自 shared.schemas_common
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from ...shared.schemas_common import ApplicantContext  # re-export


class FormSuggestRequest(BaseModel):
    field_label: str = Field(min_length=1, max_length=200, description="VFS 表单字段标签（中英）")
    applicant_context: dict[str, Any] = Field(
        default_factory=dict,
        description="已收集到的申请人信息（KYC），由扩展从 chrome.storage 注入",
    )


class FormSuggestResponse(BaseModel):
    value: str | None = Field(description="建议填入字段的值；无上下文时为 null")
    rationale: str = Field(default="", description="该建议的理由，简短中文/英文")
    confidence: float = Field(ge=0.0, le=1.0, description="0-1 的置信度")


class ExtractRequest(BaseModel):
    pdf_paths: list[str] = Field(
        min_length=1, max_length=50,
        description="材料 PDF 绝对路径列表（在服务器本地的路径，例如 iceland/<applicant>/passport.pdf）",
    )
    applicant_hint: str | None = Field(
        default=None,
        description="已知申请人名（可选）；用于减少幻觉",
    )


class ExtractResponse(BaseModel):
    applicants: dict[str, ApplicantContext] = Field(
        description="key = 申请人名；value = 抽取出的结构化数据",
    )
    warnings: list[str] = Field(default_factory=list)


__all__ = [
    "ApplicantContext",
    "FormSuggestRequest",
    "FormSuggestResponse",
    "ExtractRequest",
    "ExtractResponse",
]