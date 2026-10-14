# visa-helper 审核系统

只读式签证材料审核工具。从 `iceland/visa-document-checklist.pdf` 自动提取要求项，
按要求逐条核对 `iceland/` 下的材料，输出 Markdown 报告。

**严格不修改、不上传用户材料**：所有输出（清单 JSON、报告）都写在 `audit/` 目录内。
LLM 模式下也只发送 PDF 抽出的文本片段（前 2 页 / 2000 字截断），不发原文件。

## 目录结构

```
visa-helper/
├── iceland/                         # 签证材料（用户维护，不被本系统修改）
│   ├── visa-document-checklist.pdf  # 输入：官方要求清单
│   ├── <applicant-a>/               # 申请人 A 的个人材料
│   ├── <applicant-b>/               # 申请人 B 的个人材料
│   ├── accommodation/               # 共享：住宿
│   ├── flights/                     # 共享：机票
│   ├── car-rental/                  # 共享：租车
│   ├── tours/                       # 共享：报团
│   └── insurance/                   # 共享：保险
└── audit/
    ├── extract_checklist.py         # 1. PDF → checklist.json
    ├── audit.py                     # 2. checklist.json + materials → report.md
    └── checklist.json               # 提取出的要求项（缓存；report 已不入仓，见 .gitignore）
```

## 使用方法

### 基础：仅文件名匹配

```bash
python3 audit/extract_checklist.py   # 从 PDF 生成 checklist.json
python3 audit/audit.py               # 扫描材料，输出 report.md（不入仓，见 .gitignore）
```

### 进阶：加 LLM 二次核对

```bash
export ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
export ANTHROPIC_AUTH_TOKEN=...
export ANTHROPIC_MODEL=MiniMax-M3
export ANTHROPIC_SMALL_FAST_MODEL=MiniMax-M3

python3 audit/extract_checklist.py
python3 audit/audit.py --llm
```

LLM 模式会从每个匹配到的 PDF 抽前 2 页文本，调用 LLM 判断「这份文档是否真的对应该项要求」。
扫描件 PDF（无文本）会被标注为「建议人工核对」，**不会**自动判错。

### 常用参数

```bash
python3 audit/audit.py \
  --materials iceland \              # 材料根目录
  --checklist audit/checklist.json \ # 清单 JSON
  --output audit/report.md \         # 报告输出
  --applicants <applicant-a>,<applicant-b> \ # 手动指定申请人（默认自动检测）
  --llm \                            # 开启 LLM 二次核对
  --model claude-sonnet-4-6          # 指定 LLM 模型
```

## 工作原理

### 第一步：PDF 提取（extract_checklist.py）

1. 用 `pdfplumber` 抽前 2 页文本
2. 正则按 `1.` `2.` … `13.` 切成 13 段
3. 对每段过滤页脚 / VFS 员工栏
4. 配合 `ITEM_HINTS` 写入：所属类别（个人 / 共享 / 条件性）、匹配关键词

**为什么不用 LLM 抽清单**：清单结构规整（编号 + 中英对照），正则比 LLM 稳定且更便宜。

### 第二步：材料匹配（audit.py）

匹配规则（关键词 → 实际目录）：

| 检查项 | 关键词 | 实际文件 |
|---|---|---|
| 1. 签证申请表 | visa-application | `<applicant-a>/visa-application-<applicant-a>.pdf` |
| 2. 护照 | passport | `*/passport.pdf`, `*/passport-2.pdf` |
| 3. 照片 | photo, 照片 | （无匹配，提示目录下图片） |
| 4. 保险 | insurance | `insurance/travel-insurance-policy.pdf` |
| 5. 交通 | flight, car-rental, rental | `flights/*`, `car-rental/*` |
| 6. 行程 | itinerary, 行程 | `Travel itinerary.pdf`, `flights/flight-itinerary.pdf` |
| 7. 住宿 | accommodation, hotel, camping | `accommodation/*` |
| 8. 身份证 | id-card, 身份证 | `*/id-card.pdf` |
| 9. 户口本 | hukou, 户口 | `*/hukou.pdf`, `*/<applicant-b>-hukou.jpg` |
| 10. 银行流水 | bank-statement, cmb, 流水 | `*/cmb-bank-statement.pdf` |
| 11. 在职证明 | employment, business-license, 在职 | `*/employment-letter-*.pdf`, `*/business-license-*.pdf` |
| 12. 志愿邀请 | invitation, ngo | 条件性，N/A |
| 13. 未成年人 | student-card, 在读 | 条件性，N/A |

**匹配同时检查文件名和父目录名**，所以 `flights/faroe-to-iceland.pdf` 也能命中。

**申请人自动检测**：子目录中含至少一个个人材料特征文件（passport/id-card/hukou/...）即视为申请人。
已知共享目录（accommodation/flights/car-rental/tours/insurance/...）自动排除。
担保人 / 在职证明的来源人姓名（如 `<sponsor>`）仅用作文件名关键词，不参与申请人判定。

### LLM 二次核对

开启 `--llm` 后，对每项的前 3 个匹配文件，调用 LLM 验证：

- **YES** — LLM 确认内容匹配
- **NO** — LLM 确认内容不匹配（多个 NO 且无 YES → 状态降为 FAIL）
- **UNCERTAIN** — 扫描件无文本 / LLM 拿不准（仅给提示，不改变状态）

**为什么只发文本片段**：原始 PDF 二进制大、可能含敏感层；只发前 2 页文本足够分类，
不外传文件本身。本地 100% 只读 `iceland/`，不联网「上传」任何文件。

## 已知限制

- **只检查文件名 + LLM 内容确认**，不检查 PDF 是否过期 / 是否签字 / 是否盖章 / 是否
  在有效期内等语义级校验。这些建议人工核对。
- **每项 LLM 最多验证前 3 份匹配文件**（`res.matched[:3]`），可在 `audit.py` 中调整。
- **扫描件 PDF 不会被 OCR**，仅靠文件名匹配。LLM 模式下会标记为「建议人工核对」。
- **`ITEM_HINTS` 是硬编码的关键词**。如果以后换了其他国家的签证清单，关键词需要更新。
