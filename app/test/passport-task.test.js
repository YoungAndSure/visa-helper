import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ApplicationStore } from "../src/workflow.js";
import { createVisaServer } from "../src/server.js";
import { GuideLinks } from "../src/form-guide.js";
import { passportDateChecks } from "../src/task-policies.js";
import { replayTaskHistory, taskRelease } from "../src/tasks.js";

const answers = { nationality: "CN", residence: "CN", applicationCity: "北京", destination: "IS", purpose: "tourism",
  arrivalDate: "2027-06-01", departureDate: "2027-06-10", ageGroup: "adult", otherSchengenCountries: "no", occupation: "employed" };
const dates = { issueDate: "2020-06-01", expiryDate: "2030-06-01" };
const passed = { issued_within_ten_years: true, validity: true, blank_pages: true };
const review = () => ({ documentRead: true, checks: { issued_within_ten_years: true, validity: true }, findings: [] });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "visa-passport-"));
  const store = new ApplicationStore(join(dir, "applications.json"));
  const { application } = await store.advance({ answers });
  let flow = (await store.startTask(application.id, "passport")).taskFlow;
  return { store, application, get flow() { return flow; }, async step(event, data) {
    const result = await store.advanceTask({ applicationId: application.id, taskId: "passport", revision: flow.revision, event, data });
    flow = result.taskFlow; return flow;
  } };
}

test("passport private self-check needs every explicit confirmation, no dates or upload, and resumes as one completed task", async () => {
  const f = await fixture();
  assert.equal(f.flow.node, "prepare"); assert.equal(f.flow.nextAction.questions.length, 3);
  await f.step("SELF_CHECK");
  await assert.rejects(f.step("FINISH"), { code: "TASK_CONDITIONS_UNMET" });
  await f.step(undefined, { ...f.flow.data, checks: passed });
  const resumed = new ApplicationStore(f.store.filePath);
  assert.deepEqual((await resumed.advanceTask({ applicationId: f.application.id, taskId: "passport" })).taskFlow.data.checks, passed);
  await assert.rejects(f.step("FINISH"), { code: "TASK_CONDITIONS_UNMET" });
  await f.step("FINISH", { ...f.flow.data, prepared: true });
  assert.deepEqual(f.flow.data.fields, {}); assert.equal(f.flow.data.review, null);
  assert.equal(f.flow.confirmation.method, "user_self_check");
  assert.equal((await f.store.startTask(f.application.id, "passport")).taskFlow.node, "done");
  const state = await f.store.get(f.application.id);
  assert.equal(state.tasks.filter(({ id }) => id === "passport").length, 1);
  assert.equal(state.tasks.find(({ id }) => id === "passport").status, "done");
  assert.equal(replayTaskHistory((await f.store.readAll())[f.application.id].taskProgress.passport).valid, true);
});

test("assisted passport review requires actual read report, known valid dates, user-confirmed extraction, blank pages and readiness", async () => {
  const f = await fixture(); await f.step("ASSISTED_CHECK");
  await assert.rejects(f.step("REVIEW"), { code: "TASK_CONDITIONS_UNMET" });
  await f.step("REVIEW", { ...f.flow.data, fields: dates, review: review() });
  await assert.rejects(f.step("FINISH", { ...f.flow.data, prepared: true }), { code: "TASK_CONDITIONS_UNMET" });
  await assert.rejects(f.step("FINISH", { ...f.flow.data, prepared: true, confirmedDetails: true }), { code: "TASK_CONDITIONS_UNMET" });
  await f.step("FINISH", { ...f.flow.data, prepared: true, confirmedDetails: true, checks: { blank_pages: true } });
  assert.equal(f.flow.confirmation.method, "assistant_reported_review");
  assert.equal(f.flow.confirmation.officialApproval, false);
  assert.equal(replayTaskHistory((await f.store.readAll())[f.application.id].taskProgress.passport).valid, true);
  await f.step("EDIT");
  assert.equal(f.flow.node, "prepare"); assert.equal(f.flow.data.review, null); assert.equal(f.flow.confirmation, null);
  assert.equal(f.flow.data.confirmedDetails, false); assert.deepEqual(f.flow.data.checks, {});
});

test("unreadable/missing dates and outstanding findings cannot be marked done; retry clears prior consent and self-check remains available", async () => {
  const f = await fixture(); await f.step("ASSISTED_CHECK");
  await f.step("REVIEW", { ...f.flow.data, review: { ...review(), findings: [{ severity: "unreadable", message: "日期反光未读清" }] } });
  await assert.rejects(f.step("FINISH", { ...f.flow.data, prepared: true, confirmedDetails: true, checks: passed }), { code: "TASK_CONDITIONS_UNMET" });
  await f.step("RETRY"); assert.equal(f.flow.data.review, null); assert.equal(f.flow.data.prepared, false);
  await f.step("REVIEW", { ...f.flow.data, review: review() });
  await assert.rejects(f.step("FINISH", { ...f.flow.data, prepared: true, confirmedDetails: true, checks: passed }), { code: "TASK_CONDITIONS_UNMET" });
  await f.step("SELF_CHECK");
  await f.step("FINISH", { ...f.flow.data, checks: passed, prepared: true });
  assert.equal(f.flow.confirmation.method, "user_self_check");
});

test("calendar-month and ten-year boundaries are deterministic and failing dates cannot be overridden by checkboxes", async () => {
  const computed = passportDateChecks({ issueDate: "2020-02-29", expiryDate: "2027-04-30" }, { arrivalDate: "2027-01-01", departureDate: "2027-01-31" });
  assert.equal(computed[0].limitDate, "2030-02-28");
  assert.equal(computed[1].limitDate, "2027-04-30"); assert.equal(computed[1].status, "pass");
  assert.equal(passportDateChecks({ expiryDate: "2027-04-29" }, { departureDate: "2027-01-31" })[1].status, "fail");
  const f = await fixture();
  await f.step(undefined, { ...f.flow.data, fields: { issueDate: "2010-01-01", expiryDate: "2027-08-01" } });
  await f.step("SELF_CHECK");
  await assert.rejects(f.step("FINISH", { ...f.flow.data, checks: passed, prepared: true }), { code: "TASK_CONDITIONS_UNMET" });
  await f.step("EDIT");
  await assert.rejects(f.step(undefined, { ...f.flow.data, fields: { issueDate: "2027-02-30" } }), { code: "TASK_DATA_INVALID" });
});

test("revision conflicts, unknown personal fields and edits after checks are rejected without saving", async () => {
  const f = await fixture(); await f.step("SELF_CHECK"); const revision = f.flow.revision;
  await assert.rejects(f.store.advanceTask({ applicationId: f.application.id, taskId: "passport", revision: 0, event: "FINISH" }), { code: "TASK_REVISION_CONFLICT" });
  await assert.rejects(f.step(undefined, { ...f.flow.data, fields: { passportNumber: "NOT-ACCEPTED" } }), { code: "TASK_DATA_INVALID" });
  await assert.rejects(f.step(undefined, { ...f.flow.data, checks: { invented: true } }), { code: "TASK_DATA_INVALID" });
  await assert.rejects(f.step(undefined, { ...f.flow.data, fields: dates }), { code: "TASK_REOPEN_REQUIRED" });
  assert.equal((await f.store.startTask(f.application.id, "passport")).taskFlow.revision, revision);
});

test("interview changes invalidate passport checks, preserve form version and replay both task histories", async () => {
  const f = await fixture();
  await f.step("SELF_CHECK"); await f.step("FINISH", { ...f.flow.data, checks: passed, prepared: true });
  const form = (await f.store.startTask(f.application.id, "schengen_form")).taskFlow;
  assert.equal(form.modelHash, "d7dea15494e9cdb3d10ce85c8e81e7adb8f70db4ebeec0e3a1cb79c419333dbd");
  assert.equal(taskRelease.tasks.length, 25);
  await f.store.advance({ applicationId: f.application.id, revision: f.application.revision, answers: { ...answers, departureDate: "2027-07-01" } });
  const record = (await f.store.readAll())[f.application.id];
  const passport = record.taskProgress.passport;
  assert.equal(passport.node, "prepare"); assert.equal(passport.confirmation, null); assert.equal(passport.data.prepared, false);
  assert.equal(passport.needsRecheck, true);
  for (const progress of Object.values(record.taskProgress)) assert.equal(replayTaskHistory(progress).valid, true);
});

test("actual MCP accepts passport snapshots and returns task-specific actions without PDF guide links", async () => {
  const f = await fixture();
  const links = new GuideLinks({ baseUrl: "http://127.0.0.1:18080" });
  const server = createVisaServer(f.store, links), client = new Client({ name: "passport-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st); await client.connect(ct);
    const call = (args) => client.callTool({ name: "advance_task", arguments: { applicationId: f.application.id, taskId: "passport", ...args } });
    const read = await call({}); assert.equal(read.structuredContent.nextAction.type, "choose_review");
    assert.equal(read.structuredContent.guidePresentation, undefined); assert.equal(read._meta.guideDocument, undefined);
    const saved = await call({ revision: 0, data: { fields: {}, checks: {} } });
    assert.equal(saved.isError, undefined);
    assert.equal(saved.structuredContent.taskFlow.data.prepared, false);
    assert.equal(saved.structuredContent.taskFlow.data.filled, undefined);
    const entered = await call({ revision: 1, event: "SELF_CHECK" });
    const done = await call({ revision: 2, event: "FINISH", data: { ...entered.structuredContent.taskFlow.data, checks: passed, prepared: true } });
    assert.equal(done.isError, undefined); assert.equal(done.structuredContent.taskFlow.node, "done");
    const selected = await client.callTool({ name: "start_task", arguments: { applicationId: f.application.id, taskId: "schengen_form" } });
    assert.equal(selected.structuredContent.nextAction.type, "open_url");
  } finally { await client.close(); await server.close(); }
});
