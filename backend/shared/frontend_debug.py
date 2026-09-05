"""Receive browser-side debug events and write them into the unified backend log."""

from __future__ import annotations

import json
import logging
from typing import Any, Literal

from fastapi import APIRouter, Response, status
from pydantic import BaseModel, ConfigDict, Field


router = APIRouter()
log = logging.getLogger("visa-helper.frontend")


class FrontendDebugEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sequence: int = Field(ge=1)
    client_timestamp: str = Field(min_length=1, max_length=80)
    client_epoch_ms: float = Field(ge=0)
    client_monotonic_ms: float = Field(ge=0)
    run_id: str = Field(min_length=1, max_length=120)
    scope: str = Field(min_length=1, max_length=80)
    event: str = Field(min_length=1, max_length=120)
    level: Literal["debug", "info", "warning", "error"] = "info"
    message: str = Field(default="", max_length=4000)
    details: dict[str, Any] = Field(default_factory=dict)


_LEVELS = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warning": logging.WARNING,
    "error": logging.ERROR,
}


@router.post("/frontend-log", status_code=status.HTTP_204_NO_CONTENT)
def write_frontend_log(event: FrontendDebugEvent) -> Response:
    details = json.dumps(
        event.details,
        ensure_ascii=False,
        separators=(",", ":"),
        default=str,
    )
    log.log(
        _LEVELS[event.level],
        "client_ts=%s epoch_ms=%.3f mono_ms=%.3f seq=%d run=%s scope=%s "
        "event=%s message=%s details=%s",
        event.client_timestamp,
        event.client_epoch_ms,
        event.client_monotonic_ms,
        event.sequence,
        event.run_id,
        event.scope,
        event.event,
        json.dumps(event.message, ensure_ascii=False),
        details,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
