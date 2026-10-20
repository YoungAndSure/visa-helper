import test from "node:test";
import assert from "node:assert/strict";
import { createCoverage, assertCovered, canonical, graphOf, choiceExemptions } from "./support/flow-coverage.mjs";
import { taskScenarios } from "./support/task-scenarios.mjs";
import { runFlowSuite, flowContract } from "./support/flow-suite.mjs";
import { getTaskDefinition, taskDefinitions } from "../src/task-definitions.js";
import { getActiveRuleVersion, loadRulePack } from "../src/checklist.js";

test("all live flow nodes, edges, reachable guard outcomes and configured rules have executed regression cases", async (t) => {
  const result = await runFlowSuite();
  assert.equal(result.passed, true, result.failures.join("\n"));
  t.diagnostic(JSON.stringify(result.totals));
});

test("adding an untested pause node and its transitions fails the coverage gate", () => {
  const definition = getTaskDefinition("photo"), { logs } = taskScenarios(definition);
  const mutated = structuredClone(definition.machine);
  mutated.states.prepare.on.PAUSE = "paused";
  mutated.states.paused = { on: { RESUME: "prepare" } };
  const coverage = createCoverage("mutated-photo", mutated);
  for (const log of logs) {
    if (log.result === "accepted") coverage.transition(log.source, log.event, log.target, log.scenario);
    else coverage.guard(log.source, log.event, definition.machine.states[log.source].on[log.event].guard, false, log.scenario);
  }
  const report = coverage.finish();
  assert.deepEqual(report.nodes.missing, ["paused"]);
  assert.ok(report.edges.missing.some((edge) => edge.includes("PAUSE")));
  assert.ok(report.edges.missing.some((edge) => edge.includes("RESUME")));
  assert.throws(() => assertCovered([report]), /untested node: paused/);
});

test("rewiring a target is not accepted just because all old nodes still exist", () => {
  const definition = getTaskDefinition("photo"), machine = structuredClone(definition.machine);
  machine.states.acquiring.on.READY = "self_check";
  const coverage = createCoverage("rewired-photo", machine);
  assert.throws(() => coverage.transition("acquiring", "READY", "prepare", "old successful execution"), /Cannot uniquely attribute/);
});

test("removed requirements and guards change the reviewed contract even if coverage denominator shrinks", () => {
  const pack = loadRulePack(getActiveRuleVersion()), original = flowContract(pack, taskDefinitions());
  for (const mutation of [
    (definition) => definition.checks.pop(),
    (definition) => { delete definition.machine.states.prepare.on.ACQUIRE; },
    (definition) => { delete definition.machine.states.self_check.on.FINISH.guard; },
  ]) {
    const changed = structuredClone(taskDefinitions()); mutation(changed.find(({ id }) => id === "photo"));
    assert.notEqual(canonical(flowContract(pack, changed)), canonical(original));
  }
});

test("adding a choice invalidates a formerly guaranteed branch proof", () => {
  const pack = loadRulePack(getActiveRuleVersion()), questions = pack.questionGroups.flatMap(({ questions }) => questions);
  const graph = graphOf(pack.machine);
  const before = choiceExemptions(graph, questions);
  assert.ok(before.some(({ branch }) => branch.startsWith("route_countries /")));
  const changed = structuredClone(questions);
  changed.find(({ id }) => id === "otherSchengenCountries").options.push({ value: "new_choice", label: "New choice" });
  const after = choiceExemptions(graph, changed);
  assert.ok(!after.some(({ branch }) => branch.startsWith("route_countries /")));
});
