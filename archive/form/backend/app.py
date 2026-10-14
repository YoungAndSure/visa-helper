#!/usr/bin/env python3
"""
visa-helper FastAPI 后端

薄代理：
- /healthz — 状态 + LLM 是否配置
- /suggest — 表单字段推荐 / LLM 内容核对
- /extract — 从指定 PDF 路径里抽取申请人上下文

设计原则：
- 不持久化任何 PII（无 DB）
- API key 仅从 env 读，绝不进 storage
- CORS allowlist：chrome-extension://* 和本地 dev origins
"""
from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .suggest import router as suggest_router
from .extract import router as extract_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("visa-helper.backend")

app = FastAPI(title="visa-helper backend", version="0.1.0")

# CORS：开发期允许 chrome-extension://* 和常见 localhost dev origins。
# 上线收紧到具体 extension ID。
ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:3000",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=r"^chrome-extension://[a-z]+$",  # 任何 extension id
    allow_credentials=False,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["Content-Type"],
)

app.include_router(suggest_router)
app.include_router(extract_router)


@app.get("/healthz")
def healthz() -> dict:
    """Liveness probe. 不调用 LLM。"""
    from .llm import llm_available
    return {
        "status": "ok",
        "llm_available": llm_available(),
    }


@app.get("/")
def root() -> dict:
    return {
        "service": "visa-helper backend",
        "endpoints": ["GET /healthz", "POST /suggest", "POST /extract"],
    }


def main() -> None:
    """uvicorn form.backend.app:app --reload 也能跑，这里给一个直接运行的入口。"""
    import uvicorn
    uvicorn.run("form.backend.app:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()
