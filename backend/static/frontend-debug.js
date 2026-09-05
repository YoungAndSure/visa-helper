/** Real-time browser debug events forwarded to the localhost backend log. */

const ENDPOINT = "/debug/frontend-log";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEBUG_ENABLED = LOCAL_HOSTS.has(window.location.hostname)
  || new URLSearchParams(window.location.search).get("debug") === "1";

let sequence = 0;

function normalize(value, seen = new WeakSet()) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack || "" };
  }
  if (typeof value === "bigint") return String(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => normalize(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, seen)]));
}

function emit(payload) {
  if (!DEBUG_ENABLED) return;
  const normalized = normalize(payload);
  const consoleMethod = normalized.level === "error"
    ? "error" : (normalized.level === "warning" ? "warn" : "log");
  console[consoleMethod](
    `[frontend-debug] ${normalized.scope}.${normalized.event}`,
    normalized.details,
  );
  fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(normalized),
    keepalive: true,
  }).catch((error) => {
    console.warn("[frontend-debug] 日志发送失败", error);
  });
}

export function createFrontendDebugRun(scope, initialDetails = {}) {
  const runId = `${scope}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = performance.now();

  function log(event, details = {}, level = "info", message = "") {
    emit({
      sequence: ++sequence,
      client_timestamp: new Date().toISOString(),
      client_epoch_ms: Date.now(),
      client_monotonic_ms: performance.now(),
      run_id: runId,
      scope,
      event,
      level,
      message,
      details: {
        elapsed_ms: Math.round((performance.now() - startedAt) * 1000) / 1000,
        ...details,
      },
    });
  }

  log("run.started", initialDetails);
  return {
    id: runId,
    log,
    finish(details = {}) {
      log("run.completed", details);
    },
    fail(error, details = {}) {
      log("run.failed", { ...details, error }, "error", error instanceof Error ? error.message : String(error));
    },
  };
}

export function frontendDebugEnabled() {
  return DEBUG_ENABLED;
}
