# Checklist 数据目录

这里保存各国家、各签证类型的官方材料要求清单。

```text
data/checklists/
├── sources/<COUNTRY>/   # 管理员手动下载的官方源文件
└── parsed/              # 后台导入工具生成并经人工确认的 JSON
```

文件使用 `checklist-<COUNTRY>-<VISA_TYPE>.json` 命名，例如：

```text
parsed/checklist-IS-schengen-tourism.json
```

当前前端只选择国家，后端在
`backend/modules/material_audit/checklist_store.py` 中维护国家到默认签证类型的显式映射。
以后支持同一国家多个签证类型时，再把 `visa_type` 加入 API 请求。

导入命令和当前解析器限制见 [`../../tools/README.md`](../../tools/README.md)。
