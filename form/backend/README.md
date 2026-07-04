# visa-helper backend

薄 FastAPI 代理，给 visa-helper Chrome 扩展提供：
- LLM 调用（CORS / API key 隔离）
- PII 脱敏中间层
- 从本地 PDF 抽取申请人上下文

## 启动

```bash
# 一次性装依赖（已完成）
python3 -m venv form/backend/.venv
form/backend/.venv/bin/pip install fastapi 'uvicorn[standard]' pydantic anthropic pdfplumber

# 配置 LLM（与 audit/audit.py 风格一致）
export ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
export ANTHROPIC_AUTH_TOKEN=...
export ANTHROPIC_MODEL=MiniMax-M3
export ANTHROPIC_SMALL_FAST_MODEL=MiniMax-M3

# 起后端
form/backend/.venv/bin/uvicorn form.backend.app:app --reload --host 127.0.0.1 --port 8000
```

## Endpoints

按业务模块拆 namespace（Phase A2 起）：

| 模块 | 端点 | 说明 |
|---|---|---|
| shared infra | `GET /healthz` | liveness + LLM 配置状态 |
| shared infra | `GET /` | 服务信息 + endpoint 列表 |
| form-assist | `POST /form-assist/suggest` | 字段推荐（form-fill） |
| form-assist | `POST /form-assist/extract` | 从 PDF 路径抽 ApplicantContext |
| material-audit | `POST /material-audit/verify` | 单条 LLM 内容核对（YES/NO/UNCERTAIN） |
| material-audit | `GET /material-audit/checklist?country=<IS>` | 拉某国要求清单 |
| material-audit | `POST /material-audit/run` | 跑全量材料审核（Phase A2 stub,Phase D 实装） |

### `GET /healthz`

```bash
curl localhost:8000/healthz
# {"status":"ok","llm_available":true|false}
```

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
# → {"country":"Iceland","items":[{...}], "source":"audit/checklist.json"}
```

### `POST /material-audit/run`

```bash
curl -X POST localhost:8000/material-audit/run \
  -H 'Content-Type: application/json' \
  -d '{
    "country": "IS",
    "materials_dir": "/Users/youngsure/Code/visa-helper/iceland",
    "use_llm": false
  }'
# → {"country":"IS", "results":[], "summary":{"total":0, "warnings":["Phase A2 stub..."]}}
```

> ⚠️ Phase A2 阶段 `/run` 只返回 stub（空 results + warning）。前端真要接 RPC 时实装 runner.py。

## 设计要点

- **不持久化 PII**：无 DB，无 file-based state，仅做代理
- **PII 脱敏**：`form/backend/redact.py` 的 `redact_applicant_context()`
  在送 prompt 前过滤 passport / ID / 卡号 / 手机 / email；Chrome 扩展仍持有
  真实值用于 fill-back，LLM 看不到
- **CORS allowlist**：`http://localhost:5173/3000`（dev）+ `chrome-extension://<id>`
- **错误策略**：LLM 失败降级为 mock/unknown 而不是 500，前端能继续跑

## 与 audit/ 的关系

- LLM env-var 风格完全复用 `audit/audit.py`
- PDF 抽取口径（`pdfplumber` 前 2 页 + 截断）与 `audit/audit.py` 一致
- `audit/checklist.json` 在 audit 阶段生成；extension 这边再 port 一份到 TS
  （见 `extension/src/shared/audit-rules.ts`）

## 测试

```bash
form/backend/.venv/bin/python -m pytest form/backend/tests -v
```

Phase 0 覆盖：
- `test_redact.py` — PII 脱敏（id / 护照 / 卡号 / 手机 / email）
- `test_schemas.py` — /healthz / /suggest / form-fill & audit-verify 两种模式 + 无 LLM 降级
