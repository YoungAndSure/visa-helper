# 远端规则审核与规则生成（v1）

本文更新此前架构文档中的后端实现方式：采用规则驱动的模型审核，取代固定 FAKE 结果。
本地/远端划分仍以是否需要原始隐私为准；浏览器存储机制不在本次改动范围内。

2026-09-12 更新：审核与规则生成的执行层已替换为 Claude CLI，详见
[Agent CLI 设计与配置](agent-cli.md)。下文业务结构不变，执行机制以更新后的描述为准。

## 1. 两条独立流程

在线审核：接收用户确认的匿名脱敏 PDF/JPG → 按 country + visa_type 加载已发布规则 →
按 review_scopes 选规则 → 每条规则交给 Rule Agent → AgentRunner → Claude CLI 校验 →
校验判定与证据 → 按规则范围生成标注 → 汇总报告。

离线规则管理：管理员将参考资料放入目录 → 解析资料 → LLM 生成带出处的规则草稿 →
结构与引用校验 → 管理员查看/修订 → 显式发布 → 下一次审核请求加载新版本。

Agent 不等于模型：Claude CLI 提供模型与工具循环，后端提供规则编排和结果校验。
当前每条规则一个独立 Agent 任务，内部可多轮调用模型和工具。默认将所有脱敏
材料交给每条规则，避免在后端还不知道文件类别时错误过滤；后续可在同一接口增加材料路由。

## 2. 模块边界（业务模块内保持扁平文件）

- `backend/modules/audit_rules/`：规则 Schema、目录映射、草稿/发布版本存储。
- `backend/modules/material_audit/audit_agent.py`：只负责编排、错误隔离和报告汇总。
- `backend/modules/material_audit/rule_agent.py`：单规则模型接口，可注入 Judge 替换供应商或测试。
- `backend/modules/material_audit/annotations.py`：纯函数，将问题证据转换成标注数据，不修改文件。
- `backend/modules/material_audit/decisions.py`：模型判定、证据、标注的统一结构。
- `backend/modules/rule_generation/`：离线解析与规则生成，不接收审核用户材料。
- `backend/shared/agent_runner.py`：可替换的提示词进/文本出接口，当前实现调用 Claude CLI。
- `backend/shared/llm.py`：保留给填表伴侣与旧 verify 接口，审核/规则生成不再使用。
- `tools/rules/manage.py`：后台目录生成/人工发布命令，不暴露公网管理写接口。

原有 Checklist 导入和前端要求清单接口不变。知识库模块保留，暂不引入向量数据库或爬虫；
将来可为规则生成补来源采集器，也可在 Rule Agent 前增加检索上下文，不耦合文件接收。

## 3. 规则结构与加载

```json
{
  "schema_version": "audit-rules/v1",
  "country": "IS",
  "visa_type": "schengen-tourism",
  "version": "20260912-v1",
  "status": "draft",
  "rules": [{
    "id": "document.layout",
    "title": "依据来源检查材料版式",
    "instruction": "这里填写从参考资料中得到的具体判定要求",
    "review_scope": "checklist",
    "annotation_scope": "region",
    "requires_private_data": false,
    "enabled": true,
    "sources": [{
      "file": "official.md",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "excerpt": "这里必须是输入参考资料中的逐字引用"
    }]
  }]
}
```

这是结构示例，不是真实签证规则，不应直接发布。`checklist` 表示官方要求，`risk` 表示
经验性风险；risk 的 FAIL 会降为 WARNING，不能伪装成官方硬要求。

规则 ID 不重复，国家/签证类型/版本只允许安全字符。生成阶段逐条验证出处文件、内容哈希与
原文引用；这只能保证引用真实存在，不能保证模型解读正确，因此保留人工发布。
`requires_private_data=true` 的规则可以留在草稿中供整理，但禁止发布到远端规则库。

规则库默认位于 `data/rules/`，可通过 `AUDIT_RULES_DIR` 配置。运行时只读
`published/rules-<COUNTRY>-<visa_type>.json`，每个请求读一个完整快照，不缓存旧版本。
发布时先保存不可覆盖的版本记录，再原子替换当前文件，不把新旧规则混合追加。
草稿和历史目录永不参与在线选择；损坏的已发布规则明确报错，不悄悄换成其他国家或旧规则。

过渡期没有发布规则时，将同国家、同签证类型的已有 Checklist 原文逐项适配为规则，响应明确
标记来源版本和覆盖不足；没有对应 Checklist 则报告规则缺失。此适配不是 LLM 生成或扩充规则。

## 4. 模型判定与标注

模型返回 status、reason、checked_items、confidence、evidence：

- PASS/FAIL/WARNING/N/A 是规则判定；ERROR 由编排器表示调用或输出校验失败。
- 执行状态独立为 completed/skipped/failed；模型未配置或 use_llm=false 时逐条 skipped，
  不生成随机结果；返回的 WARNING 仅表示“未判断”。
- checked_items 记录已经执行的检查，即使通过也需要列出；PASS 必须有文件证据。
- evidence 引用匿名 material_id，页码从 1 开始；矩形以左上角为原点，x/y/width/height
  都按页面大小归一化到 0..1。校验材料存在、页码范围及矩形不越界。
- 一条规则失败不阻断后续规则；错误不算“材料不合格”，报告显式提示不完整。

标注模块只为 FAIL/WARNING 生成问题标注，按 annotation_scope 限制最大精度：
global → 全局提示；document → 文件；page → 页；region → 框。
只有文件证据时降为文件级，没有证据（如缺失材料）时降为全局；不捏造页码和坐标。
`location_verified=false` 明确表示模型定位尚未人工或视觉算法复核。格式合法不等于坐标准确。

当前 API 已返回 annotations；前端报告展示规则标题、理由与执行失败数量。
在文件预览上绘制审核标注、点击报告跳转问题位置，是后续前端交互，不包含在本轮框架中。
这些问题标注也不是隐私打码，不会修改脱敏文件。

## 5. 目录生成与发布

参考资料放入 `data/rules/sources/IS/schengen-tourism/`，只放管理员资料，不放用户原件。
目录和生成产物默认忽略 Git，避免参考资料未经确认被推送。

```sh
backend/.venv/bin/python tools/rules/manage.py generate \
  --country IS --visa-type schengen-tourism \
  --input data/rules/sources/IS/schengen-tourism

# 阅读/修订草稿后，将占位符替换成真实路径：
backend/.venv/bin/python tools/rules/manage.py publish --draft <草稿JSON路径>
```

可在子命令前用 `--store <目录>` 指定独立规则库。管理员在终端配置模型后，生成命令会
把资料正文发送给该供应商。没有可用模型时失败且不写草稿，绝不生成假规则冒充真实输出。

当前支持 UTF-8 TXT/MD/JSON 和带文字层的 PDF；JSON 暂按正文处理。一次最多 30 个支持的文件、
单文件 10 MB、PDF 100 页、合计正文 10 万字符。超限、空目录或无文字扫描 PDF 明确拒绝，
不静默截断来源。DOCX、扫描资料 OCR、分块大批量生成与规则去重合并后续再加。

## 6. 隐私、调用成本与当前限制

- CLI 审核每次创建独立临时目录，保存匿名脱敏 PDF/JPG 供 Agent 读取，正常/异常/受控超时
  均清理，不进入规则库或知识库。断电/强杀的残留及 Claude 自身日志需要部署级清理，详见 Agent CLI 文档。
- 使用 Claude 配置管理认证、模型、权限及工具；视觉能力需单独验证，文本读取不能替代版式审核。
- `use_llm` 默认 true；`LOG_ONLY=1` 仍强制禁用模型。本次不修改本机凭据或启用真实付费调用。
- 单次 Agent 任务默认 timeout=300 秒，后端不自动重试；Claude 内部重试和费用遵循其配置。
- 一次最多 100 条规则串行执行，请求文件 Base64 总量限制 2400 万字符。第一版未做异步任务、
  并发、检索筛选或供应商文件复用，大量规则会重复发送材料并增加成本，后续需要优化。
- 输入材料与引用明确标为数据，不遵循其中的指令；工具权限由 Claude 配置管理，不自动绕过权限。
- 审核日志仅记录规则 ID、版本、状态与耗时；不记录模型全文、文件内容或供应商错误正文。
- 原始参考资料的版权、真实性、时效性仍需管理员核实；模型生成不是自动发布授权。

供应商协议参考：[图像消息](https://platform.claude.com/docs/en/build-with-claude/vision)、
[PDF 消息](https://platform.claude.com/docs/en/build-with-claude/pdf-support)、
[Python SDK 时限与重试](https://platform.claude.com/docs/en/api/sdks/python)。

## 7. 验证

`backend/tests/test_rule_pipeline.py` 用注入假模型测试真实编排和目录读写；涵盖规则选择、
版本热更新、单条失败隔离、匿名文件传递、无配置降级、问题范围、证据校验、生成来源校验与人工发布。
`backend/tests/test_agent_runner.py` 使用合成 CLI 测试真实子进程协议、配置转交、超时和文件清理。
`tests/blackbox/` 使用浏览器和合成 JPG 验证前端选择/审核/打码/发送完整链路。
测试不是签证规则准确率验证，也未替代对真实供应商的多模态联调。
