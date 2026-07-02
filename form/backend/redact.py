"""
PII redaction.

把 passport / ID 号 / 银行卡号之类的敏感数字串从发往 LLM 的 prompt 中替换掉。
不改 applicant_context 内部值——LLM 看不到，但 fill-back 时仍使用真实值。

仅做简单正则。误杀可接受（用户能在 UI 里修正），漏杀则要靠 LLM 端的 policy。
"""
from __future__ import annotations

import re

# 中国身份证号（18 位，最后一位可能 X）
ID_CARD_CN = re.compile(r"\b\d{17}[\dXx]\b")
# 护照（中国护照常见 EK/EJ/EA 等双字母前缀 + 8 位数字；其他字母 + 7-9 位数字）
PASSPORT = re.compile(r"\b[A-Z]{1,2}\d{7,9}\b")
# 银行卡 16-19 位连续数字（不在日期、邮编情境下准确，但 prompt 内大多是这些）
BANK_CARD = re.compile(r"\b\d{16,19}\b")
# 邮箱
EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
# 11 位中国手机号
PHONE_CN = re.compile(r"\b1[3-9]\d{9}\b")


def redact_pii(text: str) -> str:
    """替换常见 PII 模式为占位符。"""
    if not text:
        return text
    text = ID_CARD_CN.sub("[ID]", text)
    text = PASSPORT.sub("[PASSPORT]", text)
    text = BANK_CARD.sub("[BANK_ACCT]", text)
    text = EMAIL.sub("[EMAIL]", text)
    text = PHONE_CN.sub("[PHONE]", text)
    return text


def redact_applicant_context(ctx: dict) -> dict:
    """把 applicant_context 复制一份再脱敏（不修改入参）。"""
    import copy
    out = copy.deepcopy(ctx)
    pii_keys = ("passport_no", "id_card_no", "phone", "phone_no", "bank_acct_no")
    for k in pii_keys:
        if k in out and isinstance(out[k], str) and out[k]:
            out[k] = "[REDACTED]"
    # 任何 string 字段再走一遍正则清理
    def scrub(o):
        if isinstance(o, dict):
            return {k: scrub(v) for k, v in o.items()}
        if isinstance(o, list):
            return [scrub(v) for v in o]
        if isinstance(o, str):
            return redact_pii(o)
        return o
    return scrub(out)
