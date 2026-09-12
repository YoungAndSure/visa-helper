import base64
import json
from unittest.mock import Mock
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.app import app
from backend.modules.audit_rules.schemas import AuditRule, RuleSet, RuleSource
from backend.modules.audit_rules.store import RuleStore
from backend.modules.material_audit.audit_agent import AuditAgent
from backend.modules.material_audit.decisions import RuleDecision
from backend.modules.material_audit.rule_agent import LLMRuleAgent
from backend.modules.material_audit.schemas import RunRequest
from backend.modules.rule_generation.service import generate_from_directory, read_sources


def rule(id="format", **updates):
    return AuditRule(id=id, title="Test rule", instruction="Check test layout",
                     sources=[RuleSource(file="source.md", sha256="a" * 64, excerpt="Test requirement")], **updates)


def request(**updates):
    raw = b"\xff\xd8\xffsynthetic-jpeg-test"
    payload = dict(country="IS", schema_version="privacy-files/v1", materials=[{
        "material_id": "material-001", "source_ref": "local-file-001", "kind": "image", "media_type": "image/jpeg",
        "sanitized_file": {"media_type": "image/jpeg", "content": "data:image/jpeg;base64," + base64.b64encode(raw).decode(),
                           "size": len(raw), "page_count": 1, "redaction_count": 1}, "review_status": "ready",
    }], privacy={"processed_locally": True, "raw_files_uploaded": False, "user_reviewed": True}, use_llm=True,
                   review_scopes=["checklist", "risk"])
    payload.update(updates)
    return RunRequest.model_validate(payload)


def decision(status="FAIL", **updates):
    payload = dict(status=status, reason="Test issue", checked_items=["Checked test format"], confidence=0.8,
                   evidence=[{"material_id": "material-001", "page": 1,
                              "region": {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.2}, "explanation": "Problem here"}])
    payload.update(updates)
    return RuleDecision.model_validate(payload)


@pytest.fixture
def store(tmp_path):
    return RuleStore(tmp_path / "rules", tmp_path / "checklists")


def publish(store, rules, version="v1", country="IS", visa_type="schengen-tourism"):
    return store.publish(RuleSet(country=country, visa_type=visa_type, version=version, rules=rules))


@pytest.fixture(autouse=True)
def prevent_live_llm(monkeypatch):
    monkeypatch.setattr("backend.modules.material_audit.audit_agent.llm_available", lambda: True)
    monkeypatch.setattr("backend.modules.rule_generation.service.llm_available", lambda: False)


def test_rule_selection_failure_isolation_and_annotations(store):
    publish(store, [rule("first"), rule("failed"), rule("risk", review_scope="risk"), rule("off", enabled=False)])
    judge = Mock()
    judge.evaluate.side_effect = [decision(), RuntimeError("provider secret"), decision()]
    report = AuditAgent(store, judge).run(request())
    assert judge.evaluate.call_count == 3
    assert [result.status for result in report.results] == ["FAIL", "ERROR", "WARNING"]
    assert report.summary.ERROR == 1 and report.summary.total == 3
    assert report.rule_set_version == "v1"
    annotation = report.results[0].annotations[0]
    assert annotation.scope == "region" and annotation.region.x == 0.1
    assert annotation.location_verified is False
    assert "provider secret" not in report.model_dump_json()


def test_model_disabled_never_calls_judge(store):
    publish(store, [rule()])
    judge = Mock()
    result = AuditAgent(store, judge).run(request(use_llm=False))
    judge.evaluate.assert_not_called()
    assert result.summary.PASS == 0 and result.results[0].execution_status == "skipped"


def test_no_configuration_never_calls_judge(store, monkeypatch):
    monkeypatch.setattr("backend.modules.material_audit.audit_agent.llm_available", lambda: False)
    publish(store, [rule()])
    judge = Mock()
    result = AuditAgent(store, judge).run(request())
    judge.evaluate.assert_not_called()
    assert result.results[0].execution_status == "skipped"


def test_scope_filter_and_country_visa_isolation(store):
    publish(store, [rule("official"), rule("risk", review_scope="risk")])
    judge = Mock()
    judge.evaluate.return_value = decision()
    agent = AuditAgent(store, judge)
    result = agent.run(request(review_scopes=["risk"]))
    assert [item.rule_id for item in result.results] == ["risk"]
    assert agent.run(request(country="NO")).summary.total == 0
    assert agent.run(request(visa_type="business")).summary.total == 0


@pytest.mark.parametrize("evidence", [
    [{"material_id": "material-999", "explanation": "unknown"}],
    [{"material_id": "material-001", "page": 2, "explanation": "bad page"}],
    [],
])
def test_invalid_evidence_or_empty_pass_is_execution_error(store, evidence):
    publish(store, [rule()])
    judge = Mock()
    judge.evaluate.return_value = decision("PASS", evidence=evidence)
    assert AuditAgent(store, judge).run(request()).results[0].status == "ERROR"


@pytest.mark.parametrize("scope,expected", [("global", "global"), ("document", "document"), ("page", "page"), ("region", "region")])
def test_annotation_scope_limits(store, scope, expected):
    publish(store, [rule(annotation_scope=scope)])
    judge = Mock()
    judge.evaluate.return_value = decision()
    annotation = AuditAgent(store, judge).run(request()).results[0].annotations[0]
    assert annotation.scope == expected
    if scope != "region":
        assert annotation.region is None


def test_missing_material_issue_has_no_fake_box(store):
    publish(store, [rule()])
    judge = Mock()
    judge.evaluate.return_value = decision(evidence=[])
    annotation = AuditAgent(store, judge).run(request()).results[0].annotations[0]
    assert annotation.scope == "global" and annotation.material_id is None


def test_bad_rectangle_rejected():
    with pytest.raises(ValidationError):
        decision(evidence=[{"material_id": "material-001", "page": 1, "explanation": "bad",
                            "region": {"x": 0.9, "y": 0, "width": 0.5, "height": 1}}])


def test_rule_store_draft_publication_and_hot_reload(store):
    draft = RuleSet(country="IS", visa_type="schengen-tourism", version="v1", rules=[rule()])
    store.save_draft(draft)
    assert store.load("IS", "schengen-tourism") is None
    store.publish(draft)
    assert store.load("IS", "schengen-tourism").version == "v1"
    publish(store, [rule("new")], version="v2")
    assert store.load("IS", "schengen-tourism").rules[0].id == "new"
    assert len(list((store.root / "versions").glob("*.json"))) == 2
    with pytest.raises(FileExistsError):
        store.publish(draft)


def test_private_rules_cannot_be_published(store):
    with pytest.raises(ValueError):
        publish(store, [rule(requires_private_data=True)])
    assert store.load("IS", "schengen-tourism") is None


def test_store_rejects_bad_identity_and_corrupt_published_data(store):
    with pytest.raises(ValueError):
        store.load("../IS", "schengen-tourism")
    target = publish(store, [rule()])
    target.write_text("{}")
    result = AuditAgent(store, Mock()).run(request())
    assert result.agent_trace[-1].status == "failed"


def test_duplicate_material_ids_rejected():
    materials = request().model_dump()["materials"]
    with pytest.raises(ValidationError):
        request(materials=materials * 2)


def test_multimodal_adapter_sends_sanitized_content_and_rule(monkeypatch):
    call = Mock(return_value=decision().model_dump())
    monkeypatch.setattr("backend.modules.material_audit.rule_agent.call_content_json", call)
    result = LLMRuleAgent().evaluate(rule(), request().materials)
    assert result.status == "FAIL"
    content = call.call_args.kwargs["content"]
    assert content[1]["type"] == "image" and content[1]["source"]["type"] == "base64"
    assert json.loads(content[-1]["text"])["rule"]["id"] == "format"


def test_multimodal_adapter_rejects_size_mismatch(monkeypatch):
    materials = request().materials
    materials[0].sanitized_file.size = 1
    call = Mock()
    monkeypatch.setattr("backend.modules.material_audit.rule_agent.call_content_json", call)
    with pytest.raises(ValueError):
        LLMRuleAgent().evaluate(rule(), materials)
    call.assert_not_called()


def fake_generate(**kwargs):
    prompt = json.loads(kwargs["content"][0]["text"])
    source = prompt["sources"][0]
    item = rule().model_dump()
    item["sources"] = [{"file": source["file"], "sha256": source["sha256"], "excerpt": source["text"]}]
    return {key: prompt[key] for key in ("country", "visa_type", "version", "status")} | {"rules": [item]}


def test_generation_provenance_draft_then_publish(tmp_path, store):
    sources = tmp_path / "sources"
    sources.mkdir()
    (sources / "official.md").write_text("Synthetic official test requirement", encoding="utf-8")
    draft = generate_from_directory(sources, "IS", "schengen-tourism", store, fake_generate)
    parsed = RuleSet.model_validate_json(draft.read_text())
    assert parsed.rules[0].sources[0].file == "official.md"
    assert store.load("IS", "schengen-tourism") is None
    store.publish(parsed)
    assert store.load("IS", "schengen-tourism").version == parsed.version


def test_generation_rejects_hallucinated_source(tmp_path, store):
    sources = tmp_path / "sources"
    sources.mkdir()
    (sources / "notes.txt").write_text("Only source")
    def bad_generate(**kwargs):
        output = fake_generate(**kwargs)
        output["rules"][0]["sources"][0]["excerpt"] = "Invented requirement"
        return output
    with pytest.raises(ValueError):
        generate_from_directory(sources, "IS", "schengen-tourism", store, bad_generate)
    assert not (store.root / "drafts").exists()


def test_generation_without_model_writes_nothing(tmp_path, store):
    sources = tmp_path / "sources"
    sources.mkdir()
    (sources / "notes.txt").write_text("Only source")
    with pytest.raises(ValueError, match="LLM"):
        generate_from_directory(sources, "IS", "schengen-tourism", store)
    assert not store.root.exists()


def test_directory_empty_and_symlink_escape_rejected(tmp_path):
    directory = tmp_path / "input"
    directory.mkdir()
    with pytest.raises(ValueError):
        read_sources(directory)
    outside = tmp_path / "private.txt"
    outside.write_text("Do not read")
    (directory / "link.txt").symlink_to(outside)
    with pytest.raises(ValueError, match="symlink"):
        read_sources(directory)


def test_api_integrates_rule_report(store, monkeypatch):
    publish(store, [rule()])
    judge = Mock()
    judge.evaluate.return_value = decision()
    monkeypatch.setattr("backend.modules.material_audit.runner.agent", AuditAgent(store, judge))
    response = TestClient(app).post("/material-audit/run", json=request().model_dump())
    assert response.status_code == 200
    assert response.json()["results"][0]["annotations"][0]["scope"] == "region"


@pytest.mark.parametrize("raw,stop,valid", [
    ('{"ok": true}', "end_turn", True),
    ('```json\n{"ok": true}\n```', "end_turn", True),
    ('{"ok": true}', "max_tokens", False),
    ('not json', "end_turn", False),
    ('[]', "end_turn", False),
])
def test_provider_contract_timeout_and_output_validation(monkeypatch, raw, stop, valid):
    from backend.shared.llm import call_content_json
    client = Mock()
    client.with_options.return_value.messages.create.return_value = SimpleNamespace(
        stop_reason=stop, content=[SimpleNamespace(type="text", text=raw)],
    )
    wrapper = Mock()
    wrapper.__enter__ = Mock(return_value=client)
    wrapper.__exit__ = Mock(return_value=False)
    monkeypatch.setattr("backend.shared.llm._client", lambda: wrapper)
    if valid:
        assert call_content_json(system="test", content=[]) == {"ok": True}
    else:
        with pytest.raises(ValueError):
            call_content_json(system="test", content=[])
    client.with_options.assert_called_once_with(timeout=60.0, max_retries=0)
