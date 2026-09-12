"""Validated model output, independent from report rendering."""
from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class Region(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)

    @model_validator(mode="after")
    def within_page(self):
        if self.x + self.width > 1.000001 or self.y + self.height > 1.000001:
            raise ValueError("region lies outside page")
        return self


class Evidence(BaseModel):
    model_config = ConfigDict(extra="forbid")
    material_id: str = Field(pattern=r"^material-\d{3}$")
    page: int | None = Field(default=None, ge=1)
    region: Region | None = None
    explanation: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def region_needs_page(self):
        if self.region and self.page is None:
            raise ValueError("region requires a page")
        return self


class RuleDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["PASS", "FAIL", "WARNING", "N/A"]
    reason: str = Field(min_length=1, max_length=4000)
    checked_items: list[str] = Field(min_length=1, max_length=30)
    confidence: float = Field(ge=0, le=1)
    evidence: list[Evidence] = Field(default_factory=list, max_length=100)


class Annotation(BaseModel):
    rule_id: str
    scope: Literal["global", "document", "page", "region"]
    message: str
    material_id: str | None = None
    page: int | None = None
    region: Region | None = None
    location_verified: bool = False
