#!/usr/bin/env python3
"""后台 Checklist 导入工具。

从官方签证材料清单 PDF 中提取要求项，生成按国家和签证类型命名的结构化 JSON。

策略：用 pdfplumber 抽文本，按编号 (1. 2. ... 13.) 切分条目。
对每一条：保留中英文标题、详细要求、适用人群。
只解析前两页（材料清单），忽略第 3-4 页的「申请人须知」和签字栏。

当前解析适配器仍只支持冰岛申根旅游签清单版式；其他国家必须先增加解析规则，
工具会拒绝直接套用冰岛规则，避免生成内容错误但格式合法的 Checklist。
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from pathlib import Path

logging.getLogger("pdfminer").setLevel(logging.ERROR)
logging.getLogger("pdfplumber").setLevel(logging.ERROR)

import pdfplumber  # noqa: E402


# 每一条的英文标题、适用条件、匹配关键词（用于后续 audit.py 匹配文件）
# 这些是基于 PDF 内容的硬编码注释，帮助 audit.py 知道去哪里找文件。
# 关键词尽量贴近申请人实际目录里使用的命名。
ITEM_HINTS = {
    1: {
        "applies_to": "per_applicant",
        "keywords": ["visa-application", "application-form", "申请表"],
    },
    2: {
        "applies_to": "per_applicant",
        "keywords": ["passport", "护照"],
    },
    3: {
        "applies_to": "per_applicant",
        "keywords": ["photo", "照片"],  # 通常是 jpg/png，不一定是 PDF
    },
    4: {
        "applies_to": "shared",
        "keywords": ["insurance", "保险"],
    },
    5: {
        "applies_to": "shared",
        "keywords": ["flight", "机票", "car-rental", "rental"],
    },
    6: {
        "applies_to": "shared",
        "keywords": ["itinerary", "行程"],
    },
    7: {
        "applies_to": "shared",
        "keywords": ["accommodation", "hotel", "hostel", "camping", "住宿"],
    },
    8: {
        "applies_to": "per_applicant",
        "keywords": ["id-card", "身份证", "identity-card"],
    },
    9: {
        "applies_to": "per_applicant",
        "keywords": ["hukou", "户口"],
    },
    10: {
        "applies_to": "per_applicant",
        "keywords": ["bank-statement", "bank-statement", "流水", "cmb"],
    },
    11: {
        "applies_to": "per_applicant",
        "keywords": [
            "employment-letter", "business-license", "在职", "employment",
            "retired", "pension", "退休",
        ],
    },
    12: {
        # 志愿活动：仅志愿类申请适用
        "applies_to": "conditional",
        "condition": "volunteer_only",
        "keywords": ["invitation", "ngo", "邀请函"],
    },
    13: {
        # 未成年人：仅未成年适用
        "applies_to": "conditional",
        "condition": "minor_only",
        "keywords": ["student-card", "school-letter", "在读", "学生证", "guardianship"],
    },
}


def split_items(text: str) -> dict[int, dict[str, str]]:
    """
    把 PDF 文本按 "1. " "2. " ... "13. " 切成 13 段。
    返回 {id: {"description": <整段原文>}}
    英文 / 中文标题在源 PDF 中是粘连的（标题 + 描述在同一段），
    不强行切分，保留整段供 audit 阶段使用。
    """
    pattern = re.compile(r"(?:^|\n)(\d{1,2})\.\s")
    matches = list(pattern.finditer(text))

    items: dict[int, dict[str, str]] = {}
    for i, m in enumerate(matches):
        item_id = int(m.group(1))
        if not (1 <= item_id <= 13):
            continue
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        chunk = text[start:end].strip()
        # 清理页脚 / VFS 工作人员栏
        chunk = re.sub(r"Page \d+ of \d+", "", chunk)
        chunk = re.sub(r"Comments by VFS staff:.*?(?=\n[A-Z]|\Z)", "", chunk, flags=re.DOTALL)
        chunk = re.sub(r"签证中心员工备注：", "", chunk)
        chunk = re.sub(r"\n{3,}", "\n\n", chunk).strip()
        items[item_id] = {"description": chunk}
    return items


def extract(
    pdf_path: Path,
    *,
    country: str,
    country_name: str,
    visa_type: str,
) -> dict:
    """主函数：从 PDF 提取所有要求项，组装成 checklist dict。"""
    with pdfplumber.open(pdf_path) as pdf:
        # 材料清单在第 1-2 页（"Page 1 of 4" / "Page 2 of 4"）
        # 第 3-4 页是「申请人须知」+ 签字栏，不属于材料清单
        relevant_text = "\n".join(
            p.extract_text() or "" for p in pdf.pages[:2]
        )

    raw_items = split_items(relevant_text)

    items_out = []
    for item_id in sorted(raw_items.keys()):
        raw = raw_items[item_id]
        hints = ITEM_HINTS.get(item_id, {})
        items_out.append({
            "id": item_id,
            "description": raw["description"],
            "applies_to": hints.get("applies_to", "shared"),
            "condition": hints.get("condition"),
            "match_keywords": hints.get("keywords", []),
        })

    return {
        "source_pdf": str(pdf_path),
        "country_code": country,
        "country": country_name,
        "visa_type": visa_type,
        "parser_version": "is-v1",
        "items": items_out,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="导入官方签证 Checklist PDF")
    parser.add_argument(
        "--input",
        default="data/checklists/sources/IS/schengen-tourism.pdf",
        help="官方清单 PDF 路径",
    )
    parser.add_argument(
        "--country",
        default="IS",
        help="ISO 两位国家码（当前解析器仅支持 IS）",
    )
    parser.add_argument(
        "--country-name",
        default="Iceland",
        help="清单中展示的国家名称",
    )
    parser.add_argument(
        "--visa-type",
        default="schengen-tourism",
        help="签证类型 slug",
    )
    parser.add_argument(
        "-o", "--output",
        default=None,
        help="输出 JSON 路径；默认按国家和签证类型写入 data/checklists/parsed/",
    )
    args = parser.parse_args()

    country = args.country.upper()
    if country != "IS":
        print(
            f"[ERROR] country={country} 尚无解析适配器；当前只支持 IS，"
            "请先为该国实现版式规则。",
            file=sys.stderr,
        )
        return 2

    pdf_path = Path(args.input)
    if not pdf_path.exists():
        print(f"[ERROR] PDF not found: {pdf_path}", file=sys.stderr)
        return 1

    checklist = extract(
        pdf_path,
        country=country,
        country_name=args.country_name,
        visa_type=args.visa_type,
    )

    out_path = Path(args.output) if args.output else Path(
        f"data/checklists/parsed/checklist-{country}-{args.visa_type}.json"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(checklist, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"[OK] Extracted {len(checklist['items'])} items → {out_path}")
    for it in checklist["items"]:
        first_line = it["description"].split("\n", 1)[0]
        print(f"  {it['id']:>2}. [{it['applies_to']:<13}] {first_line}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
