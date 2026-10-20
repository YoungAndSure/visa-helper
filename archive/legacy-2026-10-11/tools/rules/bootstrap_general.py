#!/usr/bin/env python3
"""Install a small, reviewed official-source rule subset for local Iceland testing.

This is a curated seed import, not an LLM-generation run or a complete checklist.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.modules.audit_rules.schemas import AuditRule, RuleSet, RuleSource
from backend.modules.audit_rules.store import RuleStore

SOURCE = ROOT / "data/rules/bootstrap/ec-schengen-general/source.json"
VERSION = "ec-general-test-20260912-v2"

COMMON = """这是普通短期旅游签场景的通用规则子集，只判断本条要求，不表示完整材料合规。
自行从全部匿名脱敏文件中寻找候选，不依赖原文件名；不得验证或恢复姓名、账号、证件号、签名身份。
候选不存在且无法确认是否有特殊豁免或替代证据时返回 WARNING，说明需要补充或人工确认。
被打码、裁切、分辨率不足或上下文不完整时返回 WARNING，不能把不可见当成缺失。
PASS 仅表示本条有限范围内有清晰支持证据，必须给出匿名文件及已检查项，不代表签证获批。
明确可见且与本条要求矛盾才可 FAIL，给出证据；适用性不能确定不要用 N/A。
定位不能可靠确定时只给文件/页，不编造坐标。不要添加来源未规定的金额、月份、尺寸或付款要求。
"""

DETAILS = [
    ("申请表存在性", "document", "只核对是否能辨认为签证申请表的文件。不要据此确认所有字段完整、签字有效或身份一致。"),
    ("旅行医疗保险保障项目", "region", "定位保险凭证和条款，对照来源所列保障逐项列出已确认和无法确认的项目。不能只凭保险标题判通过。金额、地理范围和期限不属于本条判断。"),
    ("出行目的支持材料", "document", "定位能说明旅游目的的材料，指出支持理由。行程说明或旅行安排可作为候选，但本条不要求特定模板或固定格式。"),
    ("住宿证明存在性", "document", "定位住宿安排的证据，不限定必须为酒店，不要求预付款。不核验入住人身份，也不凭此证明覆盖所有夜晚。"),
    ("财力证明存在性", "document", "仅判断是否存在可辨认的财力证明；不判断余额充足性、账户持有人或流水时长。字段被遮挡不代表证明无效。"),
    ("返程意图支持材料", "document", "寻找可支持返程意图的材料并说明依据，不把已付款往返机票设为唯一方式，不作个人移民风险或获签结论。")
]


def build_ruleset() -> RuleSet:
    raw = SOURCE.read_bytes()
    source = json.loads(raw)
    if len(source["requirements"]) != len(DETAILS):
        raise ValueError("source requirements and reviewed rule definitions must match")
    digest = hashlib.sha256(raw).hexdigest()
    rules = []
    for requirement, (title, scope, detail) in zip(source["requirements"], DETAILS):
        rules.append(AuditRule(
            id=requirement["id"], title=f"[通用测试] {title}", annotation_scope=scope,
            instruction=COMMON + "\n本条官方来源摘要：" + requirement["summary"] + "\n检查边界：" + detail,
            sources=[RuleSource(file=str(SOURCE.relative_to(ROOT)), sha256=digest, excerpt=requirement["summary"])],
        ))
    if len(rules) != 6:
        raise ValueError("expected exactly six reviewed seed rules")
    return RuleSet(country="IS", visa_type="schengen-tourism", version=VERSION, rules=rules)


def install(store: RuleStore) -> Path:
    ruleset = build_ruleset()
    target = store.root / "published" / "rules-IS-schengen-tourism.json"
    if target.exists():
        current = RuleSet.model_validate_json(target.read_text(encoding="utf-8"))
        expected = ruleset.model_copy(update={"status": "published"})
        if current == expected:
            return target  # Repeatable without changing the published version.
        raise ValueError("active rules exist; refusing to replace them with the test subset")
    return store.publish(ruleset)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", type=Path, help="Optional isolated library for testing")
    args = parser.parse_args()
    try:
        path = install(RuleStore(root=args.store))
    except (ValueError, OSError) as error:
        print(f"Import failed: {error}", file=sys.stderr)
        return 1
    print(f"Published 6 general TEST rules for IS/schengen-tourism: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
