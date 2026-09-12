import hashlib
import json
from unittest.mock import Mock

import pytest

from backend.modules.audit_rules.store import RuleStore
from backend.modules.material_audit.audit_agent import AuditAgent
from backend.modules.material_audit.decisions import RuleDecision
from backend.tests.test_rule_pipeline import request
from tools.rules.bootstrap_general import SOURCE, build_ruleset, install


def test_official_seed_provenance_and_boundaries():
    rules = build_ruleset()
    source = json.loads(SOURCE.read_text())
    assert source["url"].startswith("https://home-affairs.ec.europa.eu/")
    assert len(rules.rules) == 6
    for rule in rules.rules:
        assert rule.requires_private_data is False
        assert rule.review_scope == "checklist"
        assert "[通用测试]" in rule.title
        assert rule.sources[0].sha256 == hashlib.sha256(SOURCE.read_bytes()).hexdigest()
        assert rule.sources[0].excerpt in {entry["summary"] for entry in source["requirements"]}


def test_seed_installation_is_repeatable_and_preserves_other_rules(tmp_path):
    store = RuleStore(tmp_path / "rules", tmp_path / "checklists")
    path = install(store)
    assert store.load("IS", "schengen-tourism").version == build_ruleset().version
    assert install(store) == path
    assert len(list((store.root / "versions").glob("*.json"))) == 1
    changed = build_ruleset().model_copy(update={"version": "user-rules-v2"})
    store.publish(changed)
    with pytest.raises(ValueError, match="refusing"):
        install(store)
    assert store.load("IS", "schengen-tourism").version == "user-rules-v2"


def test_six_rules_execute_through_real_orchestrator_with_fake_judge(tmp_path, monkeypatch):
    store = RuleStore(tmp_path / "rules", tmp_path / "checklists")
    install(store)
    monkeypatch.setattr("backend.modules.material_audit.audit_agent.agent_available", lambda: True)
    judge = Mock()
    judge.evaluate.return_value = RuleDecision(
        status="WARNING", reason="Synthetic test: insufficient evidence", checked_items=["Synthetic check"], confidence=0,
    )
    report = AuditAgent(store, judge).run(request())
    assert judge.evaluate.call_count == 6
    assert [item.rule_id for item in report.results] == [rule.id for rule in build_ruleset().rules]
    assert all(item.execution_status == "completed" for item in report.results)
    assert report.summary.WARNING == 6
