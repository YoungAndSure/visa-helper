/** Shared browser-local OCR worker pool. */

const TESSERACT_URL = "./vendor/tesseract/tesseract.esm.min.js";
const TESSERACT_WORKER_URL = new URL("./vendor/tesseract/worker.min.js", import.meta.url).href;
const TESSERACT_CORE_URL = new URL("./vendor/tesseract/tesseract-core-lstm.wasm.js", import.meta.url).href;
const TESSERACT_LANG_URL = new URL("./vendor/tesseract/lang", import.meta.url).href;

export const DEFAULT_OCR_WORKER_COUNT = 2;

let tesseractPromise;

async function loadTesseract() {
  if (!tesseractPromise) {
    tesseractPromise = import(TESSERACT_URL).then((module) => module.default);
  }
  return tesseractPromise;
}

export function parseOcrTsv(tsv) {
  const rows = String(tsv || "").trim().split(/\r?\n/);
  if (rows.length < 2) return [];
  const headers = rows[0].split("\t");
  return rows.slice(1).map((row) => {
    const values = row.split("\t");
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  }).filter((row) => row.text?.trim() && Number(row.conf) >= 15).map((row) => ({
    text: row.text.trim(),
    line: `${row.page_num}:${row.block_num}:${row.par_num}:${row.line_num}`,
    left: Number(row.left),
    top: Number(row.top),
    width: Number(row.width),
    height: Number(row.height),
    confidence: Number(row.conf),
    source: "ocr",
  }));
}

export function parseOcrBlocks(blocks) {
  const words = [];
  for (const [blockIndex, block] of (blocks || []).entries()) {
    for (const [paragraphIndex, paragraph] of (block.paragraphs || []).entries()) {
      for (const [lineIndex, line] of (paragraph.lines || []).entries()) {
        for (const word of (line.words || [])) {
          const bbox = word.bbox || {};
          const text = String(word.text || "").trim();
          const confidence = Number(word.confidence ?? word.conf ?? 0);
          if (!text || confidence < 15) continue;
          words.push({
            text,
            line: `${blockIndex + 1}:${paragraphIndex + 1}:${lineIndex + 1}`,
            left: Number(bbox.x0 || 0),
            top: Number(bbox.y0 || 0),
            width: Math.max(0, Number(bbox.x1 || 0) - Number(bbox.x0 || 0)),
            height: Math.max(0, Number(bbox.y1 || 0) - Number(bbox.y0 || 0)),
            confidence,
            source: "ocr",
          });
        }
      }
    }
  }
  return words;
}

export async function createOcrPool({
  workerCount = DEFAULT_OCR_WORKER_COUNT,
  onProgress = () => {},
  debugLog = () => {},
} = {}) {
  const poolStartedAt = performance.now();
  const Tesseract = await loadTesseract();
  const count = Math.max(1, Math.floor(workerCount));
  const scheduler = Tesseract.createScheduler();
  const progressBuckets = new Map();
  debugLog("ocr.pool.initializing", { requested_workers: count });
  const created = await Promise.allSettled(Array.from({ length: count }, async (_, workerIndex) => {
    const workerStartedAt = performance.now();
    const workerNumber = workerIndex + 1;
    debugLog("ocr.worker.initializing", { worker: workerNumber });
    try {
      const worker = await Tesseract.createWorker(["chi_sim", "eng"], 1, {
        workerPath: TESSERACT_WORKER_URL,
        corePath: TESSERACT_CORE_URL,
        langPath: TESSERACT_LANG_URL,
        workerBlobURL: false,
        logger(message) {
          if (message.status !== "recognizing text") return;
          const progress = message.progress || 0;
          onProgress({ worker: workerNumber, progress });
          const bucket = Math.min(100, Math.floor(progress * 10) * 10);
          const key = `${workerNumber}:${message.userJobId || "unknown"}`;
          if (progressBuckets.get(key) === bucket) return;
          progressBuckets.set(key, bucket);
          debugLog("ocr.worker.progress", {
            worker: workerNumber,
            worker_id: message.workerId || null,
            job_id: message.userJobId || null,
            progress_percent: bucket,
          });
        },
      });
      debugLog("ocr.worker.ready", {
        worker: workerNumber,
        initialization_ms: performance.now() - workerStartedAt,
      });
      return worker;
    } catch (error) {
      debugLog("ocr.worker.failed", {
        worker: workerNumber,
        initialization_ms: performance.now() - workerStartedAt,
        error,
      }, "error");
      throw error;
    }
  }));
  const workers = created
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  if (!workers.length) {
    const reason = created.find((result) => result.status === "rejected")?.reason;
    throw reason instanceof Error ? reason : new Error(String(reason || "本地 OCR 初始化失败"));
  }
  workers.forEach((worker) => scheduler.addWorker(worker));
  debugLog("ocr.pool.ready", {
    requested_workers: count,
    active_workers: workers.length,
    initialization_ms: performance.now() - poolStartedAt,
  });

  let taskSequence = 0;

  return {
    workerCount: workers.length,
    async recognize(image, metadata = {}) {
      const taskId = `ocr-task-${++taskSequence}`;
      const startedAt = performance.now();
      debugLog("ocr.job.queued", {
        task_id: taskId,
        image_width: image?.width || null,
        image_height: image?.height || null,
        ...metadata,
      });
      try {
        const result = await scheduler.addJob("recognize", image, {}, { text: true, blocks: true });
        const words = parseOcrBlocks(result.data.blocks);
        debugLog("ocr.job.completed", {
          task_id: taskId,
          scheduler_job_id: result.jobId || null,
          duration_ms: performance.now() - startedAt,
          recognized_characters: (result.data.text || "").length,
          recognized_words: words.length,
          output_formats: Object.keys(result.data || {}).filter((key) => result.data[key] != null),
          recognized_blocks: result.data.blocks?.length || 0,
          ...metadata,
        });
        return { text: result.data.text || "", words };
      } catch (error) {
        debugLog("ocr.job.failed", {
          task_id: taskId,
          duration_ms: performance.now() - startedAt,
          error,
          ...metadata,
        }, "error");
        throw error;
      }
    },
    async terminate() {
      const startedAt = performance.now();
      await scheduler.terminate();
      debugLog("ocr.pool.terminated", { duration_ms: performance.now() - startedAt });
    },
  };
}
