/**
 * Browser-local document preprocessing.
 *
 * This module knows how to read files, but knows nothing about visa rules. Its
 * only output is a normalized document context consumed by downstream rules.
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

async function extractPdf(file) {
  const pdfjs = await loadPdfJs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  const pages = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = [];
      let currentLine = [];
      let previousY = null;

      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y = item.transform?.[5] ?? null;
        if (previousY !== null && y !== null && Math.abs(y - previousY) > 3 && currentLine.length) {
          lines.push(currentLine.join(" "));
          currentLine = [];
        }
        currentLine.push(item.str);
        previousY = y;
      }
      if (currentLine.length) lines.push(currentLine.join(" "));
      const text = lines.join("\n");
      pages.push({
        page_number: pageNumber,
        blocks: text ? [{ type: "text", text, source: "pdf_text_layer" }] : [],
        text,
      });
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
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

async function preprocessFile(file, index) {
  const base = documentBase(file, index);
  try {
    if (base.kind === "pdf") {
      const pages = await extractPdf(file);
      const fullText = pages
        .map((page) => `[PAGE ${page.page_number}]\n${page.text}`)
        .join("\n\n");
      const hasText = Boolean(fullText.replace(/\[PAGE \d+\]/g, "").trim());
      return {
        ...base,
        full_text: fullText,
        pages,
        recognition: {
          status: hasText ? "success" : "partial",
          text_source: hasText ? "pdf_text_layer" : "none",
          ocr_status: hasText ? "not_required" : "unavailable",
          error: null,
        },
      };
    }

    if (base.kind === "text") {
      const text = await file.text();
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
      const dimensions = await imageDimensions(file);
      const image = {
        image_id: `${base.document_id}-image-001`,
        media_type: base.media_type,
        width: dimensions.width,
        height: dimensions.height,
        description: "",
        ocr_text: "",
      };
      return {
        ...base,
        pages: [{ page_number: 1, blocks: [{ type: "image", image_id: image.image_id }], text: "" }],
        images: [image],
        recognition: {
          status: "partial",
          text_source: "none",
          ocr_status: "unavailable",
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

export async function preprocessFilesLocally(files, { onProgress = () => {} } = {}) {
  const documents = [];
  for (let index = 0; index < files.length; index += 1) {
    onProgress({ current: index, total: files.length, label: `预处理第 ${index + 1} 个文件` });
    documents.push(await preprocessFile(files[index], index));
  }
  onProgress({ current: files.length, total: files.length, label: "本地文件预处理完成" });
  return {
    schema_version: "local-document-context/v1",
    created_at: new Date().toISOString(),
    processed_locally: true,
    raw_files_uploaded: false,
    documents,
  };
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
