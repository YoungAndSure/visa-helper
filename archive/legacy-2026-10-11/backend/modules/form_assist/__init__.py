"""form-assist module: 表单字段建议 + 申请人上下文抽取。

对外暴露：
- POST /form-assist/suggest  — 给字段标签，返回建议值
- POST /form-assist/extract  — 从 PDF 路径列表抽 ApplicantContext

实现位于 router.py / service.py / prompts.py / schemas.py。
"""
from .router import router

__all__ = ["router"]