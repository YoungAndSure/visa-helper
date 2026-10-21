import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getTaskDefinition, taskDefinitions } from "../src/task-definitions.js";
import { newTaskProgress, taskState, advanceTask, replayTaskHistory, invalidateTask } from "../src/tasks.js";
import { ApplicationStore } from "../src/workflow.js";
import { GuideLinks, createGuideHandler, renderGuideHtml } from "../src/form-guide.js";
import { createVisaServer } from "../src/server.js";

const facts = { nationality: "CN", residence: "CN", applicationCity: "北京", destination: "IS", purpose: "tourism",
  arrivalDate: "2027-06-01", departureDate: "2027-06-03", ageGroup: "adult", otherSchengenCountries: "no", occupation: "employed" };
const materials = taskDefinitions().filter(({ policy }) => policy === "material");
const checks = (definition, predicate = () => true) => Object.fromEntries(definition.checks.filter(predicate).map(({ id }) => [id, true]));
function fixture(id) {
  let progress = newTaskProgress(id);
  return { get progress() { return progress; }, get flow() { return taskState(id, progress, facts); }, step(event, data) {
    progress = advanceTask(progress, { revision: progress.revision, event, data }, facts); return progress;
  } };
}

test("all 25 Iceland task IDs resolve; collect tasks share one profile and drafting is explicit", async () => {
  const pack = JSON.parse(await readFile(new URL("../config/rules/iceland-tourism-user-checklist-2025-03-06-xstate-1.json", import.meta.url), "utf8"));
  assert.deepEqual(taskDefinitions().map(({ id }) => id).sort(), pack.tasks.map(({ id }) => id).sort());
  assert.equal(materials.length, 23);
  assert.equal(getTaskDefinition("photo").machine.states, getTaskDefinition("bank_statements").machine.states);
  assert.equal(getTaskDefinition("employment_letter").machine.states, getTaskDefinition("daily_itinerary").machine.states);
  assert.notEqual(getTaskDefinition("photo").modelHash, getTaskDefinition("bank_statements").modelHash);
  assert.throws(() => newTaskProgress("unknown"), { code: "TASK_NOT_IMPLEMENTED" });
});

test("task progress covers every saved node, groups review alternatives, and resets after edits", () => {
  const expected = { prepare: "prepare", acquiring: "prepare", filling: "fill", review_choice: "check",
    self_check: "check", await_upload: "check", assisted_check: "check", done: null };
  for (const definition of taskDefinitions()) {
    const stages = definition.workflow === "collect-v1" ? ["prepare", "check"] : ["prepare", "fill", "check"];
    for (const node of Object.keys(definition.machine.states)) {
      assert.ok(Object.hasOwn(expected, node), `Specify progress for new node ${definition.id}/${node}`);
      const saved = { ...newTaskProgress(definition.id), node, status: node === "done" ? "done" : "in_progress" };
      const { progress } = taskState(definition.id, saved, facts);
      assert.deepEqual(progress.stages.map(({ id }) => id), stages);
      assert.equal(progress.currentStage, expected[node], `${definition.id}/${node}`);
      assert.equal(progress.completedStages, node === "done" ? stages.length : stages.indexOf(expected[node]));
      assert.equal(progress.totalStages, stages.length);
      assert.equal(progress.complete, node === "done");
    }
  }
  const f = fixture("daily_itinerary");
  f.step("GUIDE_READY"); assert.equal(f.flow.progress.currentStage, "fill");
  f.step("FILLED"); f.step("ASSISTED_CHECK");
  const before = f.flow.progress;
  f.step("SELF_CHECK"); assert.deepEqual(f.flow.progress, before, "Switching review method does not invent extra progress");
  f.step("FINISH", { ...f.flow.data, checks: checks(getTaskDefinition("daily_itinerary")), prepared: true });
  assert.equal(f.flow.progress.complete, true);
  f.step("EDIT"); assert.equal(f.flow.progress.completedStages, 0);
});

test("every configured material completes privately without storing a document; every history replays", () => {
  for (const definition of materials) {
    const f = fixture(definition.id);
    if (!f.flow.nextAction.events.includes("SELF_CHECK")) f.step("FILLED");
    f.step("SELF_CHECK");
    assert.throws(() => f.step("FINISH"), { code: "TASK_CONDITIONS_UNMET" });
    f.step("FINISH", { ...f.flow.data, checks: checks(definition), prepared: true });
    assert.equal(f.flow.status, "done", definition.id);
    assert.deepEqual(f.flow.data.fields, {}); assert.equal(f.flow.data.review, null);
    assert.equal(f.flow.confirmation.method, "user_self_check");
    assert.equal(replayTaskHistory(f.progress).valid, true);
    f.step("EDIT"); assert.equal(f.flow.node, "prepare"); assert.equal(f.flow.confirmation, null);
  }
});

test("every material assisted path requires report, coverage, issuer/user checks and explicit final confirmation", () => {
  for (const definition of materials) {
    const f = fixture(definition.id);
    if (!f.flow.nextAction.events.includes("ASSISTED_CHECK")) f.step("FILLED");
    f.step("ASSISTED_CHECK");
    assert.throws(() => f.step("REVIEW"), { code: "TASK_CONDITIONS_UNMET" });
    f.step("REVIEW", { ...f.flow.data, review: { documentRead: true, coverage: definition.requiredCoverage.map(({ id }) => id),
      checks: checks(definition, ({ evidence }) => evidence !== "user"), findings: [] } });
    assert.throws(() => f.step("FINISH"), { code: "TASK_CONDITIONS_UNMET" });
    f.step("FINISH", { ...f.flow.data, checks: checks(definition, ({ evidence }) => evidence === "user"), confirmedDetails: true, prepared: true });
    assert.equal(f.flow.confirmation.method, "assistant_reported_review", definition.id);
    assert.equal(replayTaskHistory(f.progress).valid, true);
  }
});

test("coverage, unreadable observations and user-only checks cannot be replaced by model assertions", () => {
  const f = fixture("chinese_id_copy"); f.step("ASSISTED_CHECK");
  f.step("REVIEW", { ...f.flow.data, review: { documentRead: true, coverage: ["front"], checks: checks(getTaskDefinition("chinese_id_copy")), findings: [] } });
  const confirmations = () => ({ ...f.flow.data, prepared: true, confirmedDetails: true, checks: { original: true } });
  assert.throws(() => f.step("FINISH", confirmations()), { code: "TASK_CONDITIONS_UNMET" });
  f.step("RETRY"); assert.equal(f.flow.data.prepared, false); assert.equal(f.flow.data.confirmedDetails, false);
  f.step("REVIEW", { ...f.flow.data, review: { documentRead: true, coverage: ["front", "back"], checks: checks(getTaskDefinition("chinese_id_copy")),
    findings: [{ severity: "unreadable", message: "反面未读清" }] } });
  assert.throws(() => f.step("FINISH", confirmations()), { code: "TASK_CONDITIONS_UNMET" });
  f.step("SELF_CHECK"); f.step("FINISH", { ...f.flow.data, prepared: true, checks: checks(getTaskDefinition("chinese_id_copy")) });
  assert.equal(f.flow.confirmation.method, "user_self_check");
});

test("insurance deterministic checks reject invalid dates, insufficient amounts and checkbox overrides", () => {
  const f = fixture("travel_insurance");
  f.step(undefined, { ...f.flow.data, fields: { startDate: "2027-06-02", endDate: "2027-06-03", amount: "29999", currency: "EUR" } });
  assert.equal(f.flow.automaticChecks.filter(({ status }) => status === "fail").length, 2);
  f.step("SELF_CHECK");
  assert.throws(() => f.step("FINISH", { ...f.flow.data, checks: checks(getTaskDefinition("travel_insurance")), prepared: true }), { code: "TASK_CONDITIONS_UNMET" });
  f.step("EDIT");
  assert.throws(() => f.step(undefined, { ...f.flow.data, fields: { startDate: "2027-02-30" } }), { code: "TASK_DATA_INVALID" });
  assert.throws(() => f.step(undefined, { ...f.flow.data, fields: { amount: "NaN" } }), { code: "TASK_DATA_INVALID" });
  f.step(undefined, { ...f.flow.data, fields: { startDate: "2027-06-01", endDate: "2027-06-03", amount: "30000", currency: "EUR" } });
  assert.ok(f.flow.automaticChecks.every(({ status }) => status === "pass"));
  f.step("SELF_CHECK"); f.step("FINISH", { ...f.flow.data, checks: checks(getTaskDefinition("travel_insurance")), prepared: true });
  assert.equal(replayTaskHistory(f.progress).valid, true);
  const invalidated = invalidateTask(f.progress);
  assert.equal(invalidated.node, "prepare"); assert.equal(invalidated.data.prepared, false); assert.equal(invalidated.needsRecheck, true);
  assert.equal(replayTaskHistory(invalidated).valid, true);
});

test("letter drafts do not infer employer or school approval from travel dates", () => {
  for (const id of ["employment_letter", "school_letter"]) {
    const f = fixture(id);
    assert.equal(f.flow.guide.find(({ id }) => id === "leaveDates").value, null);
  }
});

test("itinerary draft shows known travel dates without fabricating plans; day coverage and safe rendering are checked", () => {
  const f = fixture("daily_itinerary");
  const blank = renderGuideHtml(f.flow);
  assert.match(blank, /2027-06-01/); assert.match(blank, /2027-06-03/); assert.match(blank, /待补充/);
  for (const definition of taskDefinitions().filter(({ document }) => document)) {
    assert.doesNotMatch(renderGuideHtml(fixture(definition.id).flow), /完成前检查|填好后的自查|□/);
  }
  f.step("GUIDE_READY", { ...f.flow.data, fields: { applicantName: "<img src=x onerror=alert(1)>" }, rows: [{ date: "2027-06-01", location: "Reykjavik", plan: "Confirmed plan" }] });
  assert.equal(f.flow.automaticChecks[0].status, "fail");
  const html = renderGuideHtml(f.flow); assert.doesNotMatch(html, /<img|<script/); assert.match(html, /&lt;img/);
  f.step("EDIT");
  f.step(undefined, { ...f.flow.data, rows: ["01", "02", "03"].map((day) => ({ date: `2027-06-${day}`, location: "Reykjavik", plan: "User-confirmed plan" })) });
  assert.equal(f.flow.automaticChecks[0].status, "pass");
  f.step("FILLED"); f.step("SELF_CHECK");
  f.step("FINISH", { ...f.flow.data, checks: checks(getTaskDefinition("daily_itinerary")), prepared: true });
  assert.equal(f.flow.node, "done");
});

test("external acquisition is a persisted waiting step and does not complete or generate official documents", () => {
  const f = fixture("marriage_certificate"); f.step("ACQUIRE");
  assert.equal(f.flow.nextAction.type, "acquire_material"); assert.equal(f.flow.status, "in_progress");
  assert.throws(() => f.step("FINISH"), { code: "TASK_EVENT_INVALID" });
  assert.ok(f.flow.acquisition.length); assert.equal(f.flow.guide, undefined);
  assert.equal(replayTaskHistory(f.progress).valid, true);
  f.step("READY"); assert.equal(f.flow.node, "prepare"); assert.equal(f.flow.confirmation, null);
});

test("shared workflow instances remain isolated by task ID, save/resume independently and reject stale writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visa-material-")), store = new ApplicationStore(join(dir, "applications.json"));
  const { application } = await store.advance({ answers: facts });
  const id = application.id;
  let first = (await store.startTask(id, "chinese_id_copy")).taskFlow;
  first = (await store.advanceTask({ applicationId: id, taskId: first.taskId, revision: first.revision, event: "SELF_CHECK" })).taskFlow;
  const second = (await store.startTask(id, "hukou_copy")).taskFlow;
  assert.equal(second.node, "prepare"); assert.equal(second.revision, 0);
  await store.advanceTask({ applicationId: id, taskId: first.taskId, revision: first.revision, event: "FINISH", data: { ...first.data, checks: checks(getTaskDefinition(first.taskId)), prepared: true } });
  assert.equal((await store.startTask(id, "chinese_id_copy")).taskFlow.node, "done");
  assert.equal((await new ApplicationStore(store.filePath).startTask(id, "hukou_copy")).taskFlow.node, "prepare");
  await assert.rejects(store.advanceTask({ applicationId: id, taskId: first.taskId, revision: first.revision, event: "EDIT" }), { code: "TASK_REVISION_CONFLICT" });
  const third = fixture("photo");
  assert.throws(() => third.step(undefined, { ...third.flow.data, fields: { issueDate: "2020-01-01" } }), { code: "TASK_DATA_INVALID" });
  await assert.rejects(store.startTask(id, "school_letter"), { code: "TASK_NOT_FOUND" });
});

test("actual MCP exposes material schemas, dynamic draft URL, safe HTML and untouched form/passport progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visa-material-mcp-")), store = new ApplicationStore(join(dir, "applications.json"));
  const { application } = await store.advance({ answers: facts });
  const form = await store.startTask(application.id, "schengen_form");
  const passport = await store.startTask(application.id, "passport");
  const links = new GuideLinks({ baseUrl: "http://127.0.0.1:18080" });
  const server = createVisaServer(store, links), client = new Client({ name: "material-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st); await client.connect(ct);
    const call = (name, args) => client.callTool({ name, arguments: { applicationId: application.id, ...args } });
    const selected = await call("start_task", { taskId: "daily_itinerary" });
    assert.equal(selected.structuredContent.nextAction.type, "open_url");
    const read = await call("advance_task", { taskId: "daily_itinerary", revision: 0, event: "GUIDE_READY", data: {
      rows: [{ date: "2027-06-01", location: "Reykjavik", plan: "Known plan" }] } });
    assert.equal(read.isError, undefined); assert.match(read._meta.guideDocument, /Known plan/);
    const handler = createGuideHandler(store, links); let status;
    await handler({ method: "GET", url: new URL(read.structuredContent.nextAction.url).pathname }, {
      setHeader() {}, writeHead(value) { status = value; return this; }, end(body) { assert.match(body, /Known plan/); } });
    assert.equal(status, 200);
    assert.equal((await store.startTask(application.id, "schengen_form")).taskFlow.modelHash, form.taskFlow.modelHash);
    assert.equal((await store.startTask(application.id, "passport")).taskFlow.revision, passport.taskFlow.revision);
  } finally { await client.close(); await server.close(); }
});
