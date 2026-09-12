"""
LLM 客户端封装。

环境变量（与旧版 tools/material_audit/audit.py 保持一致）：
- ANTHROPIC_BASE_URL          e.g. https://api.minimaxi.com/anthropic
- ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY
- ANTHROPIC_MODEL              大模型
- ANTHROPIC_SMALL_FAST_MODEL   小模型（备用）

设计要点：
- 每次调用按需 import anthropic（节省冷启动）
- 任何 prompt 文本都应先经过 redact_pii() 脱敏（见 redact.py）
- 该模块不动也不上报，不写日志但调用层负责记录 verdict
"""
from __future__ import annotations

import os
from typing import Any


def llm_available() -> bool:
    """是否配置了 API key。

    LOG_ONLY=1 → 强制返回 False,所有 endpoint 走 mock 分支,不调 LLM。
    适用于: 本地联调前端(避免烧 token)/ CI 跑测试。
    """
    if os.environ.get("LOG_ONLY", "0") == "1":
        return False
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False
    return bool(
        os.environ.get("ANTHROPIC_AUTH_TOKEN")
        or os.environ.get("ANTHROPIC_API_KEY")
    )


def _client():
    """构造 Anthropic 客户端，按 env vars。"""
    import anthropic
    base_url = os.environ.get("ANTHROPIC_BASE_URL")
    auth_token = (
        os.environ.get("ANTHROPIC_AUTH_TOKEN")
        or os.environ.get("ANTHROPIC_API_KEY")
    )
    return anthropic.Anthropic(api_key=auth_token, base_url=base_url)


def default_model() -> str:
    return (
        os.environ.get("ANTHROPIC_MODEL")
        or os.environ.get("ANTHROPIC_SMALL_FAST_MODEL")
        or "claude-sonnet-4-6"
    )


def call_text(
    *,
    system: str,
    user: str,
    model: str | None = None,
    max_tokens: int = 500,
) -> str:
    """最小文本调用；返回 assistant 的纯文本。"""
    client = _client()
    msg = client.messages.create(
        model=model or default_model(),
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    if not msg.content:
        return ""
    # content may be a list of TextBlock / ToolUseBlock; we want only the text
    parts: list[str] = []
    for block in msg.content:
        text = getattr(block, "text", None)
        if text:
            parts.append(text)
    return "\n".join(parts).strip()


def call_json(
    *,
    system: str,
    user: str,
    schema_hint: str,
    model: str | None = None,
    max_tokens: int = 800,
) -> dict[str, Any]:
    """JSON-schema 调用：在 system 里指定 schema，用花括号强制输出。

    返回解析后的 dict；解析失败抛 ValueError。
    """
    raw = call_text(
        system=f"{system}\n\n输出格式：只返回严格 JSON（不要 markdown 代码块）。{schema_hint}",
        user=user,
        model=model,
        max_tokens=max_tokens,
    )
    # 兜底：即便有 ```json 包装也去掉
    raw = raw.strip()
    if raw.startswith("```"):
        # 去掉第一行的 ```json 或 ``` 和最后的 ```
        lines = raw.splitlines()
        raw = "\n".join(lines[1:-1]) if len(lines) >= 2 else raw
    import json
    return json.loads(raw)


def call_content_json(*, system: str, content: list[dict[str, Any]], max_tokens: int = 3000) -> dict[str, Any]:
    """Bounded multimodal call; no file upload API or persistent model session."""
    import json
    with _client() as client:
        message = client.with_options(timeout=60.0, max_retries=0).messages.create(
            model=default_model(), max_tokens=max_tokens, system=system,
            messages=[{"role": "user", "content": content}],
        )
    if message.stop_reason != "end_turn":
        raise ValueError("model response incomplete")
    raw = "\n".join(block.text for block in message.content if getattr(block, "type", None) == "text").strip()
    if raw.startswith("```") and raw.endswith("```"):
        raw = "\n".join(raw.splitlines()[1:-1])
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError("expected a JSON object")
    return result
