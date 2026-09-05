"""material-audit 端点的 Pydantic schema。

只保留 audit-verify / run / checklist 相关字段。form-fill 已拆到 form_assist。
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


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


class SanitizedFile(BaseModel):
    """浏览器重新生成并烧录遮挡后的文件；不包含原文件名。"""

    model_config = ConfigDict(extra="forbid")

    media_type: Literal["application/pdf", "image/jpeg"]
    content: str = Field(min_length=32, max_length=30_000_000)
    size: int = Field(gt=0, le=22_500_000)
    page_count: int = Field(ge=1, le=200)
    redaction_count: int = Field(ge=0, le=10_000)

    @model_validator(mode="after")
    def validate_data_url(self) -> "SanitizedFile":
        prefix = f"data:{self.media_type};base64,"
        if not self.content.startswith(prefix):
            raise ValueError("sanitized file content must be a matching base64 data URL")
        return self


class SafeMaterial(BaseModel):
    """浏览器本地脱敏后允许发送的 PDF/JPG 副本。"""

    model_config = ConfigDict(extra="forbid")

    material_id: str = Field(pattern=r"^material-\d{3}$")
    source_ref: str = Field(pattern=r"^local-file-\d{3}$")
    media_type: Literal["application/pdf", "image/jpeg"]
    kind: Literal["pdf", "image"]
    sanitized_file: SanitizedFile
    review_status: Literal["ready"]

    @model_validator(mode="after")
    def validate_file_matches_material(self) -> "SafeMaterial":
        if self.sanitized_file.media_type != self.media_type:
            raise ValueError("sanitized file media type does not match material")
        expected_kind = "pdf" if self.media_type == "application/pdf" else "image"
        if self.kind != expected_kind:
            raise ValueError("material kind does not match media type")
        return self


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    country: str = Field(description="国家短码 e.g. IS / NO")
    schema_version: Literal["privacy-files/v1"] | None = None
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
        if self.materials and self.schema_version != "privacy-files/v1":
            raise ValueError("sanitized materials require schema_version=privacy-files/v1")
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
