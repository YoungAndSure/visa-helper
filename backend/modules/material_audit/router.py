"""material-audit 路由: /material-audit/*

- POST /material-audit/verify    — 单条 LLM 内容核对
- POST /material-audit/run       — 跑全量材料审核（Phase A2 stub,Phase D 实装）
- GET  /material-audit/checklist — 拉某国要求清单

挂载时使用 prefix='/material-audit'。
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException

from .checklist_store import load_checklist
from .runner import run_audit
from .schemas import (
    ChecklistResponse,
    RunRequest,
    RunResponse,
    VerifyRequest,
    VerifyResponse,
)
from .service import verify_item

router = APIRouter()
log = logging.getLogger("material_audit.router")


@router.post("/verify", response_model=VerifyResponse)
def verify(req: VerifyRequest) -> VerifyResponse:
    return verify_item(req)


@router.get("/checklist", response_model=Optional[ChecklistResponse])
def get_checklist(country: str) -> ChecklistResponse | None:
    """返回指定国家的 checklist；找不到返回 404。"""
    resp = load_checklist(country)
    if resp is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"no checklist for country={country!r}; "
                "run tools/checklist/import_checklist.py first"
            ),
        )
    return resp


@router.post("/run", response_model=RunResponse)
def run(req: RunRequest) -> RunResponse:
    return run_audit(req)
