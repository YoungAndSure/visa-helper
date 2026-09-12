import assert from "node:assert/strict";
import test from "node:test";
import { fetchChecklist } from "../../static/checklist-loader.js";

test("transient failures retry and return the successful checklist", async () => {
  let calls = 0;
  const attempts = [];
  const result = await fetchChecklist("IS", {
    delays: [0, 0],
    onAttempt: (attempt) => attempts.push(attempt),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch");
      if (calls === 2) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ items: [{ id: 1 }] }) };
    },
  });
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal(result.items[0].id, 1);
});

test("permanent failures stop after three attempts", async () => {
  let calls = 0;
  await assert.rejects(fetchChecklist("IS", {
    delays: [0, 0], fetchImpl: async () => { calls++; throw new Error("offline"); },
  }), /offline/);
  assert.equal(calls, 3);
});

test("timeouts retry; cancelling a country request stops retries", async () => {
  let calls = 0;
  const hangingFetch = async (_url, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  };
  await assert.rejects(fetchChecklist("IS", { delays: [0, 0], timeoutMs: 5, fetchImpl: hangingFetch }));
  assert.equal(calls, 3);
  const controller = new AbortController();
  const pending = fetchChecklist("NO", { signal: controller.signal, fetchImpl: hangingFetch });
  controller.abort();
  await assert.rejects(pending);
  assert.equal(calls, 4);
});
