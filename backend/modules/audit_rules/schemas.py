"""Rules are data; only published, privacy-independent rules run remotely."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class RuleSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    file: str = Field(min_length=1, max_length=300)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    excerpt: str = Field(min_length=1, max_length=2000)


class AuditRule(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$")
    title: str = Field(min_length=1, max_length=200)
    instruction: str = Field(min_length=1, max_length=8000)
    review_scope: Literal["checklist", "risk"] = "checklist"
    annotation_scope: Literal["global", "document", "page", "region"] = "region"
    requires_private_data: bool = False
    enabled: bool = True
    sources: list[RuleSource] = Field(min_length=1, max_length=20)


class RuleSet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["audit-rules/v1"] = "audit-rules/v1"
    country: str = Field(pattern=r"^[A-Z]{2}$")
    visa_type: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,79}$")
    version: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$")
    status: Literal["draft", "published"] = "draft"
    rules: list[AuditRule] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_rules(self):
        if len({rule.id for rule in self.rules}) != len(self.rules):
            raise ValueError("duplicate rule IDs")
        return self
