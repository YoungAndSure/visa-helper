import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ApplicationStore } from "../src/workflow.js";
import { createVisaServer } from "../src/server.js";
import { replayTaskHistory } from "../src/tasks.js";

const facts = { nationality: "CN", residence: "CN", applicationCity: "北京", destination: "IS", purpose: "tourism",
  arrivalDate: "2027-06-01", departureDate: "2027-06-10", ageGroup: "adult", otherSchengenCountries: "no", occupation: "employed" };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "visa-task-"));
  const store = new ApplicationStore(join(dir, "applications.json"));
  const { application } = await store.advance({ answers: facts });
  const selected = await store.startTask(application.id, "schengen_form");
  let flow = selected.taskFlow;
  return { store, application, get flow() { return flow; },
    async step(event, data) {
      const result = await store.advanceTask({ applicationId: application.id, taskId: "schengen_form", revision: flow.revision, event, data });
      flow = result.taskFlow; return result;
    } };
}
const checked = (flow) => Object.fromEntries(flow.checkCatalog.map((check) => [check.id, true]));

test("self-check completes without uploading or sharing any personal fields, persists, resumes and reopens", async () => {
  const f = await fixture();
  assert.match(f.flow.source.formUrl, /\.pdf$/);
  assert.equal(f.flow.guide.every((field) => field.value === null), true);
  await f.step("GUIDE_READY");
  await f.step("FILLED", { ...f.flow.data, filled: true });
  await f.step("SELF_CHECK");
  await assert.rejects(f.step("FINISH"), { code: "TASK_CONDITIONS_UNMET" });
  await f.step("FINISH", { ...f.flow.data, checks: checked(f.flow), signed: true });
  assert.equal(f.flow.status, "done");
  assert.equal(f.flow.confirmation.method, "user_self_check");
  assert.deepEqual(f.flow.data.fields, {});
  const resumed = await f.store.startTask(f.application.id, "schengen_form");
  assert.equal(resumed.taskFlow.status, "done");
  assert.equal(resumed.taskFlow.revision, f.flow.revision);
  const record = JSON.parse(await readFile(f.store.filePath, "utf8"))[f.application.id];
  assert.equal(record.taskProgress.schengen_form.history.length, 4);
  assert.equal(replayTaskHistory(record.taskProgress.schengen_form).valid, true);
  await f.step("EDIT");
  assert.equal(f.flow.status, "in_progress");
  assert.equal(f.flow.confirmation, null);
  assert.deepEqual(f.flow.data.checks, {});
  assert.equal(f.flow.data.signed, false);
});

test("assisted checks cannot finish with unreadable/missing pages or unresolved findings; upload can be declined", async () => {
  const f = await fixture();
  await f.step("FILLED", { ...f.flow.data, filled: true });
  await f.step("ASSISTED_CHECK");
  await assert.rejects(f.step("REVIEW"), { code: "TASK_CONDITIONS_UNMET" });
  await f.step("REVIEW", { ...f.flow.data, signed: true, review: {
    documentRead: true, pages: [1, 2, 3], checks: checked(f.flow), findings: [{ message: "签字页不清晰", severity: "unreadable" }],
  } });
  await assert.rejects(f.step("FINISH"), { code: "TASK_CONDITIONS_UNMET" });
  await f.step("RETRY");
  assert.equal(f.flow.data.review, null);
  await f.step("REVIEW", { ...f.flow.data, review: { documentRead: true, pages: [1, 2, 3, 4], checks: checked(f.flow), findings: [] } });
  await f.step("FINISH");
  assert.equal(f.flow.confirmation.method, "assistant_reported_review");
  assert.equal(f.flow.confirmation.officialApproval, false);
  await f.step("EDIT"); await f.step("FILLED"); await f.step("ASSISTED_CHECK"); await f.step("SELF_CHECK");
  assert.equal(f.flow.node, "self_check");
});

test("stale revisions, out-of-order events and unsupported fields do not mutate progress", async () => {
  const f = await fixture();
  const old = f.flow.revision;
  await f.step("GUIDE_READY", { ...f.flow.data, fields: { "1": "TEST" } });
  await assert.rejects(f.store.advanceTask({ applicationId: f.application.id, taskId: "schengen_form", revision: old, event: "FILLED" }), { code: "TASK_REVISION_CONFLICT" });
  await assert.rejects(f.step("FINISH"), { code: "TASK_EVENT_INVALID" });
  await assert.rejects(f.step(undefined, { ...f.flow.data, fields: { unknown: "x" } }), { code: "TASK_DATA_INVALID" });
  const resumed = new ApplicationStore(f.store.filePath);
  const result = await resumed.advanceTask({ applicationId: f.application.id, taskId: "schengen_form" });
  assert.equal(result.taskFlow.node, "filling");
  assert.equal(result.taskFlow.data.fields["1"], "TEST");
  assert.equal(result.taskFlow.revision, 1);
});

test("changing interview facts invalidates checks without losing user field notes", async () => {
  const f = await fixture();
  await f.step("GUIDE_READY", { ...f.flow.data, fields: { "1": "TEST" } });
  const result = await f.store.advance({ applicationId: f.application.id, revision: f.application.revision,
    answers: { ...facts, arrivalDate: "2027-07-01", departureDate: "2027-07-10" } });
  const flow = result.application.taskFlow;
  assert.equal(flow.node, "prepare"); assert.equal(flow.needsRecheck, true);
  assert.equal(flow.data.fields["1"], "TEST");
  assert.equal(flow.data.signed, false);
  const record = JSON.parse(await readFile(f.store.filePath, "utf8"))[f.application.id];
  assert.equal(replayTaskHistory(record.taskProgress.schengen_form).valid, true);
});

test("MCP task interface returns catalogs and typed errors through the actual SDK", async () => {
  const f = await fixture();
  const server = createVisaServer(f.store), client = new Client({ name: "task-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st); await client.connect(ct);
    const result = await client.callTool({ name: "advance_task", arguments: { applicationId: f.application.id, taskId: "schengen_form" } });
    assert.equal(result.structuredContent.nextAction.type, "prepare_guide");
    assert.ok(result.structuredContent.taskFlow.fieldCatalog.some((field) => field.id === "33"));
    const bad = await client.callTool({ name: "advance_task", arguments: { applicationId: f.application.id, taskId: "schengen_form", revision: 100, event: "FILLED" } });
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent.error.code, "TASK_REVISION_CONFLICT");
  } finally { await client.close(); await server.close(); }
});
