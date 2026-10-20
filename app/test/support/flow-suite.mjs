import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadRulePack, getActiveRuleVersion } from "../../src/checklist.js";
import { runDecision } from "../../src/decision-machine.js";
import { taskDefinitions } from "../../src/task-definitions.js";
import { createCoverage, graphOf, choiceExemptions, assertCovered, canonical, signature } from "./flow-coverage.mjs";
import { decisionScenarios, basicAnswers } from "./decision-scenarios.mjs";
import { taskScenarios, runRuleExamples } from "./task-scenarios.mjs";

export const contractUrl = new URL("../fixtures/flow-contract.json", import.meta.url);
export function flowContract(pack, definitions) {
  const structure = (machine) => { const graph = graphOf(machine); return { initial: graph.initial, nodes: graph.nodes,
    edges: graph.edges.map((edge) => ({ ...edge })).sort((a, b) => canonical(a).localeCompare(canonical(b))) }; };
  return { format: 1, interview: { id: pack.machine.id, graph: structure(pack.machine),
    questionChoices: pack.questionGroups.flatMap(({ questions }) => questions.map(({ id, type, options }) => ({ id, type, ...(options ? { choices: options.map(({ value }) => value).sort() } : {}) }))),
    materialIds: pack.tasks.map(({ id }) => id).sort(),
    nodeEffects: Object.fromEntries(Object.entries(pack.machine.states).map(([id, state]) => [id, {
      entry: state.entry ?? [], questionId: state.meta?.questionId ?? null, groupId: state.meta?.groupId ?? null, status: state.meta?.status ?? null,
    }])) },
    tasks: definitions.map((definition) => ({ id: definition.id, workflow: definition.workflow, policy: definition.policy,
      graph: structure(definition.machine), fields: definition.fields.map(({ id, type }) => ({ id, type: type ?? "string" })),
      checks: definition.checks.map(({ id, evidence }) => ({ id, evidence: evidence ?? "document" })),
      coverage: (definition.requiredCoverage ?? []).map(({ id }) => id).sort(), rules: definition.rules ?? [], document: definition.document?.template ?? null,
    })).sort((a, b) => a.id.localeCompare(b.id)) };
}
export async function runFlowSuite({ checkContract = true } = {}) {
  const pack = loadRulePack(getActiveRuleVersion()), definitions = taskDefinitions();
  const questions = pack.questionGroups.flatMap(({ questions }) => questions);
  const decisionCoverage = createCoverage("interview", pack.machine, choiceExemptions(graphOf(pack.machine), questions));
  for (const scenario of decisionScenarios()) {
    const { execution } = runDecision(pack, scenario.answers, { trace: true });
    for (const node of execution.path) decisionCoverage.node(node, scenario.name);
    for (const condition of execution.conditions) decisionCoverage.guard(condition.nodeId, "always", { type: condition.guard, params: condition.params }, condition.result, scenario.name);
    for (const edge of execution.transitions) decisionCoverage.transition(edge.source, "always", edge.target, scenario.name);
  }
  // These are intentional business expectations, independent of graph traversal.
  const employed = runDecision(pack, { ...basicAnswers, occupation: "employed" }).result;
  assert.equal(employed.status, "tasks_ready");
  assert.deepEqual(employed.tasks.map(({ id }) => id).sort(), ["schengen_form", "passport", "photo", "travel_insurance", "round_trip_reservation", "daily_itinerary", "accommodation", "chinese_id_copy", "hukou_copy", "bank_statements", "employer_license", "employment_letter"].sort());
  const retired = runDecision(pack, { ...basicAnswers, occupation: "retired" }).result;
  assert.ok(retired.tasks.some(({ id }) => id === "pension_income")); assert.ok(!retired.tasks.some(({ id }) => id === "employment_letter"));
  assert.deepEqual(definitions.map(({ id }) => id).sort(), pack.tasks.map(({ id }) => id).sort());

  const reports = [decisionCoverage.finish()], rules = [], scenarios = [];
  for (const definition of definitions) {
    const result = taskScenarios(definition);
    reports.push(result.report); scenarios.push({ taskId: definition.id, attempts: result.logs });
    rules.push(...runRuleExamples(definition).map((result) => ({ taskId: definition.id, ...result })));
  }
  const contract = flowContract(pack, definitions);
  const failures = [];
  try { assertCovered(reports); } catch (error) { failures.push(error.message); }
  for (const rule of rules) if (rule.missing.length) failures.push(`${rule.taskId}/${rule.id}: untested rule outcomes ${rule.missing.join(", ")}`);
  if (checkContract) {
    let saved;
    try { saved = JSON.parse(await readFile(contractUrl, "utf8")); } catch { failures.push("Missing structural contract; review fixtures and run test:flows:update-contract locally."); }
    if (saved && canonical(saved) !== canonical(contract)) failures.push("Flow contract changed (nodes, transitions, choices, checks, fields, rules or coverage). Add/review scenarios before explicitly updating the contract. CI never updates it.");
  }
  return { passed: failures.length === 0, failures, modelSignature: signature(contract), contract, reports, rules, scenarios,
    totals: reports.reduce((sum, report) => ({ nodes: sum.nodes + report.nodes.total, nodesCovered: sum.nodesCovered + report.nodes.covered,
      edges: sum.edges + report.edges.total, edgesCovered: sum.edgesCovered + report.edges.covered,
      branches: sum.branches + report.branches.total, branchesCovered: sum.branchesCovered + report.branches.covered }),
    { nodes: 0, nodesCovered: 0, edges: 0, edgesCovered: 0, branches: 0, branchesCovered: 0 }) };
}
export function reportMarkdown(result) {
  const t = result.totals;
  return ["# 流程自动回归覆盖报告", "", `结果：${result.passed ? "通过" : "失败"}。模型结构指纹：\`${result.modelSignature}\`。`, "",
    `实际运行覆盖：节点 ${t.nodesCovered}/${t.nodes}，连线 ${t.edgesCovered}/${t.edges}，可达条件结果 ${t.branchesCovered}/${t.branches}。`, "",
    "覆盖来自执行轨迹及实际被拒绝的条件事件；不等于全部输入组合、GPT理解或真实客户端交互都已验证。", "",
    "| 流程 | 节点 | 连线 | 条件结果 | 结果 |", "| --- | --- | --- | --- | --- |",
    ...result.reports.map((r) => `| ${r.id} | ${r.nodes.covered}/${r.nodes.total} | ${r.edges.covered}/${r.edges.total} | ${r.branches.covered}/${r.branches.total} | ${r.passed ? "通过" : "失败"} |`), "",
    "## 条件不能取反的已证明情况", "",
    ...result.reports.flatMap((r) => r.exemptions.map(({ branch, reason }) => `- ${r.id}：${branch}。${reason}`)), "",
    "## 独立规则样例", "", ...result.rules.map((r) => `- ${r.taskId}/${r.id}：${r.outcomes.join("、")}${r.missing.length ? `；缺少 ${r.missing.join("、")}` : ""}`), "",
    ...(result.failures.length ? ["## 未通过项目", "", ...result.failures.map((failure) => `- ${failure}`), ""] : []),
  ].join("\n");
}
