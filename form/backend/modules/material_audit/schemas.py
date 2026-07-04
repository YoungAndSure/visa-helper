"""material-audit 端点的 Pydantic schema。

只保留 audit-verify / run / checklist 相关字段。form-fill 已拆到 form_assist。
"""
from __future__ import annotations

from pydantic import BaseModel, Field


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
class RunRequest(BaseModel):
    country: str = Field(description="国家短码 e.g. IS / NO")
    materials_dir: str = Field(description="材料目录绝对路径")
    use_llm: bool = Field(default=False, description="是否对每项调用 LLM 二次核对")


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


class RunResponse(BaseModel):
    country: str
    results: list[RunItemResult]
    summary: RunSummary
    markdown_report: str | None = Field(default=None, description="整份审核报告（可选）")