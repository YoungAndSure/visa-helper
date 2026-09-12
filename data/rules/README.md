# 远端审核规则库

首次本地测试可安装已核对的 [欧盟通用规则子集](bootstrap/ec-schengen-general/README.md)：
`backend/.venv/bin/python tools/rules/bootstrap_general.py`。这是六条测试种子，不是完整规则库。

原始参考资料放在 `sources/<国家>/<签证类型>/`，例如 `sources/IS/schengen-tourism/`。
只放管理员收集的规则来源，不要放用户签证材料。`generate` 会将参考资料正文发送给配置的模型。

- `drafts/`：模型生成的草稿，人工查看和修改，运行时不加载。
- `published/`：按国家和签证类型生效的一份完整规则集。
- `versions/`：发布版本历史；同名版本禁止覆盖。

这三个输出目录由后台命令创建。每次发布是完整替换当前规则集，不是追加合并。没有发布版本时，
审核器临时将 `data/checklists/parsed/` 对应的 Checklist 原文逐项作为规则，响应会明确提示。
规则格式、命令和标注约定见 [后端设计](../../docs/remote-rule-audit.md)。
