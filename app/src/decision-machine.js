import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createActor, setup, assign } from "xstate";

const require = createRequire(import.meta.url);
export const ENGINE_VERSION = require("xstate/package.json").version;
export const IMPLEMENTATION_HASH = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
export const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Shared by the server and the portable Sketch export. No network, clock, or model calls.
export const predicates = {
  answered: (answers, { field }) => answers[field] !== undefined,
  equals: (answers, { field, value }) => answers[field] === value,
  oneOf: (answers, { field, values }) => values.includes(answers[field]),
  before: (answers, { left, right }) => answers[left] < answers[right],
  allEqual: (answers, { values }) => Object.entries(values).every(([key, value]) => answers[key] === value),
  inconsistentSpouse: (answers) => answers.sponsor === "spouse" && answers.maritalStatus !== "married",
  guardianAbroadReview: (answers) => ["alone", "one_parent", "other_guardian"].includes(answers.minorTravel) && answers.guardianAbroad === "yes",
  otherSponsorReview: (answers) => answers.occupation === "unemployed" && answers.sponsor === "other",
};

export function runtimeLogic(observeGuard = () => {}) {
  return {
    guards: Object.fromEntries(Object.entries(predicates).map(([name, predicate]) => [name, ({ context }, params) => {
      const result = predicate(context.answers, params);
      observeGuard({ nodeId: params.nodeId, guard: name, params, result });
      return result;
    }])),
    actions: {
      addTasks: assign(({ context }, { ids }) => ({ taskIds: [...new Set([...context.taskIds, ...ids])] })),
      addNotes: assign(({ context }, { ids }) => ({ noteIds: [...new Set([...context.noteIds, ...ids])] })),
    },
  };
}

export function createChecklistMachine(pack, observeGuard) {
  return setup(runtimeLogic(observeGuard)).createMachine({
    ...pack.machine,
    context: ({ input }) => ({ answers: input.answers, taskIds: [], noteIds: [] }),
  });
}

export function runDecision(pack, answers, { trace = false } = {}) {
  const input = structuredClone(answers);
  const conditions = [];
  const transitions = [];
  const path = [pack.machine.initial];
  const machine = createChecklistMachine(pack, trace ? (condition) => conditions.push(condition) : undefined);
  const actor = createActor(machine, {
    input: { answers: input },
    inspect: trace ? (event) => {
      if (event.type !== "@xstate.microstep") return;
      for (const transition of event._transitions ?? event.transitions ?? []) {
        for (const target of transition.target ?? []) {
          transitions.push({ source: transition.source.key, target: target.key, event: event.event.type });
          if (path.at(-1) !== target.key) path.push(target.key);
        }
      }
    } : undefined,
  });
  try {
    actor.start();
    const snapshot = actor.getSnapshot();
    if (snapshot.status === "error") throw snapshot.error;
    const nodeId = snapshot.value;
    const meta = pack.machine.states[nodeId]?.meta;
    const modelHash = hash(pack);
    const decision = { engine: "xstate", engineVersion: ENGINE_VERSION, modelHash, implementationHash: IMPLEMENTATION_HASH, nodeId };
    let result;
    if (meta?.kind === "question") {
      const group = pack.questionGroups.find((entry) => entry.id === meta.groupId);
      result = { status: "questions", group, questions: group.questions, tasks: [], notice: pack.notice };
    } else if (snapshot.status === "done" && meta?.status === "tasks_ready") {
      const selected = new Set(snapshot.context.taskIds);
      const notes = new Set(snapshot.context.noteIds);
      result = {
        status: "tasks_ready", questions: [],
        tasks: pack.tasks.filter((task) => selected.has(task.id)).map(({ when, dependsOn, ...task }) => ({ ...task, matchedConditions: dependsOn ?? [], status: "todo" })),
        reviewNotes: pack.reviewNotes.filter((note) => notes.has(note.id)).map((note) => note.text), notice: pack.notice,
      };
    } else if (snapshot.status === "done" && meta?.kind === "outcome") {
      const group = meta.groupId ? pack.questionGroups.find((entry) => entry.id === meta.groupId) : null;
      result = { status: meta.status, reason: meta.reason, group, questions: group?.questions ?? [], tasks: [], notice: pack.notice };
    } else throw new Error(`Decision model stalled at non-question node: ${nodeId}`);
    result.decision = decision;
    return {
      result,
      execution: trace ? { ...decision, ruleVersion: pack.version, input, path, conditions, transitions, output: structuredClone(result) } : undefined,
    };
  } finally { actor.stop(); }
}

export function validateMachine(pack) {
  if (pack.engine !== "xstate" || !pack.machine?.states?.[pack.machine.initial]) throw new Error(`Invalid XState model: ${pack.version}`);
  const questions = new Set(pack.questionGroups.flatMap((group) => group.questions.map((question) => question.id)));
  const groups = new Set(pack.questionGroups.map((group) => group.id));
  const tasks = new Set(pack.tasks.map((task) => task.id));
  const notes = new Set(pack.reviewNotes.map((note) => note.id));
  const reachable = new Set();
  const pending = [pack.machine.initial];
  while (pending.length) {
    const id = pending.pop();
    if (reachable.has(id)) continue;
    const state = pack.machine.states[id];
    if (!state) throw new Error(`Unknown target node: ${id}`);
    reachable.add(id);
    if (state.meta?.kind === "question" && (!questions.has(state.meta.questionId) || !groups.has(state.meta.groupId))) throw new Error(`Unknown question metadata at ${id}`);
    const actions = Array.isArray(state.entry) ? state.entry : state.entry ? [state.entry] : [];
    for (const action of actions) {
      const catalog = action.type === "addTasks" ? tasks : action.type === "addNotes" ? notes : null;
      if (!catalog || !Array.isArray(action.params?.ids) || action.params.ids.some((item) => !catalog.has(item))) throw new Error(`Invalid action at ${id}`);
    }
    const transitions = Array.isArray(state.always) ? state.always : state.always ? [state.always] : [];
    for (const transition of transitions) {
      if (transition.guard && !(transition.guard.type in predicates)) throw new Error(`Unknown guard at ${id}`);
      pending.push(transition.target);
    }
  }
  if (reachable.size !== Object.keys(pack.machine.states).length) throw new Error("Decision model contains unreachable nodes");
  // Eventless decision models must terminate or wait at a question; reject cycles before XState runs.
  const complete = new Set();
  function visit(id, visiting = new Set()) {
    if (visiting.has(id)) throw new Error(`Decision model contains a cycle at ${id}`);
    if (complete.has(id)) return;
    const state = pack.machine.states[id];
    const next = new Set(visiting).add(id);
    for (const transition of Array.isArray(state.always) ? state.always : state.always ? [state.always] : []) visit(transition.target, next);
    complete.add(id);
  }
  visit(pack.machine.initial);
}
