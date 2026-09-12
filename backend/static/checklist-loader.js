/** Bounded retries; callers cancel outdated country requests with a signal. */
export async function fetchChecklist(country, {
  signal,
  onAttempt = () => {},
  fetchImpl = fetch,
  delays = [1000, 2000],
  timeoutMs = 8000,
} = {}) {
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    signal?.throwIfAborted();
    onAttempt(attempt + 1, delays.length + 1);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetchImpl(`/material-audit/checklist?country=${encodeURIComponent(country)}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.items)) throw new Error("清单数据格式不正确");
      signal?.throwIfAborted();
      return data;
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt === delays.length) throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    await new Promise((resolve, reject) => {
      const cancel = () => {
        clearTimeout(delayTimer);
        reject(signal.reason);
      };
      const delayTimer = setTimeout(() => {
        signal?.removeEventListener("abort", cancel);
        resolve();
      }, delays[attempt]);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }
}
