# 浏览器本地审核架构

## 模块边界

本地审核由两个互相独立的模块组成：

1. 本地识别/预处理模块接收浏览器 `File[]`，负责读取 PDF 文字层、文本文件，并对扫描页和
   图片执行本地 OCR。版面分析和本地图片描述等后续能力也在这一层接入。
2. 审核模块只接收 `local-document-context/v1`，不读取原始 `File`，也不负责 PDF、OCR
   或图片解码。它遍历插件规则并汇总结果。

当前实现文件：

- `backend/static/local-recognition.js`：本地预处理；
- `backend/static/ocr-pool.js`：共享的双 Worker OCR 调度池；
- `backend/static/local-audit-engine.js`：规则校验、执行、错误隔离和汇总；
- `backend/static/local-audit-rules.js`：内置规则注册表；
- `backend/static/local-audit-tools.js`：规则间共享的确定性工具；
- `backend/static/privacy.js`：复用预处理文字坐标进行隐私定位，并负责手动涂抹和安全文件重建。

本地/远端规则的边界不是复杂度，而是**是否必须使用原始隐私**。需要真实姓名、证件号等
信息才能判断的规则放在本地；不需要真实身份、可基于脱敏材料判断的规则交给后端 Agent、
Checklist 和知识库。详见 [`privacy-safe-materials.md`](privacy-safe-materials.md)。

## 统一上下文

预处理输出标准化 `documents`。每个文档包含匿名 ID、本地显示名称、媒体类型、分页文本块、
图片元数据和识别状态，但不包含原始 `File` 引用。审核引擎把国家、签证类型、Checklist 和
文档组合成只读 context：

```js
{
  schema_version: "local-audit-context/v1",
  country: "IS",
  visa_type: "schengen-tourism",
  checklist: [],
  documents: [],
  preprocessing: {
    processed_locally: true,
    raw_files_uploaded: false
  }
}
```

## 文字提取与 OCR 调度

PDF 按页处理。页面有足够可靠的文字层时，直接保存文字及其视觉坐标，不再把整页渲染后
交给 OCR；没有文字层、只有零星文字或文字层不可用的页面才渲染成图片并进入 OCR 队列。
普通图片直接进入 OCR 队列。

OCR 使用一个页面级全局调度池，固定创建两个 Worker。外层预处理模块负责拆文件、拆 PDF
页面、创建任务以及按文件和页码恢复顺序；Tesseract Worker 只负责识别单张页面图片。
文件处理与页面识别都共享同一并发上限，避免形成“文件并发 × 页面并发”的 Worker 膨胀。

预处理结果为每页保留 `recognition_method`、`ocr_status`、文字、文字坐标和识别错误。隐私
处理直接复用这些结果，不重复 OCR；只有旧会话或缺失识别结果时才启动补充 OCR。

## 规则插件

引擎不区分文件规则和全局规则。每条规则拿到整套 context，自行寻找一个或多个候选文档，
然后执行判断：

```js
export const rule = {
  id: "passport.validity",
  version: "1.0.0",
  title: "护照有效期检查",
  appliesTo(context) {
    return context.visa_type === "schengen-tourism";
  },
  async run(context, tools) {
    const candidates = tools.rankDocuments(context, {
      fileNameKeywords: ["passport", "护照"],
      textKeywords: ["passport", "护照"]
    });
    return {
      status: "pass",
      reason: "...",
      checked_items: ["..."],
      matched_document_ids: candidates.map(item => item.document.document_id),
      evidence: []
    };
  }
};
```

规则状态统一为 `pass`、`fail`、`warning`、`skipped`、`unavailable` 或 `error`。单条规则
抛出异常时，引擎记录 `error` 并继续执行其他规则。

新增规则时，只需实现相同接口并加入规则注册表。通用的文档搜索、候选评分、日期解析、
姓名标准化和字段一致性比较应放进工具模块，避免规则重复实现底层能力。
