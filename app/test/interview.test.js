import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVisaServer } from "../src/server.js";
import { ApplicationStore } from "../src/workflow.js";
import { advanceOutputSchema } from "../src/interview.js";
import { evaluateChecklistWithTrace } from "../src/checklist.js";

const facts = {
  nationality: "CN", residence: "CN", applicationCity: "北京", destination: "IS", purpose: "tourism",
  arrivalDate: "2027-06-01", departureDate: "2027-06-10", ageGroup: "adult", otherSchengenCountries: "no", occupation: "employed",
};
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "visa-helper-interview-"));
  const store = new ApplicationStore(join(dir, "applications.json"));
  const server = createVisaServer(store);
  const client = new Client({ name: "interview-tests", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const call = (name, args) => client.callTool({ name, arguments: args });
  const advance = async (args) => {
    const result = await call("advance_application", args);
    assert.equal(result.isError, undefined, JSON.stringify(result));
    advanceOutputSchema.parse(result.structuredContent);
    return result.structuredContent;
  };
  return { store, client, call, advance };
}

test("bootstrap rejects an incompatible actual tool inventory before creating an applicant", async (t) => {
  const { store, call } = await setup(t);
  const result = await call("advance_application", { answers: {}, clientTools: ["show_material_checklist", "start_task", "submit_answers"] });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.nextAction.type, "blocked");
  assert.equal(result.structuredContent.nextAction.code, "CLIENT_TOOLS_MISMATCH");
  assert.deepEqual(result.structuredContent.compatibility.missingTools, ["advance_application", "get_task_queue"]);
  assert.deepEqual(await store.readAll(), {});
});

// These are two caller input patterns; extraction accuracy itself still needs a real GPT-host check.
test("one interface supports guided and paragraph snapshots and hands off only at the leaf", async (t) => {
  const { client, call, advance } = await setup(t);
  const { tools } = await client.listTools();
  const tool = tools.find((tool) => tool.name === "advance_application");
  assert.ok(tool.outputSchema);
  assert.equal(tool._meta?.ui?.resourceUri, undefined);
  assert.ok(tool.description.includes("COMPLETE"));
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["advance_application", "get_server_info", "get_task_queue", "report_ui_ready", "start_task"]);
  let guided = await advance({ answers: {} });
  assert.equal(guided.protocolVersion, "1.0");
  assert.equal(guided.revision, 1);
  assert.equal(guided.nextAction.questionId, "nationality");
  assert.deepEqual(guided.questionCatalog.find((q) => q.id === "occupation").options.map((o) => o.value), ["employed", "retired", "unemployed"]);
  const premature = await call("get_task_queue", { applicationId: guided.applicationId });
  assert.equal(premature.structuredContent.error.code, "QUESTIONS_INCOMPLETE");
  const accumulated = {};
  while (guided.nextAction.type === "ask") {
    const { questionId } = guided.nextAction;
    accumulated[questionId] = facts[questionId];
    guided = await advance({ applicationId: guided.applicationId, revision: guided.revision, answers: accumulated });
  }
  assert.equal(guided.nextAction.type, "complete");
  assert.equal(guided.nextAction.taskCount, 12);
  assert.deepEqual(guided.answers, facts);
  const display = await call(guided.nextAction.presentation.tool, guided.nextAction.presentation.arguments);
  assert.equal(display.structuredContent.presentation.status, "not_confirmed");
  assert.equal(display._meta.application.tasks.length, 12);
  assert.equal(display.structuredContent.nextAction.type, "choose_task");
  const paragraphStart = await advance({ answers: {} });
  const paragraph = await advance({ applicationId: paragraphStart.applicationId, revision: paragraphStart.revision, answers: facts });
  assert.equal(paragraph.nextAction.type, "complete");
  assert.equal(paragraph.nextAction.taskCount, guided.nextAction.taskCount);
  assert.equal(paragraph.decision.nodeId, guided.decision.nodeId);
  assert.deepEqual(paragraph.answers, guided.answers);
});

test("later facts skip already answered nodes; replacement, withdrawal and read/resume are distinct", async (t) => {
  const { store, advance } = await setup(t);
  let state = await advance({ answers: { occupation: "employed", ageGroup: "adult" } });
  assert.equal(state.nextAction.questionId, "nationality");
  state = await advance({ applicationId: state.applicationId, revision: state.revision, answers: facts });
  const before = await readFile(store.filePath, "utf8");
  const resume = await advance({ applicationId: state.applicationId });
  assert.equal(resume.saved, false);
  assert.equal(resume.revision, state.revision);
  assert.deepEqual(resume.answers, facts);
  assert.equal(await readFile(store.filePath, "utf8"), before);
  const duplicate = await advance({ applicationId: state.applicationId, revision: state.revision, answers: { ...facts } });
  assert.equal(duplicate.saved, true);
  assert.equal(duplicate.revision, state.revision);
  assert.equal(await readFile(store.filePath, "utf8"), before);
  const withdrawn = { ...facts }; delete withdrawn.arrivalDate;
  state = await advance({ applicationId: state.applicationId, revision: state.revision, answers: withdrawn });
  assert.equal(state.nextAction.questionId, "arrivalDate");
  assert.equal(state.answers.arrivalDate, undefined);
  state = await advance({ applicationId: state.applicationId, revision: state.revision, answers: {} });
  assert.equal(state.nextAction.questionId, "nationality");
  assert.deepEqual(state.answers, {});
  const records = await store.readAll();
  assert.equal(records[state.applicationId].evaluations.length, 4);
});

test("invalid snapshot returns all repair issues without partial writes; canonical repair needs no repeated user reply", async (t) => {
  const { store, advance } = await setup(t);
  const state = await advance({ answers: {} });
  const before = await readFile(store.filePath, "utf8");
  const bad = await advance({ applicationId: state.applicationId, revision: state.revision,
    answers: { ...facts, occupation: "已退休", arrivalDate: "2027-02-30", inventedField: "x" } });
  assert.equal(bad.saved, false);
  assert.equal(bad.nextAction.type, "repair");
  assert.deepEqual(bad.nextAction.issues.map((i) => i.code).sort(), ["INVALID_DATE", "INVALID_OPTION", "UNKNOWN_QUESTION"]);
  assert.equal(bad.revision, state.revision);
  assert.deepEqual(bad.answers, {});
  assert.equal(await readFile(store.filePath, "utf8"), before);
  const repaired = await advance({ applicationId: state.applicationId, revision: bad.revision, answers: { ...facts, occupation: "retired" } });
  assert.equal(repaired.saved, true);
  assert.equal(repaired.nextAction.taskCount, 11);
  const invalidNew = await advance({ answers: { occupation: "已退休" } });
  assert.equal(invalidNew.applicationId, null);
  assert.equal(invalidNew.revision, 0);
  assert.equal(invalidNew.nextAction.type, "repair");
  assert.equal(Object.keys(await store.readAll()).length, 1);
});

test("stale and missing revisions cannot overwrite accepted answers, including concurrent changes", async (t) => {
  const { store, call, advance } = await setup(t);
  const created = await advance({ answers: facts });
  const requests = ["retired", "unemployed"].map((occupation) => advance({ applicationId: created.applicationId,
    revision: created.revision, answers: { ...facts, occupation } }));
  const outcomes = await Promise.all(requests);
  assert.equal(outcomes.filter((r) => r.saved).length, 1);
  const conflict = outcomes.find((r) => !r.saved);
  assert.equal(conflict.nextAction.code, "REVISION_CONFLICT");
  assert.equal(conflict.answers.occupation, "retired");
  const before = await readFile(store.filePath, "utf8");
  const missing = await advance({ applicationId: created.applicationId, answers: {} });
  assert.equal(missing.nextAction.code, "REVISION_CONFLICT");
  assert.equal(await readFile(store.filePath, "utf8"), before);
  await advance({ applicationId: created.applicationId, revision: conflict.revision, answers: { ...conflict.answers, applicationCity: "上海" } });
  const stale = await advance({ applicationId: created.applicationId, revision: conflict.revision, answers: facts });
  assert.equal(stale.nextAction.code, "REVISION_CONFLICT");
  assert.equal(stale.answers.applicationCity, "上海");
  const reconciled = await advance({ applicationId: created.applicationId, revision: stale.revision,
    answers: { ...stale.answers, occupation: "employed" } });
  assert.equal(reconciled.saved, true);
  assert.equal(reconciled.answers.applicationCity, "上海");
});

test("business contradictions and unsupported/review exits have explicit next actions", async (t) => {
  const { advance } = await setup(t);
  const dates = await advance({ answers: { ...facts, departureDate: "2027-05-30" } });
  assert.equal(dates.saved, true);
  assert.equal(dates.nextAction.type, "clarify");
  assert.equal(dates.nextAction.code, "CONTRADICTORY_ANSWERS");
  const fixed = await advance({ applicationId: dates.applicationId, revision: dates.revision, answers: facts });
  assert.equal(fixed.nextAction.type, "complete");
  const unsupported = await advance({ answers: { ...facts, nationality: "other" } });
  assert.equal(unsupported.nextAction.type, "blocked");
  assert.equal(unsupported.nextAction.code, "UNSUPPORTED");
  const review = await advance({ answers: { ...facts, otherSchengenCountries: "yes", icelandMainDestination: "unsure" } });
  assert.equal(review.nextAction.type, "blocked");
  assert.equal(review.nextAction.code, "NEEDS_REVIEW");
});

test("branch changes invalidate tasks/receipts and preserve replayable complete historical snapshots", async (t) => {
  const { store, call, advance } = await setup(t);
  let state = await advance({ answers: facts });
  const applicationId = state.applicationId;
  const display = await call("get_task_queue", { applicationId });
  const info = display.structuredContent.serverInfo;
  await call("start_task", { applicationId, taskId: "employment_letter" });
  await call("report_ui_ready", { applicationId, uiSourceHash: info.ui.sourceHash, buildHash: info.buildHash });
  state = await advance({ applicationId, revision: state.revision, answers: { ...facts, ageGroup: "minor", inSchool: "yes", minorTravel: "one_parent", guardianAbroad: "no" } });
  assert.equal(state.nextAction.type, "complete");
  assert.equal(state.answers.occupation, "employed"); // Known, but inactive adult facts do not select tasks.
  const changed = await store.get(applicationId);
  assert.equal(changed.uiReceipt, null);
  assert.equal(changed.activeTask, null);
  assert.ok(changed.tasks.some((task) => task.id === "travel_consent_certificate"));
  assert.ok(!changed.tasks.some((task) => task.id === "employment_letter"));
  assert.equal((await store.readAll())[applicationId].taskProgress.employment_letter, undefined);
  const staleTask = await call("start_task", { applicationId, taskId: "employment_letter" });
  assert.equal(staleTask.structuredContent.error.code, "TASK_NOT_FOUND");
  const history = (await store.readAll())[applicationId].evaluations;
  assert.equal(history.length, 2);
  assert.equal(history[0].input.ageGroup, "adult");
  assert.equal(history[1].input.ageGroup, "minor");
  for (const run of history) {
    const replay = evaluateChecklistWithTrace(run.input, run.ruleVersion);
    assert.deepEqual(replay.result, run.output);
    assert.deepEqual(replay.execution.path, run.path);
  }
});

test("existing records without revision resume at zero without being rewritten", async (t) => {
  const { store, advance } = await setup(t);
  const created = await advance({ answers: facts });
  const records = await store.readAll();
  delete records[created.applicationId].revision;
  await writeFile(store.filePath, JSON.stringify(records), { mode: 0o600 });
  const before = await readFile(store.filePath, "utf8");
  const resumed = await advance({ applicationId: created.applicationId });
  assert.equal(resumed.revision, 0);
  assert.equal(await readFile(store.filePath, "utf8"), before);
  const updated = await advance({ applicationId: created.applicationId, revision: 0, answers: { ...facts, occupation: "retired" } });
  assert.equal(updated.revision, 1);
});
