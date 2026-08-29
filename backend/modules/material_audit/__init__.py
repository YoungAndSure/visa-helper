"""material-audit module: 材料审核 + 内容核对。

对外暴露：
- POST /material-audit/verify   — 单项 LLM 内容核对
- POST /material-audit/run      — 跑全量材料审核
- GET  /material-audit/checklist — 拉某国的 checklist

实现位于 router.py / service.py / prompts.py / schemas.py / checklist_store.py /
audit_agent.py / runner.py。
"""
from .router import router

__all__ = ["router"]
