/**
 * Browser-only privacy redaction and safe-package pipeline.
 *
 * This module accepts normalized local recognition output, never raw File objects. The exported
 * package deliberately omits original filenames, paths and binary content.
 */

function replaceAndCount(text, regex, replacement, counter, type) {
  return text.replace(regex, (...args) => {
    counter[type] = (counter[type] || 0) + 1;
    return typeof replacement === "function" ? replacement(...args) : replacement;
  });
}

/** Rough deterministic redactor. Future versions can replace this with NER/OCR adapters. */
export function redactText(input) {
  let text = String(input || "");
  const counts = {};

  const directRules = [
    ["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]"],
    ["cn_id", /(?<!\d)\d{17}[0-9Xx](?!\d)/g, "[REDACTED_ID]"],
    ["phone", /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g, "[REDACTED_PHONE]"],
    ["bank_account", /(?<!\d)\d{12,19}(?!\d)/g, "[REDACTED_ACCOUNT]"],
    ["passport", /\b[A-Z]{1,2}\d{6,9}\b/gi, "[REDACTED_PASSPORT]"],
  ];

  for (const [type, regex, token] of directRules) {
    text = replaceAndCount(text, regex, token, counts, type);
  }

  const labeledRules = [
    ["name", /((?:姓名|申请人姓名|full\s*name|name|surname|given\s*name)\s*[:：]\s*)([^\n\r,，;；]{2,80})/gi, "[REDACTED_NAME]"],
    ["address", /((?:住址|地址|家庭地址|address)\s*[:：]\s*)([^\n\r]{4,160})/gi, "[REDACTED_ADDRESS]"],
    ["birth_date", /((?:出生日期|生日|date\s*of\s*birth|dob)\s*[:：]\s*)([^\n\r,，;；]{4,40})/gi, "[REDACTED_DATE]"],
  ];

  for (const [type, regex, token] of labeledRules) {
    text = replaceAndCount(text, regex, (_match, prefix) => `${prefix}${token}`, counts, type);
  }

  return {
    text,
    redactions: Object.entries(counts).map(([type, count]) => ({ type, count })),
  };
}

export function buildSafePackageFromAnalysis(localAudit) {
  const documents = localAudit.context?.documents || localAudit.analyses || [];
  const materials = documents.map((document) => {
    const text = document.full_text ?? document.text ?? "";
    const redacted = redactText(text);
    const sourceImages = document.images || [];
    const imagesToProtect = sourceImages.length ? sourceImages : (document.kind === "image" ? [{}] : []);
    const safeImages = imagesToProtect.map((image, index) => ({
      image_id: `${document.material_id}-image-${String(index + 1).padStart(3, "0")}`,
      media_type: image.media_type || document.media_type,
      width: image.width ?? null,
      height: image.height ?? null,
      included: false,
      redaction_status: "pending_manual_redaction",
      content: null,
      description: "",
    }));
    return {
      material_id: document.material_id,
      source_ref: document.source_ref,
      material_type: "unknown",
      media_type: document.media_type,
      kind: document.kind,
      text: redacted.text,
      images: safeImages,
      content_blocks: [
        ...(redacted.text.trim() ? [{ type: "text", text: redacted.text }] : []),
        ...safeImages.map((image) => ({ type: "image", image })),
      ],
      redactions: redacted.redactions,
      review_status: document.kind === "unsupported" || (!redacted.text.trim() && !safeImages.length)
        ? "blocked" : "needs_review",
      user_notes: "由本地一级审核结果生成；图片隐私打码能力尚未接入。",
    };
  });

  return {
    schema_version: "privacy-materials/v1alpha1",
    country: localAudit.context?.country || localAudit.country,
    visa_type: localAudit.context?.visa_type || (localAudit.country === "IS" ? "schengen-tourism" : "unknown"),
    privacy: {
      processed_locally: true,
      raw_files_uploaded: false,
      user_reviewed: false,
      redaction_engine: "browser-regex-v1",
    },
    materials,
  };
}

export function validateSafePackage(value) {
  const errors = [];
  if (!value || typeof value !== "object") return ["根节点必须是 JSON 对象。"];
  if (value.schema_version !== "privacy-materials/v1alpha1") errors.push("schema_version 不正确。");
  if (value.privacy?.raw_files_uploaded !== false) errors.push("raw_files_uploaded 必须为 false。");
  if (value.privacy?.processed_locally !== true) errors.push("processed_locally 必须为 true。");
  if (!Array.isArray(value.materials) || !value.materials.length) errors.push("materials 不能为空。");

  for (const [index, material] of (value.materials || []).entries()) {
    if (!material.material_id) errors.push(`第 ${index + 1} 项缺少 material_id。`);
    if (!/^material-\d{3}$/.test(material.material_id || "")) {
      errors.push(`第 ${index + 1} 项 material_id 必须是匿名编号。`);
    }
    if (!/^local-file-\d{3}$/.test(material.source_ref || "")) {
      errors.push(`第 ${index + 1} 项 source_ref 必须是匿名本地引用。`);
    }
    if ("name" in material || "path" in material || "relative_path" in material) {
      errors.push(`第 ${index + 1} 项包含原始文件名或路径字段。`);
    }
    for (const image of material.images || []) {
      if (image.included && !image.content) {
        errors.push(`${material.material_id} 的图片标记 included，但没有脱敏后的 content。`);
      }
      if (!image.included && image.content) {
        errors.push(`${material.material_id} 的图片未启用，但仍包含 content。`);
      }
    }
    for (const [blockIndex, block] of (material.content_blocks || []).entries()) {
      if (block.type === "text" && typeof block.text !== "string") {
        errors.push(`${material.material_id} 的第 ${blockIndex + 1} 个文本块无效。`);
      }
      if (block.type === "image" && !block.image) {
        errors.push(`${material.material_id} 的第 ${blockIndex + 1} 个图片块无效。`);
      }
    }
  }
  return errors;
}
