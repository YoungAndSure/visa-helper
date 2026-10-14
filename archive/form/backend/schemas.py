"""
Pydantic schemas for /suggest and /extract.

这些类型会被 OpenAPI 自动暴露（开发期调试方便）。
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# /suggest
# ---------------------------------------------------------------------------
class SuggestRequest(BaseModel):
    field_label: str = Field(min_length=1, max_length=200, description="VFS 表单字段标签（中英）")
    applicant_context: dict[str, Any] = Field(
        default_factory=dict,
        description="已收集到的申请人信息（KYC），由扩展从 chrome.storage 注入",
    )
    mode: Literal["form-fill", "audit-verify"] = "form-fill"
    # 仅 audit-verify 模式需要
    requirement: str | None = Field(
        default=None,
        description="材料要求的文字描述（仅 audit-verify 模式）",
    )
    pdf_text_snippet: str | None = Field(
        default=None,
        max_length=4000,
        description="PDF 抽出的前 2 页文字片段（仅 audit-verify 模式）",
    )


class SuggestResponse(BaseModel):
    value: str | None = Field(
        description="建议值；audit-verify 模式下表示是否对应（YES/NO/UNCERTAIN）",
    )
    rationale: str = Field(default="", description="该建议的理由，简短中文/英文")
    confidence: float = Field(ge=0.0, le=1.0, description="0-1 的置信度")


# ---------------------------------------------------------------------------
# /extract
# ---------------------------------------------------------------------------
class ExtractRequest(BaseModel):
    pdf_paths: list[str] = Field(
        min_length=1, max_length=50,
        description="材料 PDF 绝对路径列表（在服务器本地的路径，例如 iceland/<applicant>/passport.pdf）",
    )
    applicant_hint: str | None = Field(
        default=None,
        description="已知申请人名（可选）；用于减少幻觉",
    )


class ApplicantContext(BaseModel):
    full_name: str | None = None
    full_name_romanized: str | None = None
    passport_no: str | None = None
    id_card_no: str | None = None
    dob: str | None = None
    nationality: str | None = None
    occupation: str | None = None
    employer: str | None = None
    address: str | None = None
    phone: str | None = None
    # 其他自由字段
    extra: dict[str, str] = Field(default_factory=dict)


class ExtractResponse(BaseModel):
    applicants: dict[str, ApplicantContext] = Field(
        description="key = 申请人名；value = 抽取出的结构化数据",
    )
    warnings: list[str] = Field(default_factory=list)
