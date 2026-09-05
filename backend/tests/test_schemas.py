"""Tests for the new module-scoped endpoints via TestClient. Mocks LLM.

Phase A2 拆分后：
- /form-assist/suggest    ← 原 /suggest?mode=form-fill
- /material-audit/verify  ← 原 /suggest?mode=audit-verify
"""
import importlib
import logging
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from backend.app import app


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
    assert any("/debug/frontend-log" in e for e in endpoints)


def test_frontend_debug_event_is_written_with_client_timestamp(client, caplog):
    with caplog.at_level(logging.INFO, logger="visa-helper.frontend"):
        response = client.post("/debug/frontend-log", json={
            "sequence": 7,
            "client_timestamp": "2026-09-05T10:12:13.456Z",
            "client_epoch_ms": 1788603133456,
            "client_monotonic_ms": 1234.567,
            "run_id": "local-audit-test-run",
            "scope": "local-audit",
            "event": "pdf.page.text-layer.checked",
            "level": "info",
            "message": "",
            "details": {
                "file_name": "lotus_new.pdf",
                "page_number": 2,
                "duration_ms": 18.25,
            },
        })
    assert response.status_code == 204
    assert "client_ts=2026-09-05T10:12:13.456Z" in caplog.text
    assert "event=pdf.page.text-layer.checked" in caplog.text
    assert "lotus_new.pdf" in caplog.text


# ---------- form-assist ----------
@patch("backend.modules.form_assist.service.call_json")
def test_form_assist_suggest_returns_value(mock_call_json, client):
    mock_call_json.return_value = {
        "value": "DOE",
        "rationale": "上下文已有罗马拼音姓氏",
        "confidence": 0.95,
    }
    with patch("backend.modules.form_assist.service.llm_available", return_value=True):
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
    with patch("backend.modules.form_assist.service.llm_available", return_value=False):
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
@patch("backend.modules.material_audit.service.call_json")
def test_material_audit_verify_yields_yes(mock_call_json, client):
    mock_call_json.return_value = {
        "value": "YES",
        "rationale": "段落标题包含银行流水",
        "confidence": 0.9,
    }
    with patch("backend.modules.material_audit.service.llm_available", return_value=True):
        r = client.post("/material-audit/verify", json={
            "requirement": "近 3 个月银行流水",
            "pdf_text_snippet": "<BANK> 客户姓名 <NAME> ...",
        })
    assert r.status_code == 200
    body = r.json()
    assert body["value"] == "YES"


def test_material_audit_verify_without_llm_returns_uncertain(client):
    with patch("backend.modules.material_audit.service.llm_available", return_value=False):
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
    assert body["source"] == (
        "data/checklists/parsed/checklist-IS-schengen-tourism.json"
    )


def test_material_audit_checklist_unknown_country_404(client):
    r = client.get("/material-audit/checklist", params={"country": "ZZ"})
    assert r.status_code == 404


def test_material_audit_run_returns_fake_results(client):
    """/run 当前返回基于 checklist 的 FAKE 示例结果（真实逻辑待实装）。

    校验：结构完整（total == checklist 项数、逐项有 status）、
    summary 各状态计数自洽、且带 FAKE 提示 warning。
    """
    r = client.post("/material-audit/run", json={
        "country": "IS",
        "materials_dir": "/tmp/iceland",
        "use_llm": False,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["country"] == "IS"

    summary = body["summary"]
    total = summary["total"]
    assert total > 0
    assert len(body["results"]) == total
    # 各状态计数加起来 == total
    assert summary["PASS"] + summary["FAIL"] + summary["WARNING"] + summary["N_A"] == total
    # 每条结果都有合法 status
    assert all(item["status"] in {"PASS", "FAIL", "WARNING", "N/A"} for item in body["results"])
    # 明确标注为示例数据
    assert any("FAKE" in w or "示例" in w for w in summary["warnings"])


def test_material_audit_run_accepts_reviewed_privacy_safe_materials(client):
    response = client.post("/material-audit/run", json={
        "schema_version": "privacy-files/v1",
        "country": "IS",
        "visa_type": "schengen-tourism",
        "materials": [{
            "material_id": "material-001",
            "source_ref": "local-file-001",
            "media_type": "application/pdf",
            "kind": "pdf",
            "sanitized_file": {
                "media_type": "application/pdf",
                "content": "data:application/pdf;base64,JVBERi0xLjQKc2FuaXRpemVk",
                "size": 24,
                "page_count": 1,
                "redaction_count": 2,
            },
            "review_status": "ready",
        }],
        "privacy": {
            "processed_locally": True,
            "raw_files_uploaded": False,
            "user_reviewed": True,
            "redaction_engine": "browser-ocr-manual-v1",
        },
        "review_scopes": ["checklist", "risk"],
        "use_llm": False,
    })
    assert response.status_code == 200
    body = response.json()
    assert body["results"][0]["matched"] == ["local-file-001"]
    assert [step["name"] for step in body["agent_trace"]] == [
        "privacy_intake",
        "checklist_review",
        "knowledge_retrieval",
        "model_review",
        "report",
    ]
    assert body["agent_trace"][0]["status"] == "completed"
    assert body["agent_trace"][2]["status"] == "pending"


def test_material_audit_rejects_unreviewed_materials(client):
    response = client.post("/material-audit/run", json={
        "country": "IS",
        "materials": [{
            "material_id": "material-001",
            "source_ref": "local-file-001",
            "kind": "image",
            "media_type": "image/jpeg",
            "sanitized_file": {
                "media_type": "image/jpeg",
                "content": "data:image/jpeg;base64,/9j/c2FuaXRpemVkLWltYWdl",
                "size": 24,
                "page_count": 1,
                "redaction_count": 1,
            },
            "review_status": "ready",
        }],
        "privacy": {
            "processed_locally": True,
            "raw_files_uploaded": False,
            "user_reviewed": False,
        },
    })
    assert response.status_code == 422


def test_material_audit_rejects_original_filename_field(client):
    response = client.post("/material-audit/run", json={
        "country": "IS",
        "materials": [{
            "material_id": "material-001",
            "source_ref": "local-file-001",
            "kind": "image",
            "media_type": "image/jpeg",
            "name": "真实姓名-bank-statement.pdf",
            "sanitized_file": {
                "media_type": "image/jpeg",
                "content": "data:image/jpeg;base64,/9j/c2FuaXRpemVkLWltYWdl",
                "size": 24,
                "page_count": 1,
                "redaction_count": 1,
            },
            "review_status": "ready",
        }],
        "privacy": {
            "processed_locally": True,
            "raw_files_uploaded": False,
            "user_reviewed": True,
        },
    })
    assert response.status_code == 422


def test_material_audit_rejects_mismatched_sanitized_media_type(client):
    response = client.post("/material-audit/run", json={
        "country": "IS",
        "materials": [{
            "material_id": "material-001",
            "source_ref": "local-file-001",
            "kind": "pdf",
            "media_type": "application/pdf",
            "sanitized_file": {
                "media_type": "image/jpeg",
                "content": "data:image/jpeg;base64,/9j/c2FuaXRpemVkLWltYWdl",
                "size": 24,
                "page_count": 1,
                "redaction_count": 1,
            },
            "review_status": "ready",
        }],
        "privacy": {
            "processed_locally": True,
            "raw_files_uploaded": False,
            "user_reviewed": True,
        },
    })
    assert response.status_code == 422


def test_material_audit_rejects_non_data_url_file_content(client):
    response = client.post("/material-audit/run", json={
        "country": "IS",
        "materials": [{
            "material_id": "material-001",
            "source_ref": "local-file-001",
            "kind": "image",
            "media_type": "image/jpeg",
            "sanitized_file": {
                "media_type": "image/jpeg",
                "content": "RAW-CONTENT-MUST-NOT-PASS-VALIDATION",
                "size": 24,
                "page_count": 1,
                "redaction_count": 1,
            },
            "review_status": "ready",
        }],
        "privacy": {
            "processed_locally": True,
            "raw_files_uploaded": False,
            "user_reviewed": True,
        },
    })
    assert response.status_code == 422


def test_material_audit_rejects_unready_sanitized_file(client):
    response = client.post("/material-audit/run", json={
        "country": "IS",
        "materials": [{
            "material_id": "material-001",
            "source_ref": "local-file-001",
            "kind": "image",
            "media_type": "image/jpeg",
            "sanitized_file": {
                "media_type": "image/jpeg",
                "content": "data:image/jpeg;base64,/9j/c2FuaXRpemVkLWltYWdl",
                "size": 24,
                "page_count": 1,
                "redaction_count": 1,
            },
            "review_status": "needs_review",
        }],
        "privacy": {
            "processed_locally": True,
            "raw_files_uploaded": False,
            "user_reviewed": True,
        },
    })
    assert response.status_code == 422


def test_sensitive_material_body_never_enters_access_log(client, monkeypatch, caplog):
    app_module = importlib.import_module("backend.app")
    monkeypatch.setattr(app_module, "LOG_BODIES", True)
    secret = "RAW-SECRET-MUST-NOT-BE-LOGGED"
    with caplog.at_level(logging.INFO, logger="visa-helper.access"):
        response = client.post("/material-audit/run", json={
            "country": "IS",
            "unexpected_raw_content": secret,
        })
    assert response.status_code == 422
    assert secret not in caplog.text
