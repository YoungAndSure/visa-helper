import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createActor, setup } from "xstate";
import { z } from "zod";

const definition = JSON.parse(readFileSync(new URL("../config/tasks/schengen-form-v1.json", import.meta.url), "utf8"));
const modelHash = createHash("sha256").update(JSON.stringify(definition)).digest("hex");
export const taskRelease = { version: definition.version, modelHash };
const fieldIds = new Set(definition.fields.map((field) => field.id));
const checkIds = definition.checks.map((check) => check.id);
const eventNames = ["GUIDE_READY", "FILLED", "SELF_CHECK", "ASSISTED_CHECK", "REVIEW", "FINISH", "RETRY", "EDIT"];
const dataSchema = z.object({
  fields: z.record(z.string(), z.string().trim().min(1).max(1800)).default({}),
  checks: z.record(z.string(), z.boolean()).default({}),
  filled: z.boolean().default(false), signed: z.boolean().default(false),
  review: z.object({
    documentRead: z.literal(true), pages: z.array(z.number().int().min(1).max(4)).min(1).max(4),
    checks: z.record(z.string(), z.boolean()),
    findings: z.array(z.object({ fieldId: z.string().optional(), message: z.string().min(1).max(1200),
      severity: z.enum(["issue", "unreadable", "note"]) }).strict()).max(80),
  }).strict().nullable().default(null),
}).strict();
export const advanceTaskInputSchema = z.object({
  applicationId: z.string().uuid(), taskId: z.string().min(1),
  revision: z.number().int().nonnegative().optional(),
  event: z.enum(eventNames).optional(), data: dataSchema.optional(),
}).strict();

export class TaskError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const allChecks = (checks) => checkIds.every((id) => checks[id] === true);
const reviewProvided = ({ context: { data } }) => Boolean(data.review?.documentRead);
const machine = setup({ guards: {
  reviewProvided,
  selfConfirmed: ({ context: { data } }) => data.filled && data.signed && allChecks(data.checks),
  assistedConfirmed: ({ context: { data } }) => data.filled && data.signed && reviewProvided({ context: { data } })
    && new Set(data.review.pages).size === definition.source.pages && allChecks(data.review.checks)
    && !data.review.findings.some((finding) => finding.severity !== "note"),
} }).createMachine({ ...definition.machine, context: { data: {} } });

export function supportsTask(id) { return id === definition.id; }
export function newTaskProgress() {
  return { status: "in_progress", version: definition.version, modelHash, revision: 0,
    node: definition.machine.initial, data: dataSchema.parse({}), history: [], confirmation: null };
}

export function invalidateTask(progress) {
  const data = { ...progress.data, checks: {}, review: null, filled: false, signed: false };
  return { ...progress, status: "in_progress", node: "prepare", revision: progress.revision + 1,
    data, history: [...progress.history, { recordedAt: new Date().toISOString(), revision: progress.revision + 1,
      version: definition.version, modelHash, from: progress.node, to: "prepare", event: "APPLICATION_CHANGED", data: structuredClone(data) }],
    confirmation: null, needsRecheck: true };
}

export function replayTaskHistory(progress) {
  let replayed = newTaskProgress();
  for (const entry of progress.history) {
    if (entry.version !== definition.version || entry.modelHash !== modelHash || entry.from !== replayed.node || entry.revision !== replayed.revision + 1) {
      throw new TaskError("TASK_REPLAY_MISMATCH", "执行记录的版本、起点或顺序不一致。");
    }
    replayed = entry.event === "APPLICATION_CHANGED" ? invalidateTask(replayed)
      : advanceTask(replayed, { revision: replayed.revision, event: entry.event === "SAVE" ? undefined : entry.event, data: entry.data });
    if (replayed.node !== entry.to || JSON.stringify(replayed.data) !== JSON.stringify(entry.data)) {
      throw new TaskError("TASK_REPLAY_MISMATCH", "执行记录与当前引擎回放结果不一致。");
    }
  }
  if (replayed.node !== progress.node || replayed.revision !== progress.revision ||
      JSON.stringify(replayed.data) !== JSON.stringify(progress.data)) throw new TaskError("TASK_REPLAY_MISMATCH", "最终任务状态与执行记录不一致。");
  return { valid: true, node: replayed.node, revision: replayed.revision, transitions: progress.history.length, modelHash };
}

export function taskState(id, progress) {
  if (!supportsTask(id)) return null;
  const current = progress?.version ? progress : newTaskProgress();
  if (current.version !== definition.version || current.modelHash !== modelHash) {
    throw new TaskError("TASK_VERSION_MISMATCH", "这项任务的配置版本已变化，请先迁移任务进度，不能静默继续。");
  }
  const node = definition.machine.states[current.node];
  if (!node) throw new TaskError("TASK_STATE_INVALID", "任务状态无效，不能继续。");
  return { taskId: id, version: current.version, modelHash, revision: current.revision, node: current.node,
    status: current.status, data: current.data, confirmation: current.confirmation,
    needsRecheck: current.needsRecheck ?? false, source: definition.source,
    fieldCatalog: definition.fields, checkCatalog: definition.checks,
    guide: definition.fields.map((field) => ({ ...field, value: current.data.fields[field.id] ?? null,
      valueStatus: current.data.fields[field.id] ? "provided" : "needs_confirmation" })),
    nextAction: { type: node.meta.action, title: node.meta.title, guidance: node.meta.guidance,
      events: Object.keys(node.on ?? {}), tool: "advance_task" } };
}

export function advanceTask(progress, { revision, event, data }) {
  const before = taskState(definition.id, progress);
  if (revision !== before.revision) throw new TaskError("TASK_REVISION_CONFLICT", "任务进度已变化，请读取最新数据，整合后再提交。");
  if (!event && data === undefined) return progress;
  if (event && !before.nextAction.events.includes(event)) throw new TaskError("TASK_EVENT_INVALID", "当前步骤不接受这个操作，请按最新 nextAction 继续。");
  // Editing confirmed material must explicitly reopen the task and revoke old checks.
  if (data !== undefined && !["prepare", "filling"].includes(before.node) && event !== "EDIT" &&
      JSON.stringify(data.fields) !== JSON.stringify(before.data.fields)) {
    throw new TaskError("TASK_REOPEN_REQUIRED", "修改填写内容前请先用 EDIT 重新打开任务，旧检查和完成确认将失效。");
  }
  if (before.node === "done" && event !== "EDIT") throw new TaskError("TASK_REOPEN_REQUIRED", "这项任务已完成，修改前请先重新打开。");
  const nextData = dataSchema.parse(data ?? before.data);
  if (Object.keys(nextData.fields).some((id) => !fieldIds.has(id)) ||
      [...Object.keys(nextData.checks), ...Object.keys(nextData.review?.checks ?? {})].some((id) => !checkIds.includes(id)) ||
      nextData.review?.findings.some((finding) => finding.fieldId && !fieldIds.has(finding.fieldId))) {
    throw new TaskError("TASK_DATA_INVALID", "字段或检查项不在当前任务目录中。");
  }
  if (event === "EDIT") Object.assign(nextData, { checks: {}, review: null, filled: false, signed: false });
  if (event === "ASSISTED_CHECK" || event === "RETRY") nextData.review = null;
  const actor = createActor(machine, { snapshot: machine.resolveState({ value: before.node, context: { data: nextData } }) });
  let node;
  try {
    actor.start();
    if (event) actor.send({ type: event });
    const snapshot = actor.getSnapshot();
    if (snapshot.status === "error") throw snapshot.error;
    node = snapshot.value;
  } finally { actor.stop(); }
  if (event && node === before.node) throw new TaskError("TASK_CONDITIONS_UNMET", "完成条件未满足：请核对检查项、填写及签字确认；辅助检查还需覆盖全部页面且无未解决问题。");
  const recordedAt = new Date().toISOString();
  return { ...progress, node, data: nextData, revision: before.revision + 1,
    status: node === "done" ? "done" : "in_progress",
    needsRecheck: event === "GUIDE_READY" || event === "FILLED" ? false : progress.needsRecheck ?? false,
    confirmation: node === "done" ? { method: before.node === "self_check" ? "user_self_check" : "assistant_reported_review",
      confirmedBy: "user", recordedAt, officialApproval: false } : null,
    history: [...progress.history, { recordedAt, revision: before.revision + 1, version: definition.version, modelHash,
      from: before.node, to: node, event: event ?? "SAVE", data: structuredClone(nextData) }] };
}
