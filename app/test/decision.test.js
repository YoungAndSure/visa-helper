import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateChecklist, evaluateChecklistWithTrace, loadRulePack, getActiveRuleVersion } from "../src/checklist.js";
import { validateMachine, runDecision } from "../src/decision-machine.js";
import { ApplicationStore } from "../src/workflow.js";
import { evaluateLegacy, legacyPack } from "./fixtures/legacy-evaluator.js";

const basic = { nationality: "CN", residence: "CN", applicationCity: "北京", destination: "IS", purpose: "tourism", arrivalDate: "2027-06-01", departureDate: "2027-06-10", ageGroup: "adult", otherSchengenCountries: "no" };
const comparable = ({ decision, group, ...result }) => ({ ...result, ...(group === undefined ? {} : { group: group ? (({ when, ...rest }) => rest)(group) : null }) });

test("XState matches the frozen legacy evaluator across branches, partial replies, corrections and blockers", (t) => {
  const cases = [{}];
  const branches = [];
  for (const occupation of ["employed", "retired", "unemployed"]) for (const maritalStatus of ["married", "single", "divorced", "widowed"]) for (const sponsor of ["self", "spouse", "other"]) {
    branches.push({ ageGroup: "adult", occupation, maritalStatus, sponsor });
  }
  // Include stale adult facts on minor records, because users can correct earlier answers.
  for (const inSchool of ["yes", "no"]) for (const minorTravel of ["alone", "one_parent", "both_parents", "other_guardian"]) for (const guardianAbroad of ["yes", "no"]) for (const occupation of ["employed", "unemployed"]) {
    branches.push({ ageGroup: "minor", inSchool, minorTravel, guardianAbroad, occupation, sponsor: "other" });
  }
  const trips = [
    { otherSchengenCountries: "no" },
    ...["yes", "no", "unsure"].map((icelandMainDestination) => ({ otherSchengenCountries: "yes", icelandMainDestination })),
  ];
  for (const branch of branches) for (const trip of trips) {
    const answers = { ...basic, ...branch, ...trip };
    cases.push(answers);
    // Every possible next missing question must still stop at the original group.
    for (const field of Object.keys(answers)) { const partial = { ...answers }; delete partial[field]; cases.push(partial); }
  }
  for (const field of ["nationality", "residence", "destination", "purpose"]) cases.push({ ...basic, occupation: "employed", [field]: "other" });
  cases.push({ ...basic, departureDate: basic.arrivalDate }, { ...basic, departureDate: "2027-05-30" }, { ...basic, nationality: "other", departureDate: "2027-05-30" });
  for (const answers of cases) assert.deepEqual(comparable(evaluateChecklist(answers)), comparable(evaluateLegacy(answers)), JSON.stringify(answers));
  assert.ok(cases.length > 3000);
  t.diagnostic(`Compared ${cases.length} inputs with the frozen 0.4.1 evaluator`);
});

test("pinned legacy applications execute through the reviewed XState bridge", () => {
  const answers = { ...basic, occupation: "employed" };
  const old = evaluateChecklist(answers, legacyPack.version);
  assert.equal(old.decision.engine, "xstate");
  assert.deepEqual(comparable(old), comparable(evaluateLegacy(answers)));
});

test("trace captures every transient node, guard outcome and selected material branch", () => {
  const { result, execution } = evaluateChecklistWithTrace({ ...basic, occupation: "employed" });
  assert.equal(result.status, "tasks_ready");
  assert.equal(execution.path[0], "q_nationality");
  assert.equal(execution.path.at(-1), "ready");
  assert.ok(execution.path.includes("materials_employed"));
  assert.ok(!execution.path.includes("materials_retired"));
  assert.ok(execution.conditions.some((entry) => entry.nodeId === "route_countries" && entry.result === false));
  assert.equal(execution.transitions.length, execution.path.length - 1);
  assert.deepEqual(evaluateChecklistWithTrace(execution.input).execution, execution);
  const waiting = evaluateChecklistWithTrace({ ...basic });
  assert.equal(waiting.execution.path.at(-1), "q_occupation");
  assert.equal(waiting.execution.conditions.at(-1).result, false);
});

test("answer revisions persist separate complete inputs and their own replayable paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visa-helper-traces-"));
  const store = new ApplicationStore(join(dir, "applications.json"));
  const { id } = await store.create();
  const employed = await store.submitAnswers(id, { ...basic, occupation: "employed" });
  const retired = await store.submitAnswers(id, { occupation: "retired" });
  assert.notEqual(employed.decision.evaluationId, retired.decision.evaluationId);
  const runs = JSON.parse(await readFile(store.filePath, "utf8"))[id].evaluations;
  assert.equal(runs.length, 3);
  assert.equal(runs[1].input.occupation, "employed");
  assert.equal(runs[2].input.nationality, "CN");
  assert.equal(runs[2].input.occupation, "retired");
  assert.ok(runs[1].path.includes("materials_employed"));
  assert.ok(runs[2].path.includes("materials_retired"));
  for (const run of runs) assert.deepEqual(evaluateChecklistWithTrace(run.input, run.ruleVersion).result, run.output);
});

test("invalid models cannot introduce missing references, unknown actions or eventless cycles", () => {
  const pack = loadRulePack(getActiveRuleVersion());
  const cycle = structuredClone(pack);
  cycle.machine.states.ready = { always: { target: cycle.machine.initial } };
  assert.throws(() => validateMachine(cycle), /cycle/);
  const bad = structuredClone(pack);
  bad.machine.states.materials_employed.entry[0].params.ids = ["unknown_material"];
  assert.throws(() => validateMachine(bad), /Invalid action/);
  const duplicate = structuredClone(pack);
  duplicate.machine.states.materials_employed.entry[0].params.ids.push("employment_letter");
  assert.equal(runDecision(duplicate, { ...basic, occupation: "employed" }).result.tasks.filter((task) => task.id === "employment_letter").length, 1);
});
