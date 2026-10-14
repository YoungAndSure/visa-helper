"""Tests for the /suggest endpoint via TestClient. Mocks LLM."""
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
    assert any("/suggest" in e for e in endpoints)
    assert any("/extract" in e for e in endpoints)


@patch("form.backend.suggest.call_json")
def test_suggest_form_fill_returns_value(mock_call_json, client):
    mock_call_json.return_value = {
        "value": "DOE",
        "rationale": "上下文已有罗马拼音姓氏",
        "confidence": 0.95,
    }
    with patch("form.backend.suggest.llm_available", return_value=True):
        r = client.post("/suggest", json={
            "mode": "form-fill",
            "field_label": "Surname (姓)",
            "applicant_context": {"surname_romanized": "DOE"},
        })
    assert r.status_code == 200
    body = r.json()
    assert body["value"] == "DOE"
    assert mock_call_json.called


@patch("form.backend.suggest.call_json")
def test_suggest_audit_verify_yields_yes(mock_call_json, client):
    mock_call_json.return_value = {
        "value": "YES",
        "rationale": "段落标题包含银行流水",
        "confidence": 0.9,
    }
    with patch("form.backend.suggest.llm_available", return_value=True):
        r = client.post("/suggest", json={
            "mode": "audit-verify",
            "field_label": "(audit mode — label unused)",
            "applicant_context": {},
            "requirement": "近 3 个月银行流水",
            "pdf_text_snippet": "<BANK> 客户姓名 <NAME> ...",
        })
    assert r.status_code == 200
    body = r.json()
    assert body["value"] == "YES"


def test_suggest_form_fill_without_llm_returns_explanation(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "")
    # In a clean env the importer still calls anthropic so make llm_available False
    with patch("form.backend.suggest.llm_available", return_value=False):
        r = client.post("/suggest", json={
            "mode": "form-fill",
            "field_label": "Surname",
            "applicant_context": {},
        })
    assert r.status_code == 200
    body = r.json()
    assert body["value"] is None
    assert "LLM" in body["rationale"]
