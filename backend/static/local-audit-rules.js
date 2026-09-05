/**
 * Built-in local audit rule plugins.
 *
 * Each rule receives the complete normalized context and owns both candidate
 * discovery and its judgment. Rules never read raw File objects.
 */

const inputAvailableRule = {
  id: "input.materials-available",
  version: "1.0.0",
  title: "申请材料已载入",
  async run(context) {
    if (!context.documents.length) {
      return {
        status: "fail",
        reason: "没有可供一级审核的材料。",
        checked_items: ["检查是否存在已预处理材料"],
        matched_document_ids: [],
      };
    }
    return {
      status: "pass",
      reason: `已载入 ${context.documents.length} 份材料。`,
      checked_items: ["检查是否存在已预处理材料"],
      matched_document_ids: context.documents.map((document) => document.document_id),
    };
  },
};

const readableContentRule = {
  id: "document.readable-content",
  version: "1.0.0",
  title: "材料内容可读取",
  async run(context, tools) {
    if (!context.documents.length) {
      return {
        status: "skipped",
        reason: "没有材料，跳过可读性检查。",
        checked_items: [],
        matched_document_ids: [],
      };
    }
    const errors = tools.findDocuments(context, (document) => document.recognition.status === "error");
    const unsupported = tools.findDocuments(context, (document) => document.recognition.status === "unsupported");
    const withoutText = tools.findDocuments(
      context,
      (document) => document.recognition.text_source === "none" && document.recognition.status !== "error" && document.recognition.status !== "unsupported",
    );
    const evidence = context.documents.map((document) => ({
      document_id: document.document_id,
      source_name: document.local_name,
      recognition_status: document.recognition.status,
      extracted_characters: document.full_text.length,
    }));

    if (errors.length) {
      return {
        status: "fail",
        reason: `${errors.length} 份材料预处理失败。`,
        checked_items: ["检查每份材料的本地预处理状态"],
        matched_document_ids: errors.map((document) => document.document_id),
        evidence,
      };
    }
    if (unsupported.length || withoutText.length) {
      return {
        status: "warning",
        reason: `${unsupported.length} 份格式暂不支持，${withoutText.length} 份尚未提取到文字。`,
        checked_items: ["检查文件格式", "检查可提取文字"],
        matched_document_ids: [...unsupported, ...withoutText].map((document) => document.document_id),
        evidence,
      };
    }
    return {
      status: "pass",
      reason: "全部材料均已完成本地文字读取。",
      checked_items: ["检查文件格式", "检查可提取文字"],
      matched_document_ids: context.documents.map((document) => document.document_id),
      evidence,
    };
  },
};

const localOcrCoverageRule = {
  id: "document.local-ocr-coverage",
  version: "1.0.0",
  title: "图片和扫描件文字识别",
  async run(context, tools) {
    const needsOcr = tools.findDocuments(context, (document) => document.recognition.ocr_status === "unavailable");
    if (!needsOcr.length) {
      return {
        status: "skipped",
        reason: "当前材料均不需要本地 OCR 补充。",
        checked_items: ["定位需要 OCR 的图片或扫描件"],
        matched_document_ids: [],
      };
    }
    return {
      status: "unavailable",
      reason: `${needsOcr.length} 份材料需要 OCR；当前本地 OCR 适配器尚未接入。`,
      checked_items: ["定位需要 OCR 的图片或扫描件"],
      matched_document_ids: needsOcr.map((document) => document.document_id),
      evidence: needsOcr.map((document) => ({
        document_id: document.document_id,
        source_name: document.local_name,
        kind: document.kind,
      })),
    };
  },
};

const passportCandidateRule = {
  id: "passport.material-candidate",
  version: "1.0.0",
  title: "护照材料候选定位",
  appliesTo(context) {
    return context.visa_type === "schengen-tourism";
  },
  async run(context, tools) {
    const candidates = tools.rankDocuments(context, {
      fileNameKeywords: ["passport", "护照"],
      textKeywords: ["passport", "护照", "国家移民管理局", "p<"],
      kinds: ["pdf", "image"],
    });
    if (!candidates.length) {
      const blockedByOcr = tools.findDocuments(context, (document) => document.recognition.ocr_status === "unavailable");
      return {
        status: blockedByOcr.length ? "unavailable" : "fail",
        reason: blockedByOcr.length
          ? "未定位到护照候选；部分图片或扫描件尚未进行 OCR，当前不能可靠判定护照是否缺失。"
          : "未在已识别材料中找到护照候选。",
        checked_items: ["按文件名和正文特征查找护照材料"],
        matched_document_ids: [],
      };
    }
    const bestScore = candidates[0].score;
    const bestCandidates = candidates.filter((candidate) => candidate.score === bestScore);
    return {
      status: bestScore >= 3 ? "pass" : "warning",
      reason: bestCandidates.length > 1
        ? `找到 ${bestCandidates.length} 份同等置信度的护照候选，需要人工确认。`
        : `找到护照候选：${bestCandidates[0].document.local_name}。`,
      checked_items: ["按文件名和正文特征查找护照材料"],
      matched_document_ids: bestCandidates.map((candidate) => candidate.document.document_id),
      evidence: bestCandidates.map((candidate) => ({
        document_id: candidate.document.document_id,
        source_name: candidate.document.local_name,
        score: candidate.score,
        reasons: candidate.reasons,
      })),
    };
  },
};

export const builtInLocalAuditRules = Object.freeze([
  inputAvailableRule,
  readableContentRule,
  localOcrCoverageRule,
  passportCandidateRule,
]);
