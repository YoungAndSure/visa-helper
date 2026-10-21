import assert from "node:assert/strict";
import { newTaskProgress, taskState, advanceTask, replayTaskHistory, invalidateTask } from "../../src/tasks.js";
import { createCoverage } from "./flow-coverage.mjs";
import { basicAnswers } from "./decision-scenarios.mjs";
export const facts = { ...basicAnswers, occupation: "employed" };
const checks = (definition, predicate = () => true) => Object.fromEntries(definition.checks.filter(predicate).map(({ id }) => [id, true]));
function goodData(definition, data, assisted = false) {
  if (definition.policy === "form") return { ...data, filled: true, signed: true, checks: checks(definition), ...(assisted ? {
    review: { documentRead: true, pages: [1, 2, 3, 4], checks: checks(definition), findings: [] },
  } : {}) };
  return { ...data, prepared: true, confirmedDetails: assisted,
    checks: checks(definition, ({ evidence }) => !assisted || evidence === "user"),
    ...(assisted ? { ...(definition.policy === "passport" ? { fields: { issueDate: "2020-06-01", expiryDate: "2030-06-01" } } : {}),
      review: { documentRead: true, ...(definition.policy === "material" ? { coverage: definition.requiredCoverage.map(({ id }) => id) } : {}),
        checks: checks(definition, ({ evidence }) => evidence !== "user"), findings: [] } } : {}),
  };
}
export function taskScenarios(definition) {
  if (!["collect-v1", "draft-v1", "schengen-form-v1"].includes(definition.workflow)) throw new Error(`Add scenarios for workflow ${definition.workflow}`);
  const coverage = createCoverage(definition.id, definition.machine), logs = [];
  const draft = definition.workflow !== "collect-v1";
  function driver(name) {
    let progress = newTaskProgress(definition.id);
    coverage.node(progress.node, name);
    const api = {
      get progress() { return progress; },
      get data() { return progress.data; },
      step(event, expected, data) {
        const from = progress.node;
        progress = advanceTask(progress, { revision: progress.revision, event, ...(data ? { data } : {}) }, facts);
        assert.equal(progress.node, expected, `${definition.id}/${name}/${from}/${event}`);
        coverage.transition(from, event, progress.node, name);
        logs.push({ scenario: name, source: from, event, target: progress.node, result: "accepted" });
        return api;
      },
      reject(event, data, label) {
        const before = JSON.stringify(progress), state = definition.machine.states[progress.node], raw = state.on?.[event];
        assert.ok(raw && !Array.isArray(raw) && typeof raw === "object" && raw.guard, `Add guarded-event adapter: ${definition.id}/${progress.node}/${event}`);
        assert.throws(() => advanceTask(progress, { revision: progress.revision, event, data }, facts), { code: "TASK_CONDITIONS_UNMET" }, `${definition.id}/${name}/${label}`);
        assert.equal(JSON.stringify(progress), before, "Rejected event must not mutate progress");
        coverage.guard(progress.node, event, raw.guard, false, `${name}/${label}`);
        logs.push({ scenario: `${name}/${label}`, source: progress.node, event, target: progress.node, result: "rejected" });
        return api;
      },
      route() { if (draft) api.step("FILLED", "review_choice", definition.policy === "form" ? { ...progress.data, filled: true } : undefined); return api; },
      replay() { assert.equal(replayTaskHistory(progress).valid, true, `${definition.id}/${name}/replay`); return api; },
    };
    return api;
  }
  const self = driver("private self-check and reopen").route().step("SELF_CHECK", "self_check");
  const selfGood = goodData(definition, self.data);
  self.reject("FINISH", self.data, "no confirmations");
  for (const { id } of definition.checks) self.reject("FINISH", { ...selfGood, checks: { ...selfGood.checks, [id]: false } }, `unchecked:${id}`);
  for (const flag of definition.policy === "form" ? ["filled", "signed"] : ["prepared"]) self.reject("FINISH", { ...selfGood, [flag]: false }, `missing:${flag}`);
  self.step("FINISH", "done", selfGood).step("EDIT", "prepare").replay();

  const upload = driver("assisted review, corrections and completion").route().step("ASSISTED_CHECK", "await_upload");
  upload.reject("REVIEW", upload.data, "no file read");
  const reviewed = goodData(definition, upload.data, true);
  // REVIEW records the observation; readiness still needs explicit confirmation.
  const pending = definition.policy === "form" ? { ...reviewed, signed: false } : { ...reviewed, confirmedDetails: false, prepared: false };
  upload.step("REVIEW", "assisted_check", pending).reject("FINISH", pending, "not confirmed");
  const assistedGood = goodData(definition, upload.data, true);
  for (const check of definition.checks) {
    const bad = structuredClone(assistedGood);
    if (definition.policy !== "form" && check.evidence === "user") bad.checks[check.id] = false;
    else bad.review.checks[check.id] = false;
    upload.reject("FINISH", bad, `unchecked:${check.id}`);
  }
  for (const flag of definition.policy === "form" ? ["filled", "signed"] : ["prepared", "confirmedDetails"]) upload.reject("FINISH", { ...assistedGood, [flag]: false }, `missing:${flag}`);
  if (definition.policy === "form") upload.reject("FINISH", { ...assistedGood, review: { ...assistedGood.review, pages: [1, 2, 3] } }, "missing page");
  for (const { id } of definition.requiredCoverage ?? []) upload.reject("FINISH", {
    ...assistedGood, review: { ...assistedGood.review, coverage: assistedGood.review.coverage.filter((item) => item !== id) },
  }, `missing coverage:${id}`);
  for (const severity of ["issue", "unreadable"]) upload.reject("FINISH", { ...assistedGood,
    review: { ...assistedGood.review, findings: [{ message: "Fixture observation", severity }] } }, `unresolved:${severity}`);
  upload.step("RETRY", "await_upload").step("REVIEW", "assisted_check", pending)
    .step("FINISH", "done", assistedGood).replay();
  const changed = invalidateTask(upload.progress);
  assert.equal(changed.node, "prepare"); assert.equal(changed.confirmation, null); assert.equal(changed.needsRecheck, true);
  assert.equal(replayTaskHistory(changed).valid, true);

  const switchPath = driver("switch inspection path and edit each review stage").route().step("ASSISTED_CHECK", "await_upload")
    .step("SELF_CHECK", "self_check").step("ASSISTED_CHECK", "await_upload");
  switchPath.step("REVIEW", "assisted_check", goodData(definition, switchPath.data, true))
    .step("SELF_CHECK", "self_check").step("EDIT", "prepare").route().step("ASSISTED_CHECK", "await_upload")
    .step("EDIT", "prepare").route().step("ASSISTED_CHECK", "await_upload");
  switchPath.step("REVIEW", "assisted_check", goodData(definition, switchPath.data, true)).step("EDIT", "prepare").replay();

  if (draft) {
    driver("partial guide, modify, fill and return").step("GUIDE_READY", "filling").step("EDIT", "prepare")
      .step("GUIDE_READY", "filling").step("FILLED", "review_choice").step("EDIT", "prepare").replay();
    if (definition.policy === "form") for (const fillMode of ["assisted", "manual"]) {
      const mode = driver(`official PDF ${fillMode} mode retains granular fields and still requires review`);
      mode.step("GUIDE_READY", "filling", { ...mode.data, fillMode, fields: { "1": "EXAMPLE", "19.phone": "+86 13800000000" } });
      assert.equal(mode.data.fillMode, fillMode); assert.equal(mode.data.filled, false);
      mode.step("FILLED", "review_choice", { ...mode.data, filled: true }).step("SELF_CHECK", "self_check");
      mode.reject("FINISH", mode.data, "PDF generation does not confirm review or signature");
      mode.step("FINISH", "done", goodData(definition, mode.data)).replay();
      assert.equal(mode.data.fields["19.phone"], "+86 13800000000");
    }
  } else if (definition.policy === "material") {
    driver("acquire actual material and resume").step("ACQUIRE", "acquiring").step("READY", "prepare")
      .step("ACQUIRE", "acquiring").step("EDIT", "prepare").replay();
  }
  return { report: coverage.finish(), logs };
}

// Independent numeric/date examples, not generated from implementation thresholds.
const ruleExamples = {
  passport: [
    { name: "unknown dates", fields: {}, expected: { issued_within_ten_years: "unknown", validity: "unknown" } },
    { name: "valid passport", fields: { issueDate: "2020-06-01", expiryDate: "2030-06-01" }, expected: { issued_within_ten_years: "pass", validity: "pass" } },
    { name: "old and too-short passport", fields: { issueDate: "2010-06-01", expiryDate: "2027-09-02" }, expected: { issued_within_ten_years: "fail", validity: "fail" } },
  ],
  travel_insurance: [
    { name: "unknown insurance", fields: {}, expected: { period: "unknown", amount: "unknown" } },
    { name: "boundary insurance", fields: { startDate: "2027-06-01", endDate: "2027-06-03", amount: "30000", currency: "EUR" }, expected: { period: "pass", amount: "pass" } },
    { name: "starts late and insufficient", fields: { startDate: "2027-06-02", endDate: "2027-06-03", amount: "29999", currency: "EUR" }, expected: { period: "fail", amount: "fail" } },
    { name: "CNY boundary", fields: { amount: "300000", currency: "CNY" }, expected: { period: "unknown", amount: "pass" } },
    { name: "below CNY boundary", fields: { amount: "299999", currency: "CNY" }, expected: { period: "unknown", amount: "fail" } },
  ],
  daily_itinerary: [
    { name: "unknown plan", rows: [], expected: { days: "unknown" } },
    { name: "all travel days", rows: ["01", "02", "03"].map((d) => ({ date: `2027-06-${d}`, location: "Reykjavik", plan: "Confirmed plan" })), expected: { days: "pass" } },
    { name: "missing travel days", rows: [{ date: "2027-06-01", location: "Reykjavik", plan: "Confirmed plan" }], expected: { days: "fail" } },
  ],
};
export function runRuleExamples(definition) {
  const expectedIds = definition.policy === "passport" ? ["issued_within_ten_years", "validity"] : (definition.rules ?? []).map(({ checkId }) => checkId);
  const observations = new Map(expectedIds.map((id) => [id, new Set()]));
  for (const example of ruleExamples[definition.id] ?? []) {
    let progress = newTaskProgress(definition.id);
    progress = advanceTask(progress, { revision: 0, data: { ...progress.data, fields: example.fields ?? {}, ...(example.rows ? { rows: example.rows } : {}) } }, facts);
    for (const result of taskState(definition.id, progress, facts).automaticChecks) {
      assert.equal(result.status, example.expected[result.id], `${definition.id}/${example.name}/${result.id}`);
      observations.get(result.id)?.add(result.status);
    }
  }
  return expectedIds.map((id) => ({ id, outcomes: [...observations.get(id)].sort(),
    missing: ["pass", "fail", "unknown"].filter((outcome) => !observations.get(id).has(outcome)) }));
}
