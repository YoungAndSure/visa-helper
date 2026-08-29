"""material-audit 的 Checklist 数据访问。"""
from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path

from .schemas import ChecklistItem, ChecklistResponse

log = logging.getLogger("material_audit.checklist_store")

# 项目根 = backend/modules/material_audit/checklist_store.py → 上溯 3 层
_PROJECT_ROOT = Path(__file__).resolve().parents[3]

# 前端当前只选择国家，尚未选择签证类型；这里显式指定各国当前默认类型。
# 增加多签证类型后，应由 API 请求传入 visa_type，而不是猜测。
_DEFAULT_VISA_TYPES = {
    "IS": "schengen-tourism",
}


@lru_cache(maxsize=8)
def load_checklist(country: str) -> ChecklistResponse | None:
    """读取该国家当前默认签证类型的已解析 Checklist。"""
    country = country.upper()

    visa_type = _DEFAULT_VISA_TYPES.get(country)
    if visa_type is None:
        return None

    path = (
        _PROJECT_ROOT
        / "data"
        / "checklists"
        / "parsed"
        / f"checklist-{country}-{visa_type}.json"
    )
    if not path.exists():
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
