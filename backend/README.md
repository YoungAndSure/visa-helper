# visa-helper backend

薄 FastAPI 代理，给 visa-helper Chrome 扩展提供：
- LLM 调用（CORS / API key 隔离）
- PII 脱敏中间层
- 从本地 PDF 抽取申请人上下文

## 启动

```bash
# 一次性装依赖（已完成）
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install fastapi 'uvicorn[standard]' pydantic anthropic pdfplumber

# 配置 LLM（与旧版 tools/material_audit/audit.py 风格一致）
export ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
export ANTHROPIC_AUTH_TOKEN=...
export ANTHROPIC_MODEL=MiniMax-M3
export ANTHROPIC_SMALL_FAST_MODEL=MiniMax-M3

# 起后端
backend/.venv/bin/python -m uvicorn backend.app:app --reload --host 127.0.0.1 --port 8000
```

### macOS 登录后自动启动

仓库提供 `ops/macos/com.visa-helper.backend.plist`。将它安装到
`~/Library/LaunchAgents/` 并用 `launchctl bootstrap` 加载后，后端会在用户登录时启动，
异常退出时自动拉起。LaunchAgent 使用项目内的 Python 虚拟环境，所有输出统一写入
`backend/logs/backend.log`。

当前配置设置了 `LOG_ONLY=1`，因此开发阶段不会调用远端模型；需要联调真实模型时，
应删除该环境变量并在安全的本机环境中配置模型凭据。

## 材料审核前端页面

全量远端审核与离线规则生成已改走可替换的 Agent 执行器：`run(prompt: str) -> str`，
当前调用本机 Claude CLI；填表伴侣与旧 verify 接口仍保留原模型客户端。
权限/命令白名单由 Claude settings 管理，工具/SQL 后续通过 Claude/MCP 配置加载。
配置入口与临时脱敏文件清理机制见 [Agent CLI 设计](../docs/agent-cli.md)。
本轮不修改本机认证或自动取消 `LOG_ONLY=1`。

后端同源挂了一个纯 HTML+JS 的材料审核页面（`backend/static/`），起服务后浏览器直接开：

```
http://localhost:8000/ui
```

- 选国家 → 自动拉 `/material-audit/checklist` 预览要求清单
- 清单请求每次最多等待 8 秒，失败后间隔 1 秒、2 秒重试（共 3 次）；仍失败时可手动重新加载。
  直接打开本地 HTML 会跳转到 `http://127.0.0.1:8000/ui/`，以便同源加载模块和接口。
- 选材料文件夹 → 本地只读预览原文件，并由独立预处理模块自动生成统一 Document Context
- 点「本地审核」→ 仅运行插件式规则引擎，执行必须使用原始隐私的规则
- 点「擦除隐私」→ 浏览器本地 OCR 在 PDF/JPG 视觉副本上自动画框，用户可继续手动涂抹
- 手动涂抹拖动时显示虚线选框，松开后填黑；取消拖动不增加遮挡。确认材料时把遮挡烧录进新文件，原文件保持不变。
- 用户确认时把遮挡烧录进新 PDF/JPG；逐份确认后，才允许把匿名脱敏文件发给 `/material-audit/run` 进行远端审核
- 桌面工作区固定在一屏内，材料内容在右侧卡片内部滚动；隐私处理汇总仅在底部状态条展示
- 审核中的页面刷新后会恢复当前国家、文件、页卡和审核进度；恢复数据仅存放在当前
  浏览器的本地会话中，点击「更换国家 / 重新开始」时清除，新会话打开时也会清理旧副本

> ⚠️ 本地审核插件框架已经接入，目前只有材料可用性、可读性、OCR 能力缺口和护照候选定位等基础规则；
> 隐私擦除已接入本地 OCR 与 PDF/JPG 手动涂抹框架。远端审核已接入按规则调用模型的框架；
> 完整规则、知识库检索和模型准确率仍需完善。模型未配置时会明确显示未执行，不再生成 FAKE 通过结果。

浏览器端端到端回归测试单独放在 [`tests/blackbox`](../tests/blackbox/README.md)，使用独立 Chrome 会话和虚构材料，覆盖清单重试、文件过滤、步骤状态、本地 OCR、手动涂抹和脱敏文件发送。

## Endpoints

按业务模块拆 namespace（Phase A2 起）：

| 模块 | 端点 | 说明 |
|---|---|---|
| shared infra | `GET /healthz` | liveness + LLM 配置状态 |
| shared infra | `GET /` | 服务信息 + endpoint 列表 |
| shared infra | `GET /ui` | 材料审核前端静态页面 |
| shared infra | `POST /debug/frontend-log` | 接收本地页面的实时处理事件并写入统一日志 |
| form-assist | `POST /form-assist/suggest` | 字段推荐（form-fill） |
| form-assist | `POST /form-assist/extract` | 从 PDF 路径抽 ApplicantContext |
| material-audit | `POST /material-audit/verify` | 单条 LLM 内容核对（YES/NO/UNCERTAIN） |
| material-audit | `GET /material-audit/checklist?country=<IS>` | 拉某国要求清单 |
| material-audit | `POST /material-audit/run` | 按国家/签证类型加载规则，逐条模型校验，返回结果、证据与标注 |

### `GET /healthz`

```bash
curl localhost:8000/healthz
# {"status":"ok","llm_available":false,"audit_agent_available":false,"log_only":true}
```

### 前端实时调试日志

通过 `localhost` 打开页面时，文件预处理、本地审核、OCR Worker、隐私擦除和导出阶段会把
时间戳、文件名、页码、任务进度及耗时实时写入 `backend/logs/backend.log`。日志不会包含
OCR 正文或原始文件内容；线上非本机页面默认不发送，可用 `?debug=1` 显式开启。

### `POST /form-assist/suggest`

form-fill 模式 — 给字段标签 + 申请人上下文 → 拿到建议值：

```bash
curl -X POST localhost:8000/form-assist/suggest \
  -H 'Content-Type: application/json' \
  -d '{
    "field_label": "Surname (姓)",
    "applicant_context": {"surname_romanized": "<SURNAME>", "passport_no": "<PASSPORT>"}
  }'
# → {"value": "<SURNAME>", "rationale": "上下文有全名 <SURNAME>", "confidence": 0.95}
```

### `POST /form-assist/extract`

从 PDF 路径列表抽取申请人结构化字段：

```bash
curl -X POST localhost:8000/form-assist/extract \
  -H 'Content-Type: application/json' \
  -d '{
    "pdf_paths": [
      "/Users/youngsure/Code/visa-helper/iceland/<applicant-b>/passport.pdf",
      "/Users/youngsure/Code/visa-helper/iceland/<applicant-b>/id-card.pdf"
    ],
    "applicant_hint": "<applicant-b>"
  }'
```

### `POST /material-audit/verify`

单项内容核对 — 给 requirement 描述 + PDF 文本片段 → 拿到 YES/NO/UNCERTAIN：

```bash
curl -X POST localhost:8000/material-audit/verify \
  -H 'Content-Type: application/json' \
  -d '{
    "requirement": "Bank statement (近 3 个月银行流水)",
    "pdf_text_snippet": "<银行名称> 客户姓名: <姓名> ..."
  }'
# → {"value": "YES", "rationale": "抬头 & 姓名匹配", "confidence": 0.92}
```

### `GET /material-audit/checklist`

```bash
curl 'localhost:8000/material-audit/checklist?country=IS'
# → {"country":"Iceland","items":[{...}],
#    "source":"data/checklists/parsed/checklist-IS-schengen-tourism.json"}
```

### `POST /material-audit/run`

```bash
curl -X POST localhost:8000/material-audit/run \
  -H 'Content-Type: application/json' \
  -d '{
    "schema_version": "privacy-files/v1",
    "country": "IS",
    "visa_type": "schengen-tourism",
    "materials": [{
      "material_id": "material-001",
      "source_ref": "local-file-001",
      "media_type": "application/pdf",
      "kind": "pdf",
      "sanitized_file": {
        "media_type": "application/pdf",
        "content": "data:application/pdf;base64,...",
        "size": 123456,
        "page_count": 2,
        "redaction_count": 5
      },
      "review_status": "ready"
    }],
    "privacy": {
      "processed_locally": true,
      "raw_files_uploaded": false,
      "user_reviewed": true,
      "redaction_engine": "browser-ocr-manual-v1"
    },
    "review_scopes": ["checklist", "risk"],
    "use_llm": false
  }'
# → use_llm=false 只联调报告结构，各条标记 skipped/WARNING；真实文件 + true 才请求模型
```

> 上述 Base64 是协议占位示例，真实调用应由前端生成合法文件。`use_llm` 默认 true；
> 本机 `LOG_ONLY=1` 仍强制禁用模型。请使用支持 PDF/JPG 多模态消息的模型和供应商接口；
> 仅兼容文本消息的代理不一定支持此审核。调用失败返回 ERROR，不伪造审核结论。

## 规则生成与发布

参考资料放在 `data/rules/sources/IS/schengen-tourism/`，不要放用户材料。
从仓库根目录执行（generate 会把管理员参考资料发送给配置的模型）：

```bash
backend/.venv/bin/python tools/rules/manage.py generate \
  --country IS --visa-type schengen-tourism \
  --input data/rules/sources/IS/schengen-tourism

# 查看并修订生成的草稿后，用实际文件路径替换占位符：
backend/.venv/bin/python tools/rules/manage.py publish --draft <草稿JSON路径>
```

支持 UTF-8 TXT/MD/JSON、带文字层的 PDF。草稿不参与审核，发布后下一次请求生效，保留版本历史。
没有模型时生成命令明确失败，不写虚构规则。架构、格式、标注边界见 [远端规则审核设计](../docs/remote-rule-audit.md)。

## 设计要点

- **原始材料不上传**：浏览器本地处理，后端只接收用户确认后的脱敏 PDF/JPG 副本
- **敏感正文不落日志**：材料审核和表单接口即使开启 `LOG_BODIES=1` 也不记录 body
- **PII 脱敏**：`backend/redact.py` 的 `redact_applicant_context()`
  在送 prompt 前过滤 passport / ID / 卡号 / 手机 / email；Chrome 扩展仍持有
  真实值用于 fill-back，LLM 看不到
- **CORS allowlist**：`http://localhost:5173/3000`（dev）+ `chrome-extension://<id>`
- **错误策略**：远端单条规则失败返回 ERROR，其他规则继续；未配置模型返回 skipped/WARNING

文件脱敏契约详见 [`../docs/privacy-safe-materials.md`](../docs/privacy-safe-materials.md)。

## 与后台工具及 Checklist 数据的关系

- Checklist 官方源文件放在 `data/checklists/sources/<COUNTRY>/`。
- `tools/checklist/import_checklist.py` 生成 `data/checklists/parsed/` 下的 JSON。
- 后端 `checklist_store.py` 按国家到默认签证类型的显式映射加载 JSON。
- 旧版 `tools/material_audit/audit.py` 仅作为离线参考工具，在线编排在 `modules/material_audit/`。
- `modules/audit_rules/` 维护发布规则，`modules/rule_generation/` 负责离线资料分析与草稿生成。

## 测试

```bash
backend/.venv/bin/python -m pytest backend/tests -v
node --experimental-default-type=module --test backend/tests/js/test_local_audit.mjs
```

Phase 0 覆盖：
- `test_redact.py` — PII 脱敏（id / 护照 / 卡号 / 手机 / email）
- `test_schemas.py` — /healthz / /suggest / form-fill & audit-verify 两种模式 + 无 LLM 降级
- `test_rule_pipeline.py` — 规则选择/版本隔离、模型协议、错误隔离、标注校验、目录生成与发布；全部使用假模型，零付费调用
