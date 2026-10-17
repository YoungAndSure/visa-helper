import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActor } from "xstate";
import { decisionGraph, writeDecisionArtifacts, portableMachine, main } from "../scripts/decision-artifacts.mjs";
import { loadRulePack, getActiveRuleVersion, evaluateChecklistWithTrace } from "../src/checklist.js";
import { ApplicationStore } from "../src/workflow.js";

const answers = { nationality: "CN", residence: "CN", applicationCity: "北京", destination: "IS", purpose: "tourism", arrivalDate: "2027-06-01", departureDate: "2027-06-10", ageGroup: "adult", otherSchengenCountries: "no", occupation: "employed" };

test("diagram edges come from the executing machine and every replayed transition is visible", async () => {
  const pack = loadRulePack(getActiveRuleVersion());
  const { execution } = evaluateChecklistWithTrace(answers);
  const graph = decisionGraph(pack);
  assert.equal(graph.nodes.length, Object.keys(pack.machine.states).length);
  for (const transition of execution.transitions) assert.ok(graph.edges.some((edge) => edge.source === transition.source && edge.target === transition.target));
  assert.ok(graph.edges.some((edge) => edge.source === "route_occupation" && edge.target === "materials_retired" && edge.guard.params.value === "retired"));
  const revised = structuredClone(pack);
  revised.machine.states.materials_employed.entry[0].params.ids.push("passport");
  assert.ok(decisionGraph(revised).nodes.find((node) => node.id === "materials_employed").taskIds.includes("passport"));
  const dir = await mkdtemp(join(tmpdir(), "visa-helper-diagram-"));
  await writeDecisionArtifacts(pack, execution, dir);
  const svg = await readFile(join(dir, "iceland.svg"), "utf8");
  assert.match(svg, /class="node tasks visited" data-node="materials_employed"/);
  assert.match(svg, /class="node outcome visited current" data-node="ready"/);
  assert.match(await readFile(join(dir, "iceland.html"), "utf8"), /节点详情/);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "iceland.machine.json"), "utf8")), pack.machine);
});

test("portable Sketch source runs with XState alone and reproduces the material selection", async () => {
  const pack = loadRulePack(getActiveRuleVersion());
  // Supply the installed package URL because data URLs cannot resolve bare npm imports.
  const source = portableMachine(pack, answers).replace("from 'xstate'", `from '${import.meta.resolve("xstate")}'`);
  const { machine } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const actor = createActor(machine).start();
  try {
    assert.equal(actor.getSnapshot().value, "ready");
    assert.equal(actor.getSnapshot().status, "done");
    const expected = evaluateChecklistWithTrace(answers).result.tasks.map((task) => task.id).sort();
    assert.deepEqual([...actor.getSnapshot().context.taskIds].sort(), expected);
  } finally { actor.stop(); }
});

test("saved evaluation CLI replays historical input and rejects changed implementation fingerprints", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visa-helper-replay-"));
  const store = new ApplicationStore(join(dir, "applications.json"));
  const { id } = await store.create();
  const employed = await store.submitAnswers(id, answers);
  await store.submitAnswers(id, { occupation: "retired" });
  await main(["--application", id, "--evaluation", employed.decision.evaluationId, "--data", store.filePath, "--out", join(dir, "graph")]);
  const replay = JSON.parse(await readFile(join(dir, "graph/iceland.trace.json"), "utf8"));
  assert.equal(replay.input.occupation, "employed");
  const records = await store.readAll();
  records[id].evaluations.at(-1).implementationHash = "0".repeat(64);
  await store.saveAll(records);
  await assert.rejects(main(["--application", id, "--data", store.filePath, "--out", join(dir, "bad")]), /version mismatch/);
});
