# 材料审核系统：数据与模块架构方案

> 后端实现已按新的“逐规则模型审核 + 独立标注 + 离线规则生成/发布”方案演进。
> 下文保留数据边界与早期规划；涉及 FAKE 步骤、确定性后端 Checklist 引擎等旧描述，
> 以 [远端规则审核设计](remote-rule-audit.md) 的当前实现为准。

## 1. 文档目的

本文档定义 visa-helper 材料审核系统的数据边界、后台模块划分、主要处理流程和分阶段实施方案。

系统涉及三类核心数据：

1. 用户在本地选择的签证材料；
2. 各国家、各签证类型的官方要求清单（Checklist）；
3. 用于风险判断的知识库数据。

三类数据来源、可信度、更新方式和隐私等级不同，应分别管理，由材料审核编排器在一次审核任务中统一使用。

---

## 2. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│                         用户前端                            │
│  选择国家 / 选择材料 / 本地预览 / 本地隐私处理 / 展示报告   │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    Material Audit API                       │
│  接收最小化审核请求，不接收或持久化用户原始材料             │
└───────────────┬───────────────────────┬─────────────────────┘
                │                       │
                ▼                       ▼
┌──────────────────────────┐  ┌──────────────────────────────┐
│ Checklist Audit Engine   │  │ Knowledge Agent              │
│ 对照官方清单做确定性审核 │  │ 检索知识库并判断潜在风险     │
└─────────────┬────────────┘  └──────────────┬───────────────┘
              │                              │
              ▼                              ▼
┌──────────────────────────┐  ┌──────────────────────────────┐
│ Checklist Store          │  │ Knowledge Base               │
│ 各国官方要求及版本       │  │ 官方说明、专业解释、经验数据 │
└──────────────────────────┘  └──────────────────────────────┘
```

审核结果分为两层：

- **官方要求审核**：材料缺失、有效期不足、格式不符、条件不满足等，可以输出 `PASS`、`FAIL`、`WARNING`、`N/A`；
- **风险审核**：材料虽然齐全，但可能存在拒签、补件或合理性质疑风险，输出低、中、高风险及补强建议，不应把经验判断伪装成官方硬性要求。

---

## 3. 数据一：用户签证材料

### 3.1 定位

用户材料是一次审核任务的输入，即“被审核的数据”，可能包括：

- 护照、身份证、户口材料；
- 签证申请表、照片；
- 银行流水、余额证明、收入证明；
- 在职、退休、在读等身份材料；
- 机票、住宿、行程、保险；
- 邀请函、亲属关系、监护关系等条件材料。

### 3.2 隐私和生命周期

用户材料包含高敏感 PII，默认采用以下原则：

- 前端先进行本地文件选择、列表展示和预览；
- 用户原始文件不直接发送到后端；
- 文件解析、脱敏和事实抽取应尽量在用户本地完成；
- 后端只接收完成审核所需的最小化结构化事实或经确认的脱敏片段；
- 用户材料及其衍生数据不得进入知识库；
- 日志不得记录文件正文、证件号码、账户信息等敏感内容；
- 后续若需要保留历史报告，应让用户明确授权，并避免保存可还原原始材料的内容。

### 3.3 目标流程

```text
用户选择材料
  → 前端本地列出和预览
  → 本地识别并执行必须使用真实隐私的本地规则
  → 在 PDF/JPG 视觉副本上自动识别隐私并由用户补充涂抹
  → 烧录遮挡，生成匿名脱敏文件
  → 后端 Agent 使用脱敏文件执行 Checklist、知识库和模型审核
  → 返回综合报告
```

### 3.4 接口边界（待下一步细化）

后端审核请求不包含原始文件，目标形态是提交国家、签证类型和用户确认后的匿名脱敏文件：

```http
POST /material-audit/run
Content-Type: application/json
```

```json
{
  "schema_version": "privacy-files/v1",
  "country": "IS",
  "visa_type": "schengen-tourism",
  "materials": [
    {
      "material_id": "material-001",
      "source_ref": "local-file-001",
      "kind": "pdf",
      "media_type": "application/pdf",
      "sanitized_file": {
        "media_type": "application/pdf",
        "content": "data:application/pdf;base64,...",
        "size": 123456,
        "page_count": 2,
        "redaction_count": 5
      },
      "review_status": "ready"
    }
  ]
}
```

当前以 Base64 作为 JSON 传输封装，后续可替换为 multipart 或对象存储。文件脱敏和本地审核
设计详见 [`privacy-safe-materials.md`](privacy-safe-materials.md)。

### 3.5 当前项目状态

当前前端已经能够：

- 选择本地文件夹；
- 列出文件；
- 本地预览图片和 PDF；
- 在浏览器内提取 PDF/文本并执行插件式本地审核；
- 在原文件视觉副本上自动/手动打码，并生成 `privacy-files/v1` 脱敏 PDF/JPG；
- 用户确认后，将遮挡烧录到新生成的 PDF/JPG；
- 用户确认全部脱敏文件后才允许调用后端；
- 只发送匿名脱敏文件，调用 `/material-audit/run` 进行远端审核并展示结果。

后端已经接收安全材料 Schema，并搭建 Audit Agent 的 intake、Checklist、知识库、模型和报告
步骤骨架；当前审核状态仍为 FAKE，知识库和模型步骤尚未实装。第一版隐私擦除已经具备本地
OCR、PDF/JPG 自动画框和人工补画框架；对象检测、姓名地址 NER 和识别准确率仍待优化。

---

## 4. 数据二：各国家官方 Checklist

### 4.1 定位

Checklist 是审核的官方硬规则来源，回答：

- 需要提交哪些材料；
- 每项材料适用于谁；
- 哪些条件下才适用；
- 有效期、金额、时间范围、格式等具体要求；
- 清单适用的国家、签证类型和版本。

### 4.2 前期管理方式

前期不建设 Checklist 管理前端，由管理员在后台操作：

```text
手动从官方渠道下载清单
  → 按国家放入约定目录
  → 运行解析命令
  → 生成结构化 Checklist JSON
  → 校验解析结果
  → 后端按国家码加载
```

建议目录结构：

```text
data/checklists/
├── sources/
│   ├── IS/
│   │   └── schengen-tourism.pdf
│   ├── NO/
│   │   └── visitor-visa.pdf
│   └── FR/
│       └── schengen-tourism.pdf
└── parsed/
    ├── checklist-IS-schengen-tourism.json
    ├── checklist-NO-visitor-visa.json
    └── checklist-FR-schengen-tourism.json
```

建议命令：

```bash
backend/.venv/bin/python tools/checklist/import_checklist.py \
  --country IS \
  --visa-type schengen-tourism \
  --input data/checklists/sources/IS/schengen-tourism.pdf
```

### 4.3 映射规则

Checklist 不能只按国家映射，因为同一国家通常有多个签证类型。目标键应为：

```text
(country, visa_type, version)
```

运行时通常加载该国家和签证类型当前处于 `PUBLISHED` 状态的最新有效版本：

```text
country=IS + visa_type=schengen-tourism
  → checklist-IS-schengen-tourism.json
```

前期使用文件命名约定即可，暂不要求数据库。

### 4.4 Checklist 建议结构

```json
{
  "country": "IS",
  "visa_type": "schengen-tourism",
  "version": "2026-01-01",
  "status": "PUBLISHED",
  "source_file": "data/checklists/sources/IS/schengen-tourism.pdf",
  "source_url": "https://example.com/checklist.pdf",
  "source_hash": "sha256:...",
  "effective_date": "2026-01-01",
  "parsed_at": "2026-08-29T10:00:00+08:00",
  "parser_version": "1",
  "items": [
    {
      "id": "passport",
      "description": "护照离开申根区后至少有效三个月",
      "applies_to": "per_applicant",
      "condition": null,
      "match_keywords": ["passport", "护照"],
      "rules": []
    }
  ]
}
```

### 4.5 更新策略

前期：

- 管理员手动下载新版文件；
- 重新运行解析；
- 检查条目数量和内容差异；
- 发布新版本；
- 清除后端缓存或重启服务。

后期可以增加自动更新模块：

```text
定时检查官方来源
  → 发现文件或页面变化
  → 下载并计算内容哈希
  → 自动解析
  → 与当前版本生成差异
  → 管理员确认
  → 发布新版本
```

自动化阶段仍建议“自动发现和解析、人工发布”，避免官方页面格式变化或解析错误直接污染线上审核规则。

### 4.6 当前项目状态

现有 `tools/checklist/import_checklist.py` 可以把冰岛官方 PDF 转为
`data/checklists/parsed/checklist-IS-schengen-tourism.json`，后端通过
`checklist_store.py` 加载：

- 官方源文件约定放在 `data/checklists/sources/<COUNTRY>/`；
- 解析结果使用 `checklist-<COUNTRY>-<VISA_TYPE>.json` 命名；
- 当前前端只选择国家，后端通过显式映射选择该国默认签证类型；
- 清单使用内存缓存，文件更新后需要清缓存或重启后端。

现有导入命令已经接收国家、签证类型和输入文件，但解析适配器仍是冰岛专用：前两页、
1 至 13 项以及匹配关键词均带硬编码。工具会拒绝其他国家，后续为各国增加独立版式规则。

---

## 5. 数据三：知识库

### 5.1 定位

知识库用于风险判断，不替代官方 Checklist。它回答：

- 材料虽然齐全，是否仍存在拒签或补件风险；
- 材料之间是否存在不一致或合理性问题；
- 哪些情况通常需要解释或补充证明；
- 用户可以如何补强材料。

### 5.2 知识来源

知识来源包括：

- 使领馆、移民局、VFS 等官方说明；
- 官方 FAQ、办事指南、公开拒签原因或统计；
- 律所、专业签证机构等专业解释；
- 论坛、博客、社交平台和个人申请经验；
- 后续积累的人工审核规则与已验证经验。

### 5.3 来源等级

| 等级 | 来源 | 使用边界 |
|---|---|---|
| A | 使领馆、移民局、VFS 等官方来源 | 可作为明确审核依据 |
| B | 律所、专业机构、专业解释 | 用于风险提示和补强建议 |
| C | 论坛、博客、社交平台、个人经验 | 只能作为弱信号，不得判定硬性不合格 |
| D | LLM 归纳或推断 | 必须明确标注为模型推断 |

任何风险结论都应保留原始来源和证据，不能把经验内容表述为官方规则。

### 5.4 知识库管理流程

知识库管理是后台模块，不面向普通用户：

```text
配置来源
  → 网络抓取
  → 正文提取
  → 清洗、去重
  → 国家/签证类型/材料类型分类
  → 来源可信度评级
  → 人工审核
  → 发布
  → 建立检索索引
  → 定期刷新、失效和归档
```

每条知识建议保留：

- 原始 URL、标题和站点；
- 原文证据片段或正文快照；
- 发布时间、抓取时间和最后检查时间；
- 国家、签证类型、材料类型；
- 来源等级和可信度；
- 人工审核状态；
- 有效状态和失效时间；
- 内容哈希和版本。

---

## 6. Knowledge Agent

### 6.1 模块边界

知识库与 Agent 作为一个完整后台能力对外提供服务。外部模块不直接操作向量索引或抓取数据；
`material-audit` Agent 在收到脱敏材料后调用它，传入已经抽取且不含身份隐私的审核事实。

Agent 内部负责：

1. 理解国家、签证类型和不含身份隐私的已抽取事实；
2. 构造检索条件；
3. 从知识库取得相关证据；
4. 区分官方规则、专业意见和用户经验；
5. 基于证据形成风险结论；
6. 返回风险等级、理由、建议和来源引用。

### 6.2 接口方向

```http
POST /knowledge-agent/risk-review
Content-Type: application/json
```

```json
{
  "country": "IS",
  "visa_type": "schengen-tourism",
  "material_type": "bank-statement",
  "facts": {
    "statement_months": 3,
    "recent_large_deposit": true,
    "salary_matches_employment": false
  }
}
```

建议返回：

```json
{
  "risk_level": "MEDIUM",
  "findings": [
    {
      "title": "近期存在大额入账",
      "reason": "资金来源可能需要额外解释",
      "suggestion": "补充转账凭证和资金来源说明",
      "basis": "EXPERIENCE",
      "sources": [
        {
          "title": "来源标题",
          "url": "https://example.com/article",
          "source_level": "B",
          "evidence": "相关证据片段"
        }
      ]
    }
  ]
}
```

### 6.3 约束

- 没有检索证据时，不生成确定性风险结论；
- 所有结论必须能追溯到知识条目或明确标注为模型推断；
- C、D 级信息不能导致官方审核项直接 `FAIL`；
- Agent 输入只使用本地隐私处理后的最小化结构化事实，不接收完整敏感原文或原始文件；
- Agent 输出应包含置信度、证据等级和不确定性说明。

---

## 7. 审核编排器

审核编排器负责把三类数据组合成一次完整审核，但不加载用户原始文件：

```text
本地抽取的最小化材料事实
  → 根据 country + visa_type 加载 Checklist
  → 执行材料完整性和规则审核
  → 将结构化事实发送给 Knowledge Agent
  → 合并官方审核结果与风险结果
  → 生成最终报告
```

最终报告应分栏展示：

### 7.1 官方要求结果

- `PASS`：已提供且满足已实现的官方规则；
- `FAIL`：明确缺失或违反官方硬性要求；
- `WARNING`：文件存在，但无法自动确认部分条件；
- `N/A`：条件不适用。

### 7.2 风险提示

- `LOW`：轻微问题或可选优化；
- `MEDIUM`：可能引发补件或质疑，建议补充说明；
- `HIGH`：存在明显不一致或高风险特征，需要优先处理。

风险提示不得覆盖或篡改官方审核结果，两者应分别展示。

---

## 8. 后台模块划分

当前采用扁平业务模块，不提前为尚未实现的内部职责建立子目录：

```text
backend/modules/
├── form_assist/         # 填表伴侣
├── material_audit/      # Checklist 审核、编排和报告（内部先按文件拆分）
└── knowledge_agent/     # 知识库管理、检索和 Agent（当前仅模块占位）

tools/
├── checklist/           # 后台 Checklist 导入工具
└── material_audit/      # 旧版只读审核 CLI

data/checklists/
├── sources/             # 官方源文件
└── parsed/              # 结构化 Checklist
```

Checklist 导入属于后台离线数据管理；Knowledge Agent 属于在线审核依赖，但其抓取和入库属于后台异步管理任务。

---

## 9. 分阶段实施顺序

### Phase 1：用户材料隐私处理方案

- 明确本地可信执行环境和浏览器能力边界；
- 定义原始材料绝不上传的技术约束；
- 定义本地文件解析、脱敏和结构化事实抽取流程；
- 定义允许发送给后端的最小化事实 schema；
- 评估事实可逆性、日志泄露和模型调用风险；
- 确定方案后再替换当前 `/run` 的 FAKE 输入。

### Phase 2：多国家 Checklist 导入

- 将冰岛专用解析器改造成通用命令行工具；
- 引入 `country + visa_type + version` 映射；
- 增加 JSON Schema 或 Pydantic 校验；
- 输出新旧版本差异；
- 解析后支持清缓存或按文件更新时间自动重载。

### Phase 3：Checklist 审核引擎

- 匹配用户文件与 Checklist 项；
- 从材料中抽取规则需要的结构化事实；
- 实现 `PASS/FAIL/WARNING/N/A`；
- 生成带证据的官方要求审核报告。

### Phase 4：知识库管理

- 定义知识条目 schema 和来源等级；
- 实现来源配置、抓取、正文提取和去重；
- 实现人工审核和发布状态；
- 建立按国家、签证类型和材料类型过滤的检索索引。

### Phase 5：Knowledge Agent

- 实现风险审核请求 schema；
- 接入知识库检索；
- 要求所有结论附带来源证据；
- 实现风险等级、置信度和补强建议；
- 与材料审核编排器集成。

### Phase 6：自动更新

- 定期检查官方 Checklist 来源；
- 自动发现、下载、解析和差异比较；
- 管理员确认后发布；
- 定期刷新知识库来源并标记过期内容。

---

## 10. 当前决策摘要

1. 数据明确分为用户材料、官方 Checklist、风险知识库三类；
2. Checklist 前期由管理员手动下载并通过后台命令解析，不建设管理前端；
3. Checklist 未来可自动发现和解析更新，但保留人工发布环节；
4. 用户前端负责选择、预览和本地隐私处理，原始材料不直接发送到后端；
5. 知识库和 Agent 作为一个整体后台能力，通过风险审核接口被调用；
6. Checklist 负责官方确定性判断，Knowledge Agent 负责经验性风险判断；
7. 最终由审核编排器合并两类结果，但报告中必须明确区分官方要求和风险提示。
8. `backend/modules/` 下保持扁平业务模块，暂不为 Knowledge Agent 或材料审核预设多层子目录。
