"""共享 Pydantic schema。

目前只有 ApplicantContext —— 同时被 form_assist（extract 输入）和
material_audit（run 输出）的部分代码使用，所以放在 shared/。
"""
from __future__ import annotations

from pydantic import BaseModel, Field


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