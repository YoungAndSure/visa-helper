# visa-helper 后台工具

`tools/` 保存管理员或开发者在后台手动运行的离线工具，不承载在线 API。

## 目录

```text
tools/
├── checklist/
│   └── import_checklist.py    # 官方 Checklist PDF → 结构化 JSON
└── material_audit/
    └── audit.py               # 旧版只读材料审核 CLI
```

数据不放在工具目录：

```text
data/checklists/sources/       # 官方源文件
data/checklists/parsed/        # 解析结果
data/reports/                  # 本地审核报告（Git 忽略）
```

## 导入官方 Checklist

管理员先把官方文件放到约定目录：

```text
data/checklists/sources/IS/schengen-tourism.pdf
```

然后运行：

```bash
backend/.venv/bin/python tools/checklist/import_checklist.py \
  --country IS \
  --country-name Iceland \
  --visa-type schengen-tourism \
  --input data/checklists/sources/IS/schengen-tourism.pdf
```

默认输出：

```text
data/checklists/parsed/checklist-IS-schengen-tourism.json
```

当前导入工具仍是冰岛版式适配器，只支持 `IS`：前两页、编号 1 至 13、适用范围和文件名
关键词均基于现有冰岛清单。其他国家必须先实现对应版式规则，工具不会直接套用冰岛规则。

导入完成后应人工检查条目数量和内容。后端目前缓存 Checklist，更新已加载的 JSON 后需要
重启服务或调用代码中的 `clear_cache()`。

## 旧版只读材料审核 CLI

该工具保留已有的文件名匹配和可选 LLM 二次确认能力，供真实在线审核引擎完成前参考：

```bash
backend/.venv/bin/python tools/material_audit/audit.py \
  --materials iceland \
  --checklist data/checklists/parsed/checklist-IS-schengen-tourism.json \
  --output data/reports/material-audit-report.md
```

加 `--llm` 后，它只向 LLM 发送从 PDF 抽取并截断的文本，不发送原始 PDF。扫描件无文本时
标记为需要人工确认。该 CLI 不等于未来的在线审核实现，后续业务逻辑应迁入
`backend/modules/material_audit/`，而不是继续扩展这个脚本。
