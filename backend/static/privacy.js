/**
 * Browser-only privacy processing pipeline.
 *
 * Raw File objects never leave this module. The exported package deliberately omits original
 * filenames, paths and binary content. Parsers/redactors are adapters so OCR and image redaction
 * can replace the current rough implementation without changing the page or backend contract.
 */

const PDFJS_URL = "./vendor/pdfjs/pdf.min.mjs";
const PDFJS_WORKER_URL = new URL("./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

const TEXT_EXTENSIONS = new Set(["txt", "md", "csv", "json", "xml", "html"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"]);

let pdfjsPromise;

function extensionOf(name) {
  const parts = String(name).toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() : "";
}

function materialKind(file) {
  const ext = extensionOf(file.name);
  if (file.type === "application/pdf" || ext === "pdf") return "pdf";
  if (file.type.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) return "image";
  if (file.type.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) return "text";
  return "unsupported";
}

async function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_URL).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

async function extractPdfText(file) {
  const pdfjs = await loadPdfJs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data: bytes });
  const pdf = await task.promise;
  const pages = [];

  try {
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent();
      const lines = [];
      let current = [];
      let lastY = null;

      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y = item.transform?.[5] ?? null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 3 && current.length) {
          lines.push(current.join(" "));
          current = [];
        }
        current.push(item.str);
        lastY = y;
      }
      if (current.length) lines.push(current.join(" "));
      pages.push(`[PAGE ${pageNo}]\n${lines.join("\n")}`);
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }

  return pages.join("\n\n");
}

/** Render PDF pages to canvas without browser PDF viewer controls or editing affordances. */
export async function renderPdfReadOnly(
  file,
  container,
  { maxPages = 30, isCurrent = () => true } = {},
) {
  const pdfjs = await loadPdfJs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  const pageCount = Math.min(pdf.numPages, maxPages);
  const root = document.createElement("div");
  root.className = "pdf-readonly";
  const notice = document.createElement("div");
  notice.className = "pdf-readonly__notice";
  notice.textContent = `只读预览 · 共 ${pdf.numPages} 页 · 不会修改原文件`;
  root.appendChild(notice);
  container.replaceChildren(root);

  try {
    for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
      if (!isCurrent()) return;
      const page = await pdf.getPage(pageNo);
      const baseViewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(320, (container.clientWidth || 800) - 36);
      const cssScale = Math.min(1.5, availableWidth / baseViewport.width);
      const viewport = page.getViewport({ scale: cssScale });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { alpha: false });
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const pageWrap = document.createElement("section");
      pageWrap.className = "pdf-readonly__page";
      pageWrap.setAttribute("aria-label", `PDF 第 ${pageNo} 页`);
      pageWrap.appendChild(canvas);
      root.appendChild(pageWrap);

      await page.render({
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
      }).promise;
      page.cleanup();
    }
    if (pdf.numPages > maxPages && isCurrent()) {
      const truncated = document.createElement("div");
      truncated.className = "pdf-readonly__notice";
      truncated.textContent = `为控制浏览器内存，仅预览前 ${maxPages} 页。`;
      root.appendChild(truncated);
    }
  } finally {
    await pdf.destroy();
  }
}

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
    ["name", /((?:姓名|申请人姓名|full\s*name|surname|given\s*name)\s*[:：]\s*)([^\n\r,，;；]{2,80})/gi, "[REDACTED_NAME]"],
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

async function imageDimensions(file) {
  if (!("createImageBitmap" in window)) return { width: null, height: null };
  try {
    const bitmap = await createImageBitmap(file);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dimensions;
  } catch {
    return { width: null, height: null };
  }
}

async function processFile(file, index) {
  const materialId = `material-${String(index + 1).padStart(3, "0")}`;
  const kind = materialKind(file);
  const base = {
    material_id: materialId,
    source_ref: `local-file-${String(index + 1).padStart(3, "0")}`,
    material_type: "unknown",
    media_type: file.type || "application/octet-stream",
    kind,
    text: "",
    images: [],
    content_blocks: [],
    redactions: [],
    review_status: "needs_review",
    user_notes: "",
  };

  try {
    if (kind === "pdf") {
      const extracted = await extractPdfText(file);
      const redacted = redactText(extracted);
      return {
        ...base,
        text: redacted.text,
        content_blocks: redacted.text.trim() ? [{ type: "text", text: redacted.text }] : [],
        redactions: redacted.redactions,
        review_status: redacted.text.trim() ? "needs_review" : "blocked",
        user_notes: redacted.text.trim()
          ? "PDF 文本已在本地提取并执行规则擦除；请人工复核姓名、地址和版面信息。"
          : "PDF 没有可提取文本，可能是扫描件；当前版本不会上传或 OCR 原图。",
      };
    }

    if (kind === "text") {
      const redacted = redactText(await file.text());
      return {
        ...base,
        text: redacted.text,
        content_blocks: redacted.text.trim() ? [{ type: "text", text: redacted.text }] : [],
        redactions: redacted.redactions,
        user_notes: "文本已在本地执行规则擦除，请人工复核。",
      };
    }

    if (kind === "image") {
      const dimensions = await imageDimensions(file);
      const safeImage = {
        image_id: `${materialId}-image-001`,
        media_type: file.type || `image/${extensionOf(file.name) || "unknown"}`,
        width: dimensions.width,
        height: dimensions.height,
        included: false,
        redaction_status: "pending_manual_redaction",
        content: null,
        description: "",
      };
      return {
        ...base,
        images: [safeImage],
        content_blocks: [{ type: "image", image: safeImage }],
        review_status: "blocked",
        user_notes: "原图未写入 JSON。后续接入 OCR/画框打码后，才能把脱敏图片内容设为 included。",
      };
    }

    return {
      ...base,
      review_status: "blocked",
      user_notes: "当前版本不支持该文件类型，未读取正文或二进制内容。",
    };
  } catch (error) {
    return {
      ...base,
      review_status: "blocked",
      user_notes: `本地处理失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function processFilesLocally(files, country, onProgress = () => {}) {
  const materials = [];
  for (let index = 0; index < files.length; index += 1) {
    onProgress({ current: index, total: files.length, label: `处理第 ${index + 1} 个文件` });
    materials.push(await processFile(files[index], index));
  }
  onProgress({ current: files.length, total: files.length, label: "本地隐私处理完成" });

  return {
    schema_version: "privacy-materials/v1alpha1",
    country,
    visa_type: country === "IS" ? "schengen-tourism" : "unknown",
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
