"""Tests for the new module-scoped endpoints via TestClient. Mocks LLM.

Phase A2 拆分后：
- /form-assist/suggest    ← 原 /suggest?mode=form-fill
- /material-audit/verify  ← 原 /suggest?mode=audit-verify
"""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from form.backend.app import app


@pytest.fixture
def client():
    return TestClient(app)


def test_healthz_reports_status(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "llm_available" in body


def test_root_lists_endpoints(client):
    r = client.get("/")
    assert r.status_code == 200
    endpoints = r.json()["endpoints"]
    # 不再有裸 /suggest、/extract；统一带 module 前缀
    assert any("/form-assist/suggest" in e for e in endpoints)
    assert any("/form-assist/extract" in e for e in endpoints)
    assert any("/material-audit/verify" in e for e in endpoints)
    assert any("/material-audit/run" in e for e in endpoints)


# ---------- form-assist ----------
@patch("form.backend.modules.form_assist.service.call_json")
def test_form_assist_suggest_returns_value(mock_call_json, client):
    mock_call_json.return_value = {
        "value": "DOE",
        "rationale": "上下文已有罗马拼音姓氏",
        "confidence": 0.95,
    }
    with patch("form.backend.modules.form_assist.service.llm_available", return_value=True):
        r = client.post("/form-assist/suggest", json={
            "field_label": "Surname (姓)",
            "applicant_context": {"surname_romanized": "DOE"},
        })
    assert r.status_code == 200
    body = r.json()
    assert body["value"] == "DOE"
    assert mock_call_json.called


def test_form_assist_suggest_without_llm_returns_explanation(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "")
    with patch("form.backend.modules.form_assist.service.llm_available", return_value=False):
        r = client.post("/form-assist/suggest", json={
            "field_label": "Surname",
            "applicant_context": {},
        })
    assert r.status_code == 200
    body = r.json()
    assert body["value"] is None
    assert "LLM" in body["rationale"]


def test_form_assist_extract_empty_paths_returns_warning(client):
    """/form-assist/extract 不抛 500,空 applicants + warning。"""
    r = client.post("/form-assist/extract", json={
        "pdf_paths": ["/nonexistent/passport.pdf"],
        "applicant_hint": None,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["applicants"] == {}
    assert len(body["warnings"]) > 0  # 至少一条 PDF 读取失败的 warning


# ---------- material-audit ----------
@patch("form.backend.modules.material_audit.service.call_json")
def test_material_audit_verify_yields_yes(mock_call_json, client):
    mock_call_json.return_value = {
        "value": "YES",
        "rationale": "段落标题包含银行流水",
        "confidence": 0.9,
    }
    with patch("form.backend.modules.material_audit.service.llm_available", return_value=True):
        r = client.post("/material-audit/verify", json={
            "requirement": "近 3 个月银行流水",
            "pdf_text_snippet": "<BANK> 客户姓名 <NAME> ...",
        })
    assert r.status_code == 200
    body = r.json()
    assert body["value"] == "YES"


def test_material_audit_verify_without_llm_returns_uncertain(client):
    with patch("form.backend.modules.material_audit.service.llm_available", return_value=False):
        r = client.post("/material-audit/verify", json={
            "requirement": "保险",
            "pdf_text_snippet": "<INSURANCE> ...",
        })
    assert r.status_code == 200
    body = r.json()
    assert body["value"] == "UNCERTAIN"


def test_material_audit_checklist_known_country(client):
    r = client.get("/material-audit/checklist", params={"country": "IS"})
    assert r.status_code == 200
    body = r.json()
    assert body["country"] == "Iceland"
    assert len(body["items"]) > 0


def test_material_audit_checklist_unknown_country_404(client):
    r = client.get("/material-audit/checklist", params={"country": "ZZ"})
    assert r.status_code == 404


def test_material_audit_run_stub_returns_warning(client):
    r = client.post("/material-audit/run", json={
        "country": "IS",
        "materials_dir": "/tmp/iceland",
        "use_llm": False,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["country"] == "IS"
    assert body["summary"]["total"] == 0
    assert any("stub" in w for w in body["summary"]["warnings"])