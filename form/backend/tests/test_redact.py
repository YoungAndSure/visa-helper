"""Tests for redact.py — PII redaction.

⚠️  本文件仅含合成 PII。严禁用真实证件号 / 姓名 / 手机 / 身份证号。
    提交前请确保："ID 1234… / Passport XX1234567 / 13800000000 / DOE" 等都是 fake。
"""
from form.backend.shared.redact import redact_pii, redact_applicant_context


def test_redact_pii_passes_through_normal_text():
    assert redact_pii("Hello world") == "Hello world"


def test_redact_pii_chinese_id():
    out = redact_pii("ID 123456789012345678")
    assert "123456789012345678" not in out
    assert "[ID]" in out


def test_redact_pii_passport():
    out = redact_pii("Passport XX1234567")
    assert "XX1234567" not in out
    assert "[PASSPORT]" in out


def test_redact_pii_email():
    out = redact_pii("reach me at test@example.com anytime")
    assert "test@example.com" not in out
    assert "[EMAIL]" in out


def test_redact_pii_phone_cn():
    out = redact_pii("call 13800000000 ok?")
    assert "13800000000" not in out
    assert "[PHONE]" in out


def test_redact_pii_bank_card():
    out = redact_pii("card 6222020000000000000 end")
    assert "6222020000000000000" not in out
    assert "[BANK_ACCT]" in out


def test_redact_applicant_context_does_not_mutate_input():
    src = {"surname_romanized": "DOE", "passport_no": "XX1234567"}
    out = redact_applicant_context(src)
    assert src["passport_no"] == "XX1234567", "must not mutate input"
    assert out["passport_no"] == "[REDACTED]"


def test_redact_applicant_context_preserves_unrelated_keys():
    out = redact_applicant_context({"surname_romanized": "DOE"})
    assert out["surname_romanized"] == "DOE"


def test_redact_applicant_context_scrubs_nested_strings():
    out = redact_applicant_context({"notes": "see passport XX1234567"})
    assert "XX1234567" not in out["notes"]
    assert "[PASSPORT]" in out["notes"]
