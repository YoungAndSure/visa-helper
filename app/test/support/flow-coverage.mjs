import { createHash } from "node:crypto";

export const canonical = (value) => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === "object"
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const signature = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const list = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
export const guardKey = (guard) => typeof guard === "string" ? guard : canonical(guard);
export const edgeKey = ({ source, event, target, guard }) => `${source} --${event}${guard ? ` [${guardKey(guard)}]` : ""}--> ${target}`;
export const branchKey = (source, event, guard, result) => `${source} / ${event} / ${guardKey(guard)} = ${result}`;

export function graphOf(machine) {
  const nodes = Object.keys(machine.states).sort(), edges = [];
  if (!nodes.includes(machine.initial)) throw new Error(`Missing initial node: ${machine.initial}`);
  for (const [source, state] of Object.entries(machine.states)) {
    if (state.states || state.type === "parallel") throw new Error(`Add coverage support for nested/parallel state: ${source}`);
    for (const [event, transitions] of [["always", state.always], ...Object.entries(state.on ?? {})]) {
      for (const transition of list(transitions)) {
        const target = typeof transition === "string" ? transition : transition.target;
        if (typeof target !== "string" || !nodes.includes(target)) throw new Error(`Unsupported or missing target: ${source}/${event}`);
        edges.push({ source, event, target, ...(transition.guard ? { guard: transition.guard } : {}) });
      }
    }
  }
  return { initial: machine.initial, nodes, edges };
}

// A final choice guard can be guaranteed true by validation plus preceding choices.
// Report the proof rather than demanding an impossible false branch.
export function choiceExemptions(graph, questionCatalog) {
  const exemptions = [];
  for (const edge of graph.edges.filter(({ guard }) => guard && typeof guard === "object" && ["equals", "oneOf"].includes(guard.type))) {
    const { field } = edge.guard.params;
    const question = questionCatalog.find(({ id }) => id === field);
    if (question?.type !== "choice") continue;
    const siblings = graph.edges.filter(({ source, event }) => source === edge.source && event === edge.event);
    const previous = siblings.slice(0, siblings.indexOf(edge));
    const matches = (guard, value) => guard.type === "equals" ? value === guard.params.value : guard.params.values.includes(value);
    if (previous.some(({ guard }) => !guard || !["equals", "oneOf"].includes(guard.type) || guard.params.field !== field)) continue;
    const remaining = question.options.map(({ value }) => value).filter((value) => !previous.some(({ guard }) => matches(guard, value)));
    if (remaining.length && remaining.every((value) => matches(edge.guard, value))) exemptions.push({
      branch: branchKey(edge.source, edge.event, edge.guard, false),
      reason: `Validated ${field} choices remaining after prior branches: ${remaining.join(", ")}; this guard must be true.`,
    });
  }
  return exemptions;
}
export function createCoverage(id, machine, exemptions = []) {
  const graph = graphOf(machine), visitedNodes = new Set(), visitedEdges = new Set(), branches = new Set(), cases = new Set();
  const names = new Map();
  const remember = (key, name) => { if (!names.has(key)) names.set(key, new Set()); if (names.get(key).size < 3) names.get(key).add(name); };
  return {
    graph,
    node(node, name) { visitedNodes.add(node); cases.add(name); remember(`node:${node}`, name); },
    transition(source, event, target, name, selectedGuard) {
      const candidates = graph.edges.filter((edge) => edge.source === source && edge.event === event && edge.target === target
        && (selectedGuard === undefined || canonical(edge.guard) === canonical(selectedGuard)));
      if (candidates.length !== 1) throw new Error(`Cannot uniquely attribute actual transition ${id}: ${source}/${event}/${target}`);
      const edge = candidates[0]; visitedEdges.add(edgeKey(edge)); remember(`edge:${edgeKey(edge)}`, name);
      this.node(source, name); this.node(target, name);
      if (edge.guard) this.guard(source, event, edge.guard, true, name);
    },
    guard(source, event, guard, result, name) { const key = branchKey(source, event, guard, result); branches.add(key); cases.add(name); remember(`branch:${key}`, name); },
    finish() {
      const expectedEdges = graph.edges.map(edgeKey), expectedBranches = graph.edges.filter(({ guard }) => guard)
        .flatMap(({ source, event, guard }) => [true, false].map((result) => branchKey(source, event, guard, result)));
      const exempt = new Set(exemptions.map(({ branch }) => branch));
      const requiredBranches = [...new Set(expectedBranches)].filter((key) => !exempt.has(key));
      const missingNodes = graph.nodes.filter((node) => !visitedNodes.has(node));
      const missingEdges = expectedEdges.filter((edge) => !visitedEdges.has(edge));
      const missingBranches = requiredBranches.filter((branch) => !branches.has(branch));
      return { id, passed: !missingNodes.length && !missingEdges.length && !missingBranches.length,
        nodes: { covered: graph.nodes.length - missingNodes.length, total: graph.nodes.length, missing: missingNodes },
        edges: { covered: expectedEdges.length - missingEdges.length, total: expectedEdges.length, missing: missingEdges },
        branches: { covered: requiredBranches.length - missingBranches.length, total: requiredBranches.length, missing: missingBranches },
        exemptions, cases: [...cases].sort(), witnesses: Object.fromEntries([...names].map(([key, value]) => [key, [...value].sort()])),
      };
    },
  };
}
export function assertCovered(reports) {
  const failures = reports.filter(({ passed }) => !passed);
  if (failures.length) throw new Error(failures.map((report) => `${report.id}:\n${[
    ...report.nodes.missing.map((id) => `  untested node: ${id}`), ...report.edges.missing.map((id) => `  untested transition: ${id}`),
    ...report.branches.missing.map((id) => `  untested branch: ${id}`),
  ].join("\n")}`).join("\n"));
}
