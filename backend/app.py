#!/usr/bin/env python3
"""
visa-helper FastAPI 后端

薄代理，按业务模块拆：
- /form-assist/*   → form_assist module（字段推荐、PDF 上下文抽取）
- /material-audit/* → material_audit module（材料审核、内容核对）
- /healthz         → shared infra（liveness + LLM 是否配置）

请求日志中间件（access_log）：每个进来的请求打日志（方法、路径、body 摘要、耗时、
响应状态），便于跟前端联调。请求正文默认不记录；敏感接口即使显式开启也不记录。

日志落盘：所有日志（本服务 + uvicorn）统一写到 LOG_FILE（默认 backend/logs/backend.log），
同时保留控制台输出。设 LOG_FILE="" 可只输出到控制台。

设计原则：
- 不持久化任何 PII（无 DB）
- API key 仅从 env 读，绝不进 storage
- CORS allowlist：chrome-extension://* 和本地 dev origins
"""
from __future__ import annotations

import logging
import os
import time
from typing import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .modules.form_assist import router as form_assist_router
from .modules.material_audit import router as material_audit_router

# 日志格式: 人类可读 + 时间戳。Level: INFO 看 access log，DEBUG 看细节。
# 所有日志（本服务 + uvicorn）统一写到一个文件 LOG_FILE（默认 backend/logs/backend.log），
# 同时保留控制台输出。LOG_FILE 为空串则只输出到控制台。
_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"
LOG_FILE = os.environ.get(
    "LOG_FILE",
    os.path.join(os.path.dirname(__file__), "logs", "backend.log"),
)

_handlers: list[logging.Handler] = [logging.StreamHandler()]
if LOG_FILE:
    os.makedirs(os.path.dirname(os.path.abspath(LOG_FILE)), exist_ok=True)
    _handlers.append(logging.FileHandler(LOG_FILE, encoding="utf-8"))

logging.basicConfig(level=logging.INFO, format=_LOG_FORMAT, handlers=_handlers)

# 让 uvicorn 自己的 logger（uvicorn / uvicorn.access / uvicorn.error）也落到同一文件：
# 关掉它们的独立 handler、打开 propagate，交给 root 统一处理。
for _name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
    _uv = logging.getLogger(_name)
    _uv.handlers.clear()
    _uv.propagate = True

log = logging.getLogger("visa-helper.backend")
access_log = logging.getLogger("visa-helper.access")
if LOG_FILE:
    log.info("logging to file: %s", os.path.abspath(LOG_FILE))

# 是否打印普通请求 body — 默认关闭；仅显式设 LOG_BODIES=1 时开启。
# 涉及材料和申请人信息的接口始终不打印 body，避免安全 JSON/PII 进入日志。
LOG_BODIES = os.environ.get("LOG_BODIES", "0") == "1"
LOG_BODY_MAX = int(os.environ.get("LOG_BODY_MAX", "500"))
SENSITIVE_BODY_PATHS = {
    "/material-audit/run",
    "/material-audit/verify",
    "/form-assist/extract",
    "/form-assist/suggest",
}

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

# 业务路由 — 每个 module 一个 prefix；module 内部自己写 endpoint。
app.include_router(form_assist_router, prefix="/form-assist")
app.include_router(material_audit_router, prefix="/material-audit")

# 静态前端 — 材料审核页面，同源挂在 /ui（html=True 使 /ui 直接返回 index.html）。
# 用户浏览器访问 http://localhost:8000/ui 即可用，无需单独前端 server / 无 CORS。
_STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
app.mount("/ui", StaticFiles(directory=_STATIC_DIR, html=True), name="ui")


# ---------- 请求日志中间件 ----------
@app.middleware("http")
async def access_log_middleware(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    """每个请求打两行日志：
      → METHOD path [body...]
      ← METHOD path status=<code> dur=<ms>ms

    body 截断到 LOG_BODY_MAX 字符(默认 500),避免大 payload 淹没日志。
    """
    t0 = time.perf_counter()
    body_preview = ""
    if (
        LOG_BODIES
        and request.url.path not in SENSITIVE_BODY_PATHS
        and request.method in {"POST", "PUT", "PATCH"}
    ):
        try:
            raw = await request.body()
            if raw:
                body_preview = raw.decode("utf-8", errors="replace")
                if len(body_preview) > LOG_BODY_MAX:
                    body_preview = body_preview[:LOG_BODY_MAX] + f"... <+{len(body_preview) - LOG_BODY_MAX} chars>"
        except Exception as e:
            body_preview = f"<read failed: {e}>"
    access_log.info("→ %s %s%s", request.method, request.url.path, "  body=" + repr(body_preview) if body_preview else "")

    response = await call_next(request)

    dur_ms = (time.perf_counter() - t0) * 1000
    access_log.info(
        "← %s %s  status=%d  dur=%.1fms",
        request.method, request.url.path, response.status_code, dur_ms,
    )
    return response


@app.get("/healthz")
def healthz() -> dict:
    """Liveness probe. 不调用 LLM。"""
    from .shared.llm import llm_available
    return {
        "status": "ok",
        "llm_available": llm_available(),
    }


@app.get("/")
def root() -> dict:
    return {
        "service": "visa-helper backend",
        "ui": "GET  /ui  (材料审核前端页面)",
        "endpoints": [
            "GET  /healthz",
            "GET  /ui  (静态前端)",
            "POST /form-assist/suggest",
            "POST /form-assist/extract",
            "POST /material-audit/verify",
            "POST /material-audit/run",
            "GET  /material-audit/checklist?country=<IS|NO|...>",
        ],
    }


def main() -> None:
    """uvicorn backend.app:app --reload 也能跑，这里给一个直接运行的入口。"""
    import uvicorn
    uvicorn.run("backend.app:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()
