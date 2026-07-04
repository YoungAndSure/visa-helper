"""form-assist 路由: /form-assist/*

- POST /form-assist/suggest   — form-fill 字段推荐
- POST /form-assist/extract   — 从 PDF 路径抽 ApplicantContext

挂载时使用 prefix='/form-assist'，所以 endpoint 写 '/suggest' '/extract' 即可。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter

from .extract_service import extract
from .schemas import (
    ExtractRequest,
    ExtractResponse,
    FormSuggestRequest,
    FormSuggestResponse,
)
from .service import suggest_form_fill

router = APIRouter()
log = logging.getLogger("form_assist.router")


@router.post("/suggest", response_model=FormSuggestResponse)
def suggest(req: FormSuggestRequest) -> FormSuggestResponse:
    return suggest_form_fill(req)


@router.post("/extract", response_model=ExtractResponse)
def extract_endpoint(req: ExtractRequest) -> ExtractResponse:
    return extract(req)