"""File-backed store; explicit publication, atomic snapshots, no request-time cache."""
from __future__ import annotations
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path

from .schemas import AuditRule, RuleSet, RuleSource

ROOT = Path(__file__).resolve().parents[3]


class RuleStore:
    def __init__(self, root: Path | None = None, checklist_root: Path | None = None):
        self.root = root or Path(os.environ.get("AUDIT_RULES_DIR", ROOT / "data/rules"))
        self.checklist_root = checklist_root or ROOT / "data/checklists/parsed"

    @staticmethod
    def key(country: str, visa_type: str) -> str:
        if not re.fullmatch(r"[A-Z]{2}", country) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", visa_type):
            raise ValueError("invalid country or visa type")
        return f"rules-{country}-{visa_type}"

    def load(self, country: str, visa_type: str) -> RuleSet | None:
        key = self.key(country, visa_type)
        path = self.root / "published" / f"{key}.json"
        if path.exists():
            ruleset = RuleSet.model_validate_json(path.read_text(encoding="utf-8"))
            if (ruleset.country, ruleset.visa_type, ruleset.status) != (country, visa_type, "published"):
                raise ValueError("published rule identity mismatch")
            if any(rule.requires_private_data for rule in ruleset.rules):
                raise ValueError("remote rules cannot require private data")
            return ruleset
        # Migration adapter: existing checklist is already curated. No inferred rules.
        source = self.checklist_root / f"checklist-{country}-{visa_type}.json"
        if not source.exists():
            return None
        raw = source.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        data = json.loads(raw)
        rules = [AuditRule(
            id=f"checklist-{item['id']}", title=item["description"][:200],
            instruction=item["description"] + "\n适用条件：" + str(item.get("condition") or item.get("applies_to") or "未指定"),
            sources=[RuleSource(file=source.name, sha256=digest, excerpt=item["description"][:2000])],
        ) for item in data.get("items", [])]
        if not rules:
            return None
        return RuleSet(country=country, visa_type=visa_type, version=f"checklist-{digest[:12]}", status="published", rules=rules)

    def save_draft(self, ruleset: RuleSet) -> Path:
        if ruleset.status != "draft":
            raise ValueError("expected a draft")
        path = self.root / "drafts" / f"{self.key(ruleset.country, ruleset.visa_type)}-{ruleset.version}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("x", encoding="utf-8") as stream:
            stream.write(ruleset.model_dump_json(indent=2))
        return path

    def publish(self, ruleset: RuleSet) -> Path:
        if any(rule.requires_private_data for rule in ruleset.rules):
            raise ValueError("privacy-dependent rules belong in local audit, not the remote library")
        published = ruleset.model_copy(update={"status": "published"})
        key = self.key(published.country, published.visa_type)
        archive = self.root / "versions" / f"{key}-{published.version}.json"
        archive.parent.mkdir(parents=True, exist_ok=True)
        serialized = published.model_dump_json(indent=2)
        with archive.open("x", encoding="utf-8") as stream:
            stream.write(serialized)
        target = self.root / "published" / f"{key}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temp = tempfile.mkstemp(prefix=".rules-", dir=target.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(serialized)
            os.replace(temp, target)
        finally:
            Path(temp).unlink(missing_ok=True)
        return target
