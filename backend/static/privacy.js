/** Browser-only visual privacy redaction for PDF/JPG copies. */

import { createOcrPool, DEFAULT_OCR_WORKER_COUNT } from "./ocr-pool.js";

const PDFJS_URL = "./vendor/pdfjs/pdf.min.mjs";
const PDFJS_WORKER_URL = new URL("./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
const PDF_LIB_URL = new URL("./vendor/pdf-lib/pdf-lib.min.js", import.meta.url).href;
const PDF_RENDER_SCALE = 1.6;

let pdfjsPromise;
let pdfLibPromise;

function extensionOf(name) {
  const parts = String(name || "").toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() : "";
}

export function redactionFileKind(file) {
  const extension = extensionOf(file?.name);
  if (file?.type === "application/pdf" || extension === "pdf") return "pdf";
  if (file?.type === "image/jpeg" || extension === "jpg" || extension === "jpeg") return "image";
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

async function loadPdfLib() {
  if (globalThis.PDFLib) return globalThis.PDFLib;
  if (!pdfLibPromise) {
    pdfLibPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = PDF_LIB_URL;
      script.onload = () => resolve(globalThis.PDFLib);
      script.onerror = () => reject(new Error("PDF 重建组件加载失败"));
      document.head.appendChild(script);
    });
  }
  return pdfLibPromise;
}

function canvasToBlob(canvas, type = "image/jpeg", quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("无法生成脱敏文件")), type, quality);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("文件编码失败"));
    reader.readAsDataURL(blob);
  });
}

async function renderImageFile(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d", { alpha: false }).drawImage(bitmap, 0, 0);
  bitmap.close();
  return [{ page_number: 1, width: canvas.width, height: canvas.height, canvas }];
}

async function renderPdfFile(file) {
  const pdfjs = await loadPdfJs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport }).promise;
      pages.push({ page_number: pageNumber, width: canvas.width, height: canvas.height, canvas });
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
  return pages;
}

async function renderSourcePages(file) {
  const kind = redactionFileKind(file);
  if (kind === "image") return renderImageFile(file);
  if (kind === "pdf") return renderPdfFile(file);
  throw new Error("当前隐私擦除只支持 PDF、JPG 和 JPEG");
}

const DIRECT_PII = [
  ["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
  ["cn_id", /(?<!\d)\d{17}[0-9Xx](?!\d)/g],
  ["phone", /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g],
  ["bank_account", /(?<!\d)\d{12,19}(?!\d)/g],
  ["passport", /\b[A-Z]{1,2}\d{6,9}\b/gi],
];

const LABELED_PII = [
  ["name", /(?:姓名|申请人姓名|full\s*name|name|surname|given\s*name)\s*[:：]?\s*([^\n\r,，;；]{2,80})/gi],
  ["address", /(?:住址|地址|家庭地址|address)\s*[:：]?\s*([^\n\r]{4,160})/gi],
  ["birth_date", /(?:出生日期|生日|date\s*of\s*birth|dob)\s*[:：]?\s*([^\n\r,，;；]{4,40})/gi],
];

export function detectSensitiveRanges(input) {
  const text = String(input || "");
  const ranges = [];
  for (const [type, expression] of DIRECT_PII) {
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) {
      ranges.push({ type, start: match.index, end: match.index + match[0].length });
    }
  }
  for (const [type, expression] of LABELED_PII) {
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) {
      const value = match[1] || "";
      const offset = match[0].lastIndexOf(value);
      ranges.push({ type, start: match.index + offset, end: match.index + offset + value.length });
    }
  }
  return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function boxesForSensitiveWords(words) {
  const byLine = new Map();
  for (const word of words || []) {
    const line = word.line || "1";
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line).push(word);
  }
  const boxes = [];
  for (const lineWords of byLine.values()) {
    let text = "";
    const offsets = [];
    for (const word of lineWords) {
      if (text) text += " ";
      const start = text.length;
      text += word.text;
      offsets.push({ word, start, end: text.length });
    }
    for (const range of detectSensitiveRanges(text)) {
      const matched = offsets.filter(({ start, end }) => start < range.end && end > range.start);
      if (!matched.length) continue;
      for (const { word, start, end } of matched) {
        const preciseTextLayerBox = word.source === "pdf_text_layer" && word.text.length > 0;
        const startRatio = preciseTextLayerBox ? Math.max(0, (range.start - start) / word.text.length) : 0;
        const endRatio = preciseTextLayerBox ? Math.min(1, (range.end - start) / word.text.length) : 1;
        const left = word.left + word.width * startRatio;
        const right = word.left + word.width * Math.max(startRatio, endRatio);
        boxes.push({
          id: crypto.randomUUID(), type: range.type, source: "automatic",
          x: Math.max(0, left - 5), y: Math.max(0, word.top - 3),
          width: right - left + 10, height: word.height + 6,
        });
      }
    }
  }
  return boxes;
}

function reusableRecognition(page) {
  return page && ["pdf_text_layer", "ocr"].includes(page.recognition_method)
    && Array.isArray(page.words)
    && page.ocr_status !== "failed";
}

export async function prepareRedactionWorkspace(localAudit, files, { onProgress = () => {} } = {}) {
  const documents = localAudit?.context?.documents || [];
  const materials = [];
  let ocrPoolPromise = null;
  let ocrPool = null;
  async function getOcrPool() {
    if (!ocrPoolPromise) {
      onProgress({ label: "正在加载双 Worker 本地 OCR", current: 0, total: files.length });
      ocrPoolPromise = createOcrPool({ workerCount: DEFAULT_OCR_WORKER_COUNT });
    }
    ocrPool = await ocrPoolPromise;
    return ocrPool;
  }
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const source = documents[index] || {};
      const kind = redactionFileKind(file);
      const material = {
        material_id: source.material_id || `material-${String(index + 1).padStart(3, "0")}`,
        source_ref: source.source_ref || `local-file-${String(index + 1).padStart(3, "0")}`,
        kind,
        media_type: kind === "pdf" ? "application/pdf" : (kind === "image" ? "image/jpeg" : "application/octet-stream"),
        pages: [], review_status: kind === "unsupported" ? "blocked" : "needs_review",
        processing_error: kind === "unsupported" ? "当前仅支持 PDF、JPG 和 JPEG 的隐私擦除。" : null,
        sanitized_file: null,
      };
      if (kind !== "unsupported") {
        try {
          const rendered = await renderSourcePages(file);
          for (let pageIndex = 0; pageIndex < rendered.length; pageIndex += 1) {
            const page = rendered[pageIndex];
            const recognizedPage = source.pages?.[pageIndex];
            let redactions = [];
            let recognitionMethod = recognizedPage?.recognition_method || "ocr";
            let ocrStatus = recognizedPage?.ocr_status || "pending";
            let ocrError = recognizedPage?.recognition_error || null;
            if (reusableRecognition(recognizedPage)) {
              onProgress({ label: `复用本地识别 ${index + 1}/${files.length} · 第 ${pageIndex + 1}/${rendered.length} 页`, current: index, total: files.length });
              redactions = boxesForSensitiveWords(recognizedPage.words);
            } else {
              onProgress({ label: `补充 OCR ${index + 1}/${files.length} · 第 ${pageIndex + 1}/${rendered.length} 页`, current: index, total: files.length });
              try {
                const result = await (await getOcrPool()).recognize(page.canvas);
                redactions = boxesForSensitiveWords(result.words);
                recognitionMethod = "ocr";
                ocrStatus = "completed";
                ocrError = null;
              } catch (error) {
                ocrStatus = "failed";
                ocrError = error instanceof Error ? error.message : String(error);
              }
            }
            material.pages.push({
              page_number: page.page_number,
              width: page.width,
              height: page.height,
              redactions,
              recognition_method: recognitionMethod,
              ocr_status: ocrStatus,
              ocr_error: ocrError,
            });
          }
        } catch (error) {
          material.review_status = "blocked";
          material.processing_error = error instanceof Error ? error.message : String(error);
        }
      }
      materials.push(material);
    }
  } finally {
    if (ocrPool) await ocrPool.terminate();
  }
  onProgress({ label: "本地隐私识别完成", current: files.length, total: files.length });
  return { schema_version: "local-redaction-workspace/v1", country: localAudit.context?.country || localAudit.country, visa_type: localAudit.context?.visa_type || "unknown", materials };
}

function drawRedactions(context, redactions) {
  context.save();
  context.fillStyle = "#05070a";
  for (const box of redactions || []) context.fillRect(box.x, box.y, box.width, box.height);
  context.restore();
}

async function renderedPagesWithRedactions(material, file) {
  const rendered = await renderSourcePages(file);
  for (let index = 0; index < rendered.length; index += 1) {
    drawRedactions(rendered[index].canvas.getContext("2d"), material.pages[index]?.redactions || []);
  }
  return rendered;
}

export async function exportRedactedMaterial(material, file) {
  if (material.kind === "unsupported" || material.processing_error) throw new Error(material.processing_error || "此文件无法脱敏");
  const pages = await renderedPagesWithRedactions(material, file);
  let blob;
  if (material.kind === "image") {
    blob = await canvasToBlob(pages[0].canvas, "image/jpeg", 0.92);
  } else {
    const PDFLib = await loadPdfLib();
    const pdf = await PDFLib.PDFDocument.create();
    pdf.setTitle(""); pdf.setAuthor(""); pdf.setSubject(""); pdf.setKeywords([]);
    pdf.setProducer("visa-helper local redaction"); pdf.setCreator("visa-helper local redaction");
    for (const rendered of pages) {
      const pageBlob = await canvasToBlob(rendered.canvas, "image/jpeg", 0.9);
      const image = await pdf.embedJpg(await pageBlob.arrayBuffer());
      const page = pdf.addPage([rendered.width, rendered.height]);
      page.drawImage(image, { x: 0, y: 0, width: rendered.width, height: rendered.height });
    }
    blob = new Blob([await pdf.save({ useObjectStreams: true })], { type: "application/pdf" });
  }
  const redactionCount = material.pages.reduce((sum, page) => sum + page.redactions.length, 0);
  material.sanitized_file = { media_type: material.media_type, content: await blobToDataUrl(blob), size: blob.size, page_count: pages.length, redaction_count: redactionCount };
  material.review_status = "ready";
  return material.sanitized_file;
}

export function buildSafePackage(workspace, userReviewed = false) {
  return {
    schema_version: "privacy-files/v1", country: workspace.country, visa_type: workspace.visa_type,
    privacy: { processed_locally: true, raw_files_uploaded: false, user_reviewed: Boolean(userReviewed), redaction_engine: "browser-ocr-manual-v1" },
    materials: workspace.materials.map((material) => ({
      material_id: material.material_id, source_ref: material.source_ref, kind: material.kind,
      media_type: material.media_type, sanitized_file: material.sanitized_file, review_status: material.review_status,
    })),
  };
}

export function validateSafePackage(value, { requireReady = Boolean(value?.privacy?.user_reviewed) } = {}) {
  const errors = [];
  if (value?.schema_version !== "privacy-files/v1") errors.push("安全材料协议版本不正确。");
  if (value?.privacy?.processed_locally !== true) errors.push("材料尚未在本地处理。");
  if (value?.privacy?.raw_files_uploaded !== false) errors.push("不得上传原始文件。");
  if (!value?.materials?.length) errors.push("安全材料不能为空。");
  for (const [index, material] of (value?.materials || []).entries()) {
    if (!/^material-\d{3}$/.test(material.material_id || "")) errors.push(`第 ${index + 1} 项缺少匿名材料编号。`);
    if (!/^local-file-\d{3}$/.test(material.source_ref || "")) errors.push(`第 ${index + 1} 项缺少匿名本地引用。`);
    if (requireReady && !["pdf", "image"].includes(material.kind)) errors.push(`${material.material_id} 不是当前支持的 PDF/JPG。`);
    if (requireReady && !material.sanitized_file?.content?.startsWith(`data:${material.media_type};base64,`)) errors.push(`${material.material_id} 尚未生成可发送的脱敏文件。`);
    if (requireReady && material.review_status !== "ready") errors.push(`${material.material_id} 尚未确认。`);
    if ("name" in material || "path" in material || "pages" in material) errors.push(`${material.material_id} 包含不应发送的本地字段。`);
  }
  return errors;
}

export function countRedactions(workspace) {
  return (workspace?.materials || []).reduce((total, material) => total + material.pages.reduce((sum, page) => sum + page.redactions.length, 0), 0);
}

export async function renderRedactionEditor(material, file, container, { onChange = () => {}, isCurrent = () => true } = {}) {
  container.replaceChildren();
  if (material.kind === "unsupported" || material.processing_error) {
    const empty = document.createElement("div");
    empty.className = "privacy-content__empty";
    empty.textContent = material.processing_error || "此文件暂不支持隐私擦除。";
    container.appendChild(empty);
    return;
  }
  const toolbar = document.createElement("div");
  toolbar.className = "redaction-toolbar";
  toolbar.innerHTML = `<b>涂抹模式</b><span>在遗漏的隐私上拖动画框</span>`;
  const undo = document.createElement("button");
  undo.type = "button"; undo.className = "redaction-tool"; undo.textContent = "撤销上一笔";
  toolbar.appendChild(undo); container.appendChild(toolbar);
  const pageHost = document.createElement("div");
  pageHost.className = "redaction-pages"; container.appendChild(pageHost);
  const rendered = await renderSourcePages(file);
  if (!isCurrent()) return;
  const overlays = [];
  function redraw() {
    rendered.forEach((page, index) => {
      const overlay = overlays[index];
      if (!overlay) return;
      const context = overlay.getContext("2d");
      context.clearRect(0, 0, overlay.width, overlay.height);
      drawRedactions(context, material.pages[index]?.redactions || []);
    });
  }
  rendered.forEach((page, index) => {
    const wrap = document.createElement("section");
    wrap.className = "redaction-page"; wrap.setAttribute("aria-label", `脱敏编辑第 ${index + 1} 页`);
    const label = document.createElement("span");
    label.className = "redaction-page__label"; label.textContent = material.kind === "pdf" ? `第 ${index + 1} 页` : "JPG 图片";
    const surface = document.createElement("div"); surface.className = "redaction-page__surface";
    surface.style.setProperty("--page-width", `${page.width}px`);
    surface.style.aspectRatio = `${page.width} / ${page.height}`;
    page.canvas.className = "redaction-page__source";
    const overlay = document.createElement("canvas");
    overlay.className = "redaction-page__overlay"; overlay.width = page.width; overlay.height = page.height;
    overlays.push(overlay); surface.append(page.canvas, overlay); wrap.append(label, surface); pageHost.appendChild(wrap);
    let start = null;
    overlay.addEventListener("pointerdown", (event) => {
      const rect = overlay.getBoundingClientRect();
      start = { x: (event.clientX - rect.left) * overlay.width / rect.width, y: (event.clientY - rect.top) * overlay.height / rect.height };
      overlay.setPointerCapture(event.pointerId);
    });
    overlay.addEventListener("pointerup", (event) => {
      if (!start) return;
      const rect = overlay.getBoundingClientRect();
      const end = { x: (event.clientX - rect.left) * overlay.width / rect.width, y: (event.clientY - rect.top) * overlay.height / rect.height };
      const x = Math.max(0, Math.min(start.x, end.x)); const y = Math.max(0, Math.min(start.y, end.y));
      const width = Math.min(overlay.width - x, Math.abs(end.x - start.x)); const height = Math.min(overlay.height - y, Math.abs(end.y - start.y));
      start = null;
      if (width < 5 || height < 5) return;
      material.pages[index].redactions.push({ id: crypto.randomUUID(), type: "manual", source: "manual", x, y, width, height });
      material.sanitized_file = null; material.review_status = "needs_review"; redraw(); onChange(material);
    });
  });
  undo.addEventListener("click", () => {
    for (let index = material.pages.length - 1; index >= 0; index -= 1) {
      const redactions = material.pages[index].redactions;
      const manualIndex = redactions.map((item) => item.source).lastIndexOf("manual");
      if (manualIndex >= 0) {
        redactions.splice(manualIndex, 1); material.sanitized_file = null; material.review_status = "needs_review";
        redraw(); onChange(material); return;
      }
    }
  });
  redraw();
}
