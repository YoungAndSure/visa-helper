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

export async function createOcrPool({
  workerCount = DEFAULT_OCR_WORKER_COUNT,
  onProgress = () => {},
} = {}) {
  const Tesseract = await loadTesseract();
  const count = Math.max(1, Math.floor(workerCount));
  const scheduler = Tesseract.createScheduler();
  const created = await Promise.allSettled(Array.from({ length: count }, (_, workerIndex) => (
    Tesseract.createWorker(["chi_sim", "eng"], 1, {
      workerPath: TESSERACT_WORKER_URL,
      corePath: TESSERACT_CORE_URL,
      langPath: TESSERACT_LANG_URL,
      workerBlobURL: false,
      logger(message) {
        if (message.status === "recognizing text") {
          onProgress({ worker: workerIndex + 1, progress: message.progress || 0 });
        }
      },
    })
  )));
  const workers = created
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  if (!workers.length) {
    const reason = created.find((result) => result.status === "rejected")?.reason;
    throw reason instanceof Error ? reason : new Error(String(reason || "本地 OCR 初始化失败"));
  }
  workers.forEach((worker) => scheduler.addWorker(worker));

  return {
    workerCount: workers.length,
    async recognize(image) {
      const result = await scheduler.addJob("recognize", image, {}, { text: true, tsv: true });
      return {
        text: result.data.text || "",
        words: parseOcrTsv(result.data.tsv),
      };
    },
    async terminate() {
      await scheduler.terminate();
    },
  };
}
