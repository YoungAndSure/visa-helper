"""form-assist 的 extract 服务：从 PDF 路径抽 ApplicantContext。

本模块原位于 backend/extract.py，Phase A3 搬过来。
"""
from __future__ import annotations

import logging
from pathlib import Path

from ...shared.llm import call_json, llm_available
from .schemas import ApplicantContext, ExtractRequest, ExtractResponse

log = logging.getLogger("form_assist.extract")


_SYSTEM = """\
你是一个签证材料抽取助手。你会看到一组 PDF 文本片段，每个文件来自某个申请人。
任务是：从文本中抽取常见的签证申请字段，输出严格 JSON。

字段定义：
- full_name              申请人中文姓名
- full_name_romanized    申请人罗马拼音姓名（护照写法）
- passport_no            护照号码
- id_card_no             中国身份证号
- dob                    出生日期 ISO 8601
- nationality            国籍（如 CHINA）
- occupation             职业
- employer               雇主 / 学校
- address                居住地址
- phone                  电话

如果文本里某字段没有出现，留 null。不要凭空猜测。
如果有多个申请人，按文件名分组输出。
任何不确定的字段宁可 null 也别瞎填。

严格只输出 JSON：
{
  "applicants": {
    "<申请人名(目录名) or 'unknown'>": { ... 上述字段 ... }
  }
}
"""


def extract(req: ExtractRequest) -> ExtractResponse:
    if not req.pdf_paths:
        return ExtractResponse(applicants={}, warnings=["pdf_paths 不能为空"])

    # 读每个 PDF 的前 2 页
    chunks: list[tuple[str, str]] = []
    warnings: list[str] = []
    for p in req.pdf_paths:
        try:
            text = _pdf_snippet(Path(p))
        except Exception as e:
            warnings.append(f"{p}: {e}")
            continue
        if not text.strip():
            warnings.append(f"{p}: 文本为空（可能是扫描件）")
            continue
        chunks.append((p, text))

    if not chunks:
        return ExtractResponse(applicants={}, warnings=warnings)

    if not llm_available():
        return ExtractResponse(
            applicants={},
            warnings=warnings + ["LLM 未配置，无法自动抽取。请手动录入。"],
        )

    user = "申请人提示名: " + (req.applicant_hint or "(未指定)") + "\n\n材料片段:\n\n"
    for i, (path, text) in enumerate(chunks, 1):
        user += f"--- 文件 #{i}: {Path(path).name} ---\n{text[:1500]}\n\n"

    try:
        out = call_json(
            system=_SYSTEM,
            user=user,
            schema_hint='{"applicants": {"<name>": {<fields>}}}',
            max_tokens=1500,
        )
        raw_apps = out.get("applicants") or {}
        applicants: dict[str, ApplicantContext] = {}
        for name, ctx in raw_apps.items():
            if not isinstance(ctx, dict):
                continue
            known = {f: ctx.get(f) for f in ApplicantContext.model_fields if f != "extra"}
            extra = {
                k: str(v) for k, v in ctx.items()
                if k not in ApplicantContext.model_fields and isinstance(v, (str, int, float))
            }
            applicants[str(name)] = ApplicantContext(**known, extra=extra)
        return ExtractResponse(applicants=applicants, warnings=warnings)
    except Exception as e:
        log.exception("extract failed")
        return ExtractResponse(
            applicants={},
            warnings=warnings + [f"LLM 调用失败: {e}"],
        )


def _pdf_snippet(p: Path, max_chars: int = 2000) -> str:
    """抽 PDF 前 2 页文本，截断到 max_chars。与 audit/audit.py 同口径。"""
    if not p.exists():
        return ""
    try:
        import pdfplumber
        with pdfplumber.open(p) as pdf:
            text = "\n".join((page.extract_text() or "") for page in pdf.pages[:2])
    except Exception as e:
        raise RuntimeError(f"PDF 读取失败: {e}") from e
    return text[:max_chars]