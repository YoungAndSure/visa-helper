"""material-audit 的 checklist 数据访问。

Phase A2 阶段：仅从 audit/checklist.json 读 IS 清单（schema 已知）。
后续 Phase：多国清单各自 JSON 文件。
"""
from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path

from .schemas import ChecklistItem, ChecklistResponse

log = logging.getLogger("material_audit.checklist_store")

# 项目根 = form/backend/modules/material_audit/checklist_store.py → 上溯 4 层
_PROJECT_ROOT = Path(__file__).resolve().parents[4]


@lru_cache(maxsize=8)
def load_checklist(country: str) -> ChecklistResponse | None:
    """读 audit/checklist-<country>.json（或单文件 checklist.json）。

    返回 None 表示该国家尚无清单。
    """
    country = country.upper()

    # 优先按国家拆分的文件，否则落到通用 audit/checklist.json
    by_country = _PROJECT_ROOT / "audit" / f"checklist-{country}.json"
    common = _PROJECT_ROOT / "audit" / "checklist.json"

    path: Path | None = None
    if by_country.exists():
        path = by_country
    elif common.exists() and country == "IS":
        # 现状：checklist.json 是冰岛的；其他国家暂未拆出
        path = common
    if path is None:
        return None

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        log.exception("failed to read checklist at %s", path)
        return None

    items = [
        ChecklistItem(
            id=it["id"],
            description=it["description"],
            applies_to=it.get("applies_to"),
            condition=it.get("condition"),
            match_keywords=it.get("match_keywords", []),
        )
        for it in data.get("items", [])
    ]
    return ChecklistResponse(
        country=data.get("country", country),
        items=items,
        source=str(path.relative_to(_PROJECT_ROOT)),
    )


def clear_cache() -> None:
    """测试 / 开发期用：清 lru_cache。"""
    load_checklist.cache_clear()