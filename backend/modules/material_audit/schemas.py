"""material-audit 端点的 Pydantic schema。

只保留 audit-verify / run / checklist 相关字段。form-fill 已拆到 form_assist。
"""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


# ---------- verify (单条 LLM 内容核对) ----------
class VerifyRequest(BaseModel):
    requirement: str = Field(min_length=1, max_length=2000, description="材料要求的文字描述")
    pdf_text_snippet: str = Field(min_length=1, max_length=4000, description="PDF 抽出的前 2 页文字片段")


class VerifyResponse(BaseModel):
    value: str = Field(description="YES | NO | UNCERTAIN")
    rationale: str = Field(default="", description="判定理由（≤30字）")
    confidence: float = Field(ge=0.0, le=1.0)


# ---------- checklist (拉某国要求清单) ----------
class ChecklistItem(BaseModel):
    id: int
    description: str
    applies_to: str | None = None
    condition: str | None = None
    match_keywords: list[str] = Field(default_factory=list)


class ChecklistResponse(BaseModel):
    country: str
    items: list[ChecklistItem]
    source: str | None = Field(default=None, description="清单来源文件路径")


# ---------- run (全量审核跑) ----------
class PrivacyMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    processed_locally: bool = False
    raw_files_uploaded: bool = False
    user_reviewed: bool = False
    redaction_engine: str = Field(default="unknown", max_length=100)


class PrivacyRedaction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str = Field(min_length=1, max_length=100)
    count: int = Field(ge=0)


class SafeImageObject(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image_id: str = Field(min_length=1, max_length=100)
    media_type: str = Field(max_length=100)
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)
    included: bool = False
    redaction_status: str = Field(default="pending_manual_redaction", max_length=100)
    content: str | None = Field(default=None, max_length=5_000_000)
    description: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def validate_content_boundary(self) -> "SafeImageObject":
        if self.included and not self.content:
            raise ValueError("included image must contain redacted content")
        if self.included and self.redaction_status != "redacted":
            raise ValueError("included image must have redaction_status=redacted")
        if not self.included and self.content:
            raise ValueError("excluded image must not contain content")
        return self


class SafeContentBlock(BaseModel):
    """安全材料中的有序内容块，顺序与原文件阅读顺序一致。"""

    model_config = ConfigDict(extra="forbid")

    type: Literal["text", "image"]
    text: str | None = Field(default=None, max_length=250_000)
    image: SafeImageObject | None = None

    @model_validator(mode="after")
    def validate_block_payload(self) -> "SafeContentBlock":
        if self.type == "text" and self.text is None:
            raise ValueError("text block must contain text")
        if self.type == "text" and self.image is not None:
            raise ValueError("text block must not contain image")
        if self.type == "image" and self.image is None:
            raise ValueError("image block must contain image")
        if self.type == "image" and self.text is not None:
            raise ValueError("image block must not contain text")
        return self


class SafeMaterial(BaseModel):
    """浏览器本地脱敏后允许发送的材料对象，不包含原始文件名或路径。"""

    model_config = ConfigDict(extra="forbid")

    material_id: str = Field(pattern=r"^material-\d{3}$")
    source_ref: str = Field(pattern=r"^local-file-\d{3}$")
    material_type: str = Field(
        default="unknown",
        pattern=r"^[a-z0-9][a-z0-9_-]{0,99}$",
    )
    media_type: str = Field(default="application/octet-stream", max_length=100)
    kind: Literal["pdf", "text", "image", "unsupported"]
    text: str = Field(default="", max_length=250_000)
    images: list[SafeImageObject] = Field(default_factory=list, max_length=50)
    content_blocks: list[SafeContentBlock] = Field(default_factory=list, max_length=200)
    redactions: list[PrivacyRedaction] = Field(default_factory=list, max_length=100)
    review_status: Literal["needs_review", "blocked", "ready"] = "needs_review"
    user_notes: str = Field(default="", max_length=4000)

    @field_validator("text")
    @classmethod
    def reject_obvious_raw_pii(cls, value: str) -> str:
        patterns = (
            r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b",
            r"(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)",
            r"(?<!\d)\d{17}[0-9X](?!\d)",
            r"(?<!\d)\d{12,19}(?!\d)",
            r"\b[A-Z]{1,2}\d{6,9}\b",
        )
        if any(re.search(pattern, value, flags=re.IGNORECASE) for pattern in patterns):
            raise ValueError("text contains obvious unredacted PII")
        return value

    @field_validator("content_blocks")
    @classmethod
    def reject_obvious_raw_pii_in_blocks(
        cls, value: list[SafeContentBlock]
    ) -> list[SafeContentBlock]:
        for block in value:
            if block.type == "text" and block.text is not None:
                cls.reject_obvious_raw_pii(block.text)
        return value


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    country: str = Field(description="国家短码 e.g. IS / NO")
    visa_type: str = Field(default="schengen-tourism", max_length=100)
    materials: list[SafeMaterial] = Field(default_factory=list, max_length=100)
    privacy: PrivacyMetadata = Field(default_factory=PrivacyMetadata)
    review_scopes: list[Literal["checklist", "risk"]] = Field(
        default_factory=lambda: ["checklist"],
        max_length=2,
    )
    materials_dir: str | None = Field(
        default=None,
        description="旧版兼容字段；新前端不再发送本地目录",
    )
    use_llm: bool = Field(default=False, description="是否对每项调用 LLM 二次核对")

    @model_validator(mode="after")
    def validate_privacy_boundary(self) -> "RunRequest":
        if self.materials and not (
            self.privacy.processed_locally
            and not self.privacy.raw_files_uploaded
            and self.privacy.user_reviewed
        ):
            raise ValueError(
                "materials require locally processed, non-uploaded, user-reviewed privacy metadata"
            )
        return self


class RunItemResult(BaseModel):
    item_id: int
    status: str  # PASS | FAIL | WARNING | N/A
    matched: list[str] = Field(default_factory=list)
    llm_checks: list[VerifyResponse] = Field(default_factory=list)
    details: str = ""


class RunSummary(BaseModel):
    total: int
    PASS: int = 0
    FAIL: int = 0
    WARNING: int = 0
    N_A: int = 0
    warnings: list[str] = Field(default_factory=list)


class AgentStep(BaseModel):
    name: str
    status: Literal["completed", "skipped", "pending", "failed"]
    detail: str = ""


class RunResponse(BaseModel):
    country: str
    results: list[RunItemResult]
    summary: RunSummary
    markdown_report: str | None = Field(default=None, description="整份审核报告（可选）")
    agent_trace: list[AgentStep] = Field(default_factory=list)
