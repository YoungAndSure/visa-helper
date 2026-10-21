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

test("pause and switch retain partial checks, fields and replayable history after reopening the store", async () => {
  const f = await fixture();
  await f.step("GUIDE_READY", { ...f.flow.data, fields: { "1": "TEST" } });
  await f.step("FILLED", { ...f.flow.data, filled: true }); await f.step("SELF_CHECK");
  const checkId = f.flow.checkCatalog[0].id;
  await f.step(undefined, { ...f.flow.data, checks: { [checkId]: true } });
  const revision = f.flow.revision;
  const paused = await f.store.startTask(f.application.id, "schengen_form", "pause");
  assert.equal(paused.activeTask, null); assert.equal(paused.taskFlow, null);
  assert.equal(paused.tasks.find(({ id }) => id === "schengen_form").status, "paused");
  const reopened = new ApplicationStore(f.store.filePath);
  await reopened.startTask(f.application.id, "photo");
  const resumed = await reopened.startTask(f.application.id, "schengen_form");
  assert.equal(resumed.taskFlow.node, "self_check"); assert.equal(resumed.taskFlow.revision, revision);
  assert.equal(resumed.taskFlow.data.fields["1"], "TEST"); assert.equal(resumed.taskFlow.data.checks[checkId], true);
  assert.equal(resumed.tasks.find(({ id }) => id === "photo").status, "paused");
  const record = (await reopened.readAll())[f.application.id];
  assert.equal(replayTaskHistory(record.taskProgress.schengen_form).valid, true);
  assert.equal(replayTaskHistory(record.taskProgress.photo).valid, true);
});

test("form self-check questions appear only after filling and choosing private checks; completion returns the full queue", async () => {
  const f = await fixture();
  assert.deepEqual(f.flow.nextAction.questions, []);
  await f.step("GUIDE_READY"); assert.deepEqual(f.flow.nextAction.questions, []);
  await f.step("FILLED", { ...f.flow.data, filled: true }); assert.deepEqual(f.flow.nextAction.questions, []);
  await f.step("ASSISTED_CHECK"); assert.deepEqual(f.flow.nextAction.questions, []);
  await f.step("SELF_CHECK"); assert.equal(f.flow.nextAction.questions.length, f.flow.checkCatalog.length);
  const first = f.flow.checkCatalog[0].id;
  await f.step(undefined, { ...f.flow.data, checks: { [first]: true } });
  assert.ok(!f.flow.nextAction.questions.some(({ id }) => id === first));
  assert.equal(f.flow.nextAction.questions.length, f.flow.checkCatalog.length - 1);
  const completed = await f.step("FINISH", { ...f.flow.data, checks: checked(f.flow), signed: true });
  assert.equal(completed.application.activeTask, null); assert.equal(completed.application.taskFlow, null);
  assert.equal(completed.taskFlow.status, "done");
  assert.equal((await new ApplicationStore(f.store.filePath).get(f.application.id)).tasks.find(({ id }) => id === "schengen_form").status, "done");
  const viewed = await f.store.startTask(f.application.id, "schengen_form");
  assert.equal(viewed.taskFlow.node, "done", "Completed material can still be explicitly viewed");
  // Older releases left the finished material selected in the saved record.
  const restored = await new ApplicationStore(f.store.filePath).get(f.application.id);
  assert.equal(restored.activeTask, null, "Restoring a finished selection must show the full queue");
  assert.equal(restored.taskFlow, null);
});

test("self-check completes without uploading or sharing any personal fields, persists, resumes and reopens", async () => {
  const f = await fixture();
  assert.match(f.flow.source.formUrl, /\.pdf$/);
  assert.equal(f.flow.guide.find((field) => field.id === "1").value, null);
  assert.equal(f.flow.guide.find((field) => field.id === "23").value, "Tourism");
  assert.equal(f.flow.guide.find((field) => field.id === "27.arrival").value, "01-06-2027");
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

test("form guide uses confirmed application facts and saved fields without guessing missing facts", async () => {
  const f = await fixture();
  const guide = () => Object.fromEntries(f.flow.guide.map((field) => [field.id, field]));
  assert.equal(guide()["20"].value, "No");
  assert.equal(guide()["25"].value, "Iceland");
  assert.equal(guide()["26"].value, null); // Flight route, not destination alone, determines first entry.
  assert.equal(guide()["27.entries"].value, null);
  assert.equal(guide()["1"].guidance.length > 0, true);
  assert.equal(guide()["27.arrival"].reference, "第 2 页 · 第 27 项");
  assert.equal(guide()["27.arrival"].valueStatus, "from_application");
  await f.step(undefined, { ...f.flow.data, fields: { "1": "TEST", "25": "Iceland (confirmed itinerary)" } });
  assert.equal(guide()["1"].value, "TEST");
  assert.equal(guide()["25"].value, "Iceland (confirmed itinerary)");
  assert.deepEqual(f.flow.data.fields, { "1": "TEST", "25": "Iceland (confirmed itinerary)" });
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
    assert.equal(result.structuredContent.nextAction.type, "prepare_form");
    assert.ok(result.structuredContent.taskFlow.fieldCatalog.some((field) => field.id === "33"));
    assert.equal(result.structuredContent.handoff.applicationId, f.application.id);
    assert.equal(result.structuredContent.handoff.taskId, "schengen_form");
    assert.equal(result.structuredContent.handoff.workspace, "task");
    assert.equal(result.structuredContent.handoff.answers, undefined);
    assert.equal(result.structuredContent.handoff.data, undefined);
    const bad = await client.callTool({ name: "advance_task", arguments: { applicationId: f.application.id, taskId: "schengen_form", revision: 100, event: "FILLED" } });
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent.error.code, "TASK_REVISION_CONFLICT");
    const pause = await client.callTool({ name: "start_task", arguments: { applicationId: f.application.id, taskId: "schengen_form", action: "pause" } });
    assert.equal(pause.structuredContent.handoff.workspace, "checklist");
    assert.equal(pause.structuredContent.nextAction.presentation.tool, "get_task_queue");
    const resumed = await client.callTool({ name: "start_task", arguments: { applicationId: f.application.id, taskId: "schengen_form" } });
    assert.equal(resumed.structuredContent.handoff.workspace, "task");
    assert.equal(resumed.structuredContent.nextAction.presentation.tool, "get_task_queue");
    assert.equal(resumed.structuredContent.taskFlow.progress.currentStage, "prepare");
    const display = resumed.structuredContent.nextAction.presentation;
    const displayed = await client.callTool({ name: display.tool, arguments: display.arguments });
    assert.equal(displayed.structuredContent.application.activeTask.id, "schengen_form");
    assert.equal(displayed.structuredContent.taskFlow.progress.currentStage, "prepare");
    assert.equal(displayed.structuredContent.nextAction.type, "prepare_guide", "Rendering the selected task must not tell GPT to choose a different task");
    await f.step("FILLED", { ...f.flow.data, filled: true }); await f.step("SELF_CHECK");
    const done = await client.callTool({ name: "advance_task", arguments: { applicationId: f.application.id, taskId: "schengen_form",
      revision: f.flow.revision, event: "FINISH", data: { ...f.flow.data, checks: checked(f.flow), signed: true } } });
    assert.equal(done.isError, undefined);
    assert.equal(done.structuredContent.nextAction.type, "choose_task");
    assert.equal(done.structuredContent.nextAction.presentation.tool, "get_task_queue");
    assert.equal(done.structuredContent.handoff.workspace, "checklist");
    assert.equal(done.structuredContent.handoff.nextAction.completedTaskId, "schengen_form");
    assert.ok(done.structuredContent.handoff.tasks.some(({ id, status }) => id === "schengen_form" && status === "done"));
  } finally { await client.close(); await server.close(); }
});
