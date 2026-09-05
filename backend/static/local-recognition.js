/**
 * Browser-local document preprocessing.
 *
 * This module knows how to read files, but knows nothing about visa rules. Its
 * only output is a normalized document context consumed by downstream rules.
 */

import { createOcrPool, DEFAULT_OCR_WORKER_COUNT } from "./ocr-pool.js";

const PDFJS_URL = "./vendor/pdfjs/pdf.min.mjs";
const PDFJS_WORKER_URL = new URL("./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
const TEXT_EXTENSIONS = new Set(["txt", "md", "csv", "json", "xml", "html"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"]);
const PDF_PROCESS_SCALE = 1.6;
const MIN_USABLE_TEXT_CHARACTERS = 16;
export const LOCAL_RECOGNITION_PIPELINE_VERSION = "hybrid-ocr-v2";

let pdfjsPromise;

function extensionOf(name) {
  const parts = String(name).toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() : "";
}

function documentKind(file) {
  const extension = extensionOf(file.name);
  if (file.type === "application/pdf" || extension === "pdf") return "pdf";
  if (file.type.startsWith("image/") || IMAGE_EXTENSIONS.has(extension)) return "image";
  if (file.type.startsWith("text/") || TEXT_EXTENSIONS.has(extension)) return "text";
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

export function hasUsablePdfText(text, itemCount = 0) {
  const meaningfulCharacters = String(text || "").replace(/\s/g, "").length;
  return meaningfulCharacters >= MIN_USABLE_TEXT_CHARACTERS && itemCount > 0;
}

function textItemBounds(item, viewport, pdfjs) {
  const transform = pdfjs.Util.transform(viewport.transform, item.transform);
  const angle = Math.atan2(transform[1], transform[0]);
  const width = Math.max(1, Math.abs(Number(item.width || 0) * viewport.scale));
  const height = Math.max(1, Math.hypot(transform[2], transform[3]));
  const along = { x: Math.cos(angle) * width, y: Math.sin(angle) * width };
  const above = { x: Math.sin(angle) * height, y: -Math.cos(angle) * height };
  const corners = [
    { x: transform[4], y: transform[5] },
    { x: transform[4] + along.x, y: transform[5] + along.y },
    { x: transform[4] + above.x, y: transform[5] + above.y },
    { x: transform[4] + along.x + above.x, y: transform[5] + along.y + above.y },
  ];
  const left = Math.min(...corners.map((point) => point.x));
  const top = Math.min(...corners.map((point) => point.y));
  const right = Math.max(...corners.map((point) => point.x));
  const bottom = Math.max(...corners.map((point) => point.y));
  return { left, top, width: right - left, height: bottom - top };
}

function extractPdfTextPage(content, viewport, pdfjs, pageNumber) {
  const lines = [];
  const words = [];
  let currentLine = [];
  let lineNumber = 1;
  let previousY = null;

  for (const item of content.items) {
    if (!("str" in item) || !item.str?.trim()) continue;
    const y = item.transform?.[5] ?? null;
    if (previousY !== null && y !== null && Math.abs(y - previousY) > 3 && currentLine.length) {
      lines.push(currentLine.join(" "));
      currentLine = [];
      lineNumber += 1;
    }
    currentLine.push(item.str);
    words.push({
      text: item.str,
      line: `${pageNumber}:${lineNumber}`,
      ...textItemBounds(item, viewport, pdfjs),
      confidence: 100,
      source: "pdf_text_layer",
    });
    previousY = y;
    if (item.hasEOL) {
      lines.push(currentLine.join(" "));
      currentLine = [];
      lineNumber += 1;
      previousY = null;
    }
  }
  if (currentLine.length) lines.push(currentLine.join(" "));
  return { text: lines.join("\n"), words };
}

async function renderPageForOcr(page) {
  const viewport = page.getViewport({ scale: PDF_PROCESS_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport }).promise;
  return canvas;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function consume() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, consume));
  return results;
}

async function extractPdf(file, getOcrPool, onProgress, debugLog) {
  const pdfStartedAt = performance.now();
  debugLog("pdf.open.started", { file_name: file.name, file_size: file.size });
  const pdfjs = await loadPdfJs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  const pages = new Array(pdf.numPages);
  const ocrPageNumbers = [];
  debugLog("pdf.open.completed", {
    file_name: file.name,
    file_size: file.size,
    page_count: pdf.numPages,
    duration_ms: performance.now() - pdfStartedAt,
  });

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const extractionStartedAt = performance.now();
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const viewport = page.getViewport({ scale: PDF_PROCESS_SCALE });
      const extracted = extractPdfTextPage(content, viewport, pdfjs, pageNumber);
      const usableText = hasUsablePdfText(extracted.text, extracted.words.length);
      debugLog("pdf.page.text-layer.checked", {
        file_name: file.name,
        page_number: pageNumber,
        page_count: pdf.numPages,
        text_items: extracted.words.length,
        extracted_characters: extracted.text.length,
        usable: usableText,
        duration_ms: performance.now() - extractionStartedAt,
        rendered_width: Math.ceil(viewport.width),
        rendered_height: Math.ceil(viewport.height),
      });
      if (usableText) {
        pages[pageNumber - 1] = {
          page_number: pageNumber,
          width: Math.ceil(viewport.width),
          height: Math.ceil(viewport.height),
          blocks: [{ type: "text", text: extracted.text, source: "pdf_text_layer" }],
          text: extracted.text,
          words: extracted.words,
          recognition_method: "pdf_text_layer",
          ocr_status: "not_required",
          recognition_error: null,
        };
      } else {
        ocrPageNumbers.push(pageNumber);
        debugLog("pdf.page.routed-to-ocr", {
          file_name: file.name,
          page_number: pageNumber,
          reason: "missing_or_insufficient_text_layer",
          extracted_characters: extracted.text.length,
          text_items: extracted.words.length,
        });
      }
      page.cleanup();
    }

    await mapWithConcurrency(ocrPageNumbers, DEFAULT_OCR_WORKER_COUNT, async (pageNumber) => {
      const page = await pdf.getPage(pageNumber);
      let canvas = null;
      try {
        onProgress(`OCR 识别 PDF 第 ${pageNumber}/${pdf.numPages} 页`);
        const renderStartedAt = performance.now();
        canvas = await renderPageForOcr(page);
        debugLog("pdf.page.rendered-for-ocr", {
          file_name: file.name,
          page_number: pageNumber,
          width: canvas.width,
          height: canvas.height,
          duration_ms: performance.now() - renderStartedAt,
        });
        const result = await (await getOcrPool()).recognize(canvas, {
          file_name: file.name,
          page_number: pageNumber,
          source_kind: "pdf",
        });
        pages[pageNumber - 1] = {
          page_number: pageNumber,
          width: canvas.width,
          height: canvas.height,
          blocks: result.text.trim() ? [{ type: "text", text: result.text, source: "ocr" }] : [],
          text: result.text,
          words: result.words,
          recognition_method: "ocr",
          ocr_status: "completed",
          recognition_error: null,
        };
        debugLog("pdf.page.ocr.completed", {
          file_name: file.name,
          page_number: pageNumber,
          recognized_characters: result.text.length,
          recognized_words: result.words.length,
        });
      } catch (error) {
        const viewport = page.getViewport({ scale: PDF_PROCESS_SCALE });
        pages[pageNumber - 1] = {
          page_number: pageNumber,
          width: Math.ceil(viewport.width),
          height: Math.ceil(viewport.height),
          blocks: [],
          text: "",
          words: [],
          recognition_method: "ocr",
          ocr_status: "failed",
          recognition_error: error instanceof Error ? error.message : String(error),
        };
        debugLog("pdf.page.ocr.failed", {
          file_name: file.name,
          page_number: pageNumber,
          error,
        }, "error");
      } finally {
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
        page.cleanup();
      }
    });
  } finally {
    await pdf.destroy();
    debugLog("pdf.processing.completed", {
      file_name: file.name,
      page_count: pages.length,
      direct_text_pages: pages.filter((page) => page?.recognition_method === "pdf_text_layer").length,
      ocr_pages: pages.filter((page) => page?.recognition_method === "ocr").length,
      failed_pages: pages.filter((page) => page?.ocr_status === "failed").length,
      duration_ms: performance.now() - pdfStartedAt,
    });
  }

  return pages;
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

function documentBase(file, index) {
  const sequence = String(index + 1).padStart(3, "0");
  return {
    document_id: `document-${sequence}`,
    material_id: `material-${sequence}`,
    source_ref: `local-file-${sequence}`,
    local_name: file.webkitRelativePath || file.name,
    media_type: file.type || "application/octet-stream",
    kind: documentKind(file),
    size: file.size,
    last_modified: file.lastModified || null,
    full_text: "",
    pages: [],
    images: [],
    recognition: {
      status: "pending",
      text_source: "none",
      ocr_status: "not_required",
      error: null,
    },
  };
}

function summarizePdfRecognition(pages, fullText) {
  const methods = new Set(pages.map((page) => page.recognition_method));
  const ocrPages = pages.filter((page) => page.recognition_method === "ocr");
  const failedOcrPages = ocrPages.filter((page) => page.ocr_status === "failed");
  let textSource = "none";
  if (fullText.replace(/\[PAGE \d+\]/g, "").trim()) {
    textSource = methods.size > 1 ? "mixed" : (methods.has("ocr") ? "ocr" : "pdf_text_layer");
  }
  return {
    status: failedOcrPages.length || textSource === "none" ? "partial" : "success",
    text_source: textSource,
    ocr_status: failedOcrPages.length ? "failed" : (ocrPages.length ? "completed" : "not_required"),
    error: failedOcrPages.length ? `${failedOcrPages.length} 页 OCR 识别失败` : null,
  };
}

async function preprocessFile(file, index, getOcrPool, onProgress, debugLog) {
  const base = documentBase(file, index);
  try {
    if (base.kind === "pdf") {
      const pages = await extractPdf(file, getOcrPool, onProgress, debugLog);
      const fullText = pages
        .map((page) => `[PAGE ${page.page_number}]\n${page.text}`)
        .join("\n\n");
      return {
        ...base,
        full_text: fullText,
        pages,
        recognition: summarizePdfRecognition(pages, fullText),
      };
    }

    if (base.kind === "text") {
      const startedAt = performance.now();
      const text = await file.text();
      debugLog("text-file.read", {
        file_name: file.name,
        characters: text.length,
        duration_ms: performance.now() - startedAt,
      });
      return {
        ...base,
        full_text: text,
        pages: [{
          page_number: 1,
          blocks: text ? [{ type: "text", text, source: "direct_text" }] : [],
          text,
        }],
        recognition: {
          status: text.trim() ? "success" : "partial",
          text_source: "direct_text",
          ocr_status: "not_required",
          error: null,
        },
      };
    }

    if (base.kind === "image") {
      const imageStartedAt = performance.now();
      const dimensions = await imageDimensions(file);
      debugLog("image.decoded", {
        file_name: file.name,
        file_size: file.size,
        width: dimensions.width,
        height: dimensions.height,
        duration_ms: performance.now() - imageStartedAt,
      });
      onProgress("OCR 识别图片");
      const bitmap = await createImageBitmap(file);
      let result;
      try {
        result = await (await getOcrPool()).recognize(bitmap, {
          file_name: file.name,
          page_number: 1,
          source_kind: "image",
        });
      } finally {
        bitmap.close();
      }
      const image = {
        image_id: `${base.document_id}-image-001`,
        media_type: base.media_type,
        width: dimensions.width,
        height: dimensions.height,
        description: "",
        ocr_text: result.text,
      };
      debugLog("image.ocr.completed", {
        file_name: file.name,
        recognized_characters: result.text.length,
        recognized_words: result.words.length,
        duration_ms: performance.now() - imageStartedAt,
      });
      return {
        ...base,
        full_text: result.text,
        pages: [{
          page_number: 1,
          width: dimensions.width,
          height: dimensions.height,
          blocks: [
            { type: "image", image_id: image.image_id },
            ...(result.text.trim() ? [{ type: "text", text: result.text, source: "ocr" }] : []),
          ],
          text: result.text,
          words: result.words,
          recognition_method: "ocr",
          ocr_status: "completed",
          recognition_error: null,
        }],
        images: [image],
        recognition: {
          status: result.text.trim() ? "success" : "partial",
          text_source: result.text.trim() ? "ocr" : "none",
          ocr_status: "completed",
          error: null,
        },
      };
    }

    return {
      ...base,
      recognition: {
        status: "unsupported",
        text_source: "none",
        ocr_status: "unavailable",
        error: null,
      },
    };
  } catch (error) {
    debugLog("file.processing.failed", {
      file_name: file.name,
      file_index: index,
      kind: base.kind,
      error,
    }, "error");
    return {
      ...base,
      recognition: {
        status: "error",
        text_source: "none",
        ocr_status: "unavailable",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function preprocessFilesLocally(
  files,
  { onProgress = () => {}, debugLog = () => {} } = {},
) {
  const preprocessingStartedAt = performance.now();
  let ocrPoolPromise = null;
  let ocrPool = null;
  let completedFiles = 0;
  async function getOcrPool() {
    if (!ocrPoolPromise) {
      onProgress({ current: completedFiles, total: files.length, label: "正在加载双 Worker 本地 OCR" });
      ocrPoolPromise = createOcrPool({ workerCount: DEFAULT_OCR_WORKER_COUNT, debugLog });
    }
    ocrPool = await ocrPoolPromise;
    return ocrPool;
  }
  debugLog("preprocessing.started", {
    file_count: files.length,
    files: Array.from(files, (file, index) => ({
      index,
      name: file.name,
      relative_path: file.webkitRelativePath || file.name,
      media_type: file.type || "application/octet-stream",
      size: file.size,
      last_modified: file.lastModified || null,
    })),
    file_concurrency: DEFAULT_OCR_WORKER_COUNT,
    ocr_workers: DEFAULT_OCR_WORKER_COUNT,
  });
  try {
    const indexedFiles = Array.from(files, (file, index) => ({ file, index }));
    const documents = await mapWithConcurrency(indexedFiles, DEFAULT_OCR_WORKER_COUNT, async ({ file, index }) => {
      const fileStartedAt = performance.now();
      debugLog("file.processing.started", {
        file_name: file.name,
        relative_path: file.webkitRelativePath || file.name,
        file_index: index,
        file_size: file.size,
        media_type: file.type || "application/octet-stream",
        kind: documentKind(file),
      });
      onProgress({ current: completedFiles, total: files.length, label: `预处理第 ${index + 1} 个文件` });
      const document = await preprocessFile(file, index, getOcrPool, (label) => {
        onProgress({ current: completedFiles, total: files.length, label: `${file.name} · ${label}` });
      }, debugLog);
      completedFiles += 1;
      debugLog("file.processing.completed", {
        file_name: file.name,
        file_index: index,
        kind: document.kind,
        page_count: document.pages.length,
        recognition: document.recognition,
        extracted_characters: document.full_text.length,
        duration_ms: performance.now() - fileStartedAt,
      });
      onProgress({ current: completedFiles, total: files.length, label: `已完成 ${completedFiles}/${files.length} 个文件` });
      return document;
    });
    onProgress({ current: files.length, total: files.length, label: "本地文件预处理完成" });
    debugLog("preprocessing.completed", {
      file_count: files.length,
      direct_text_pages: documents.flatMap((document) => document.pages)
        .filter((page) => page.recognition_method === "pdf_text_layer").length,
      ocr_pages: documents.flatMap((document) => document.pages)
        .filter((page) => page.recognition_method === "ocr").length,
      total_characters: documents.reduce((sum, document) => sum + document.full_text.length, 0),
      duration_ms: performance.now() - preprocessingStartedAt,
    });
    return {
      schema_version: "local-document-context/v1",
      pipeline_version: LOCAL_RECOGNITION_PIPELINE_VERSION,
      created_at: new Date().toISOString(),
      processed_locally: true,
      raw_files_uploaded: false,
      documents,
    };
  } finally {
    if (ocrPool) await ocrPool.terminate();
  }
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
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      if (!isCurrent()) return;
      const page = await pdf.getPage(pageNumber);
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
      pageWrap.setAttribute("aria-label", `PDF 第 ${pageNumber} 页`);
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
