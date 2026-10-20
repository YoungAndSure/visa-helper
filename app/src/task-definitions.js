import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const profiles = read("../config/task-workflows.json");
const form = read("../config/tasks/schengen-form-v1.json");
const passport = read("../config/tasks/passport-v1.json");
const materials = read("../config/tasks/iceland-materials-v1.json");
const definitions = new Map();
// Keep existing version hashes: old task instances and their histories stay readable.
for (const raw of [form, passport]) {
  const machine = raw.id === "passport" ? {
    ...profiles["collect-v1"], id: raw.id,
    states: Object.fromEntries(Object.entries(raw.machine.states).map(([id, state]) => [id, {
      ...state, on: profiles["collect-v1"].states[id].on && Object.fromEntries(
        Object.entries(profiles["collect-v1"].states[id].on).filter(([event]) => event in (state.on ?? {}))),
    }])),
  } : raw.machine;
  if (raw.id === "passport") for (const [id, state] of Object.entries(raw.machine.states)) {
    for (const [event, transition] of Object.entries(state.on ?? {})) {
      if (JSON.stringify(machine.states[id].on[event]) !== JSON.stringify(transition)) throw new Error("Shared profile changes require a new passport version");
    }
  }
  definitions.set(raw.id, { ...raw, policy: raw.id === "passport" ? "passport" : "form", machine,
    workflow: raw.id === "passport" ? "collect-v1" : "schengen-form-v1", modelHash: hash(raw) });
}
for (const raw of materials.tasks) {
  if (definitions.has(raw.id) || !profiles[raw.workflow]) throw new Error(`Invalid task definition: ${raw.id}`);
  definitions.set(raw.id, { ...raw, machine: { ...profiles[raw.workflow], id: raw.id },
    modelHash: hash({ definition: raw, workflow: profiles[raw.workflow], catalogVersion: materials.version }) });
}
for (const definition of definitions.values()) {
  for (const key of ["fields", "checks"]) {
    const ids = definition[key].map(({ id }) => id);
    if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${key} for ${definition.id}`);
  }
  for (const check of definition.rules ?? []) if (!definition.checks.some(({ id }) => id === check.checkId)) throw new Error(`Unknown check ${check.checkId}`);
}
export function getTaskDefinition(id) { return definitions.get(id); }
export function taskDefinitions() { return [...definitions.values()]; }
export function definitionForProgress(progress) {
  const definition = progress.taskId ? definitions.get(progress.taskId) : [...definitions.values()].find(({ version }) => version === progress.version);
  if (!definition || definition.version !== progress.version || definition.modelHash !== progress.modelHash) return null;
  return definition;
}
export const taskRelease = { version: form.version, modelHash: hash(form),
  tasks: taskDefinitions().map(({ id, version, modelHash, workflow }) => ({ taskId: id, version, modelHash, workflow })) };
