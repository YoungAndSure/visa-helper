# 前端隐私材料协议（v1alpha1）

## 目标

用户原始签证材料只在浏览器本地读取。后端只接收用户检查、编辑并明确确认过的安全 JSON，
不接收原始文件、原始文件名、本地路径或未处理图片。

## 前端流程

```text
选择本地文件夹
  → 原文件只读预览（不修改原文件）
  → 点击“擦除隐私”
  → 本地解析 PDF/文本
  → 规则擦除明显 PII
  → 图片生成待人工处理对象，原图内容保持为空
  → 每个原文件映射一个安全材料对象
  → 用户从左侧逐个选择，在结构化区块中检查和编辑
  → 用户逐个确认
  → 发送安全 JSON
```

处理前、存在未确认材料或编辑后未重新确认时，“运行审核”按钮保持禁用。

## JSON 示例

页面不直接展示整包裸 JSON。下面仅用于说明前后端协议；实际界面按文件拆分，以字段、文本、隐私替换和图片对象区块展示。

```json
{
  "schema_version": "privacy-materials/v1alpha1",
  "country": "IS",
  "visa_type": "schengen-tourism",
  "privacy": {
    "processed_locally": true,
    "raw_files_uploaded": false,
    "user_reviewed": true,
    "redaction_engine": "browser-regex-v1"
  },
  "materials": [
    {
      "material_id": "material-001",
      "source_ref": "local-file-001",
      "material_type": "bank-statement",
      "media_type": "application/pdf",
      "kind": "pdf",
      "text": "姓名: [REDACTED_NAME]",
      "images": [],
      "redactions": [{"type": "name", "count": 1}],
      "review_status": "needs_review",
      "user_notes": "请人工复核"
    }
  ]
}
```

`material_id` 和 `source_ref` 是匿名本地引用，不能包含文件名或路径。后端 Schema 使用
`extra=forbid`，未知字段会被拒绝。

## 图片边界

当前版本不做 OCR 或自动画框。图片只生成如下对象：

```json
{
  "image_id": "material-001-image-001",
  "media_type": "image/png",
  "included": false,
  "redaction_status": "pending_manual_redaction",
  "content": null,
  "description": ""
}
```

只有后续真正产生脱敏图片后，才允许同时设置：

```json
{
  "included": true,
  "redaction_status": "redacted",
  "content": "data:image/..."
}
```

## 当前规则擦除范围

第一版浏览器规则处理：

- 邮箱；
- 中国大陆手机号；
- 中国身份证号；
- 12 至 19 位银行账号；
- 常见字母加数字护照号；
- 带“姓名 / Name”“地址 / Address”“出生日期 / DOB”标签的文本。

它不是完整匿名化方案。扫描件、复杂排版、无标签姓名、签名、头像、二维码和图片文字仍需
后续 OCR、NER、人工画框和二次安全扫描。用户确认是当前版本必需的安全门，但不能替代后续
识别能力。

## 后端兜底

- 有 `materials` 时，必须同时满足本地处理、未上传原件、用户确认三个标记；
- 明显邮箱、手机号、身份证、银行账号和护照号仍存在时拒绝请求；
- 禁止原始文件名和路径字段；
- 排除的图片不得携带 `content`；
- 包含内容的图片必须标记为 `redacted`；
- `/material-audit/run` 等敏感接口永不记录请求正文。
