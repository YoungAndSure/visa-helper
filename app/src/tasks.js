import { createActor, setup } from "xstate";
import { z } from "zod";
import { getTaskDefinition, definitionForProgress } from "./task-definitions.js";
import { dateSchema, passportDateChecks, materialChecks, travelDays } from "./task-policies.js";
import { formFieldCatalog, prefillState } from "./schengen-pdf.js";
export { taskRelease } from "./task-definitions.js";

export class TaskError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const checksSchema = z.record(z.string(), z.boolean());
const findingSchema = z.object({ fieldId: z.string().optional(), message: z.string().min(1).max(1200),
  severity: z.enum(["issue", "unreadable", "note"]) }).strict();
const fieldsSchema = z.record(z.string(), z.string().trim().min(1).max(8000));
const formData = z.object({ fields: fieldsSchema.default({}), checks: checksSchema.default({}),
  fillMode: z.enum(["assisted", "manual"]).optional(),
  filled: z.boolean().default(false), signed: z.boolean().default(false),
  review: z.object({ documentRead: z.literal(true), pages: z.array(z.number().int().min(1).max(4)).min(1).max(4),
    checks: checksSchema, findings: z.array(findingSchema).max(80) }).strict().nullable().default(null),
}).strict();
const passportData = z.object({ fields: z.object({ issueDate: dateSchema.optional(), expiryDate: dateSchema.optional() }).strict().default({}),
  checks: checksSchema.default({}), prepared: z.boolean().default(false), confirmedDetails: z.boolean().default(false),
  review: z.object({ documentRead: z.literal(true), checks: checksSchema, findings: z.array(findingSchema).max(80) }).strict().nullable().default(null),
}).strict();
const materialData = z.object({ fields: fieldsSchema.default({}), checks: checksSchema.default({}),
  prepared: z.boolean().default(false), confirmedDetails: z.boolean().default(false),
  rows: z.array(z.object({ date: dateSchema, location: z.string().trim().max(1000).optional(), plan: z.string().trim().max(3000).optional(),
    transport: z.string().trim().max(1000).optional(), accommodation: z.string().trim().max(1000).optional() }).strict()).max(366).default([]),
  review: z.object({ documentRead: z.literal(true), coverage: z.array(z.string().min(1).max(100)).max(200),
    checks: checksSchema, findings: z.array(findingSchema).max(80) }).strict().nullable().default(null),
}).strict();
const schemas = { form: formData, passport: passportData, material: materialData };
// Apply defaults only after taskId selects the task policy.
const inputData = Object.values(schemas).map((schema) => z.object(Object.fromEntries(
  Object.entries(schema.shape).map(([key, field]) => [key, (field.removeDefault?.() ?? field).optional()]),
)).strict());
export const advanceTaskInputSchema = z.object({ applicationId: z.string().uuid(), taskId: z.string().min(1),
  revision: z.number().int().nonnegative().optional(),
  event: z.enum(["GUIDE_READY", "FILLED", "SELF_CHECK", "ASSISTED_CHECK", "REVIEW", "FINISH", "RETRY", "EDIT", "ACQUIRE", "READY"]).optional(),
  data: z.union(inputData).optional(),
}).strict();

const fail = (code, message) => { throw new TaskError(code, message); };
function definitionFor(progress) {
  return definitionForProgress(progress) ?? fail("TASK_VERSION_MISMATCH", "任务配置版本或指纹不一致，不能静默继续。");
}
export function supportsTask(id) { return Boolean(getTaskDefinition(id)); }
export function newTaskProgress(id = "schengen_form") {
  const definition = getTaskDefinition(id) ?? fail("TASK_NOT_IMPLEMENTED", "尚未配置这项任务。");
  return { taskId: id, status: "in_progress", version: definition.version, modelHash: definition.modelHash,
    revision: 0, node: definition.machine.initial, data: schemas[definition.policy].parse({}), history: [], confirmation: null };
}
function resetChecks(data, policy) {
  return policy === "form" ? { ...data, checks: {}, review: null, filled: false, signed: false }
    : { ...data, checks: {}, review: null, prepared: false, confirmedDetails: false };
}
export function invalidateTask(progress) {
  const definition = definitionFor(progress), data = resetChecks(progress.data, definition.policy);
  return { ...progress, node: definition.machine.initial, status: "in_progress", revision: progress.revision + 1,
    data, needsRecheck: true, confirmation: null,
    history: [...progress.history, { recordedAt: new Date().toISOString(), revision: progress.revision + 1,
      version: definition.version, modelHash: definition.modelHash, from: progress.node, to: definition.machine.initial,
      event: "APPLICATION_CHANGED", data: structuredClone(data) }] };
}
function automaticChecks(definition, data, answers) {
  if (definition.policy === "passport") return passportDateChecks(data.fields, answers);
  return definition.policy === "material" ? materialChecks(definition, data, answers) : [];
}
const checksPass = (definitions, values) => definitions.every(({ id }) => values[id] === true);
function canFinish(definition, data, answers, assisted) {
  const report = data.review;
  const dates = automaticChecks(definition, data, answers);
  if (dates.some(({ status }) => status === "fail")) return false;
  if (definition.policy === "form") return data.filled && data.signed && (assisted
    ? report?.documentRead && new Set(report.pages).size === definition.source.pages && checksPass(definition.checks, report.checks)
      && report.findings.every(({ severity }) => severity === "note")
    : checksPass(definition.checks, data.checks));
  if (!data.prepared) return false;
  if (!assisted) return checksPass(definition.checks, data.checks);
  if (!report?.documentRead || !data.confirmedDetails || report.findings.some(({ severity }) => severity !== "note")) return false;
  if (definition.policy === "passport") return dates.every(({ status }) => status === "pass")
    && report.checks.issued_within_ten_years === true && report.checks.validity === true && data.checks.blank_pages === true;
  return checksPass(definition.checks.filter(({ evidence }) => evidence === "user"), data.checks)
    && checksPass(definition.checks.filter(({ evidence }) => evidence !== "user"), report.checks)
    && definition.requiredCoverage.every(({ id }) => report.coverage.includes(id));
}
const machines = new Map();
function getMachine(definition) {
  if (!machines.has(definition.id)) machines.set(definition.id, setup({ guards: {
    reviewProvided: ({ context: { data } }) => data.review?.documentRead === true,
    selfConfirmed: ({ context: { data, answers } }) => canFinish(definition, data, answers, false),
    assistedConfirmed: ({ context: { data, answers } }) => canFinish(definition, data, answers, true),
  } }).createMachine({ ...definition.machine, context: { data: {}, answers: {} } }));
  return machines.get(definition.id);
}
function knownValues(definition, answers) {
  if (definition.policy !== "form") {
    const values = {};
    for (const field of definition.fields) if (field.fromAnswer && answers[field.fromAnswer]) values[field.id] = answers[field.fromAnswer];
    return values;
  }
  const values = {};
  if (answers.nationality === "CN") values["7"] = "Chinese";
  if (answers.nationality === "CN" && answers.residence === "CN") values["20"] = "No";
  if (answers.purpose === "tourism") values["23"] = "Tourism";
  if (answers.destination === "IS" && answers.otherSchengenCountries === "no") values["25"] = "Iceland";
  const formDate = (v) => dateSchema.safeParse(v).success ? v.split("-").reverse().join("-") : null;
  if (formDate(answers.arrivalDate)) values["27.arrival"] = formDate(answers.arrivalDate);
  if (formDate(answers.departureDate)) values["27.departure"] = formDate(answers.departureDate);
  return values;
}
// Presentation stages group alternate paths and retries; they are not an estimate
// of elapsed work. Derive them from the saved node without changing task histories.
function stageProgress(definition, node) {
  const stages = [{ id: "prepare", label: "准备材料" },
    ...(definition.workflow === "collect-v1" ? [] : [{ id: "fill", label: "填写与整理" }]),
    { id: "check", label: "检查与确认" }];
  const stage = { prepare: "prepare", acquiring: "prepare", filling: "fill", review_choice: "check",
    self_check: "check", await_upload: "check", assisted_check: "check" }[node];
  if (node !== "done" && !stages.some(({ id }) => id === stage)) fail("TASK_STATE_INVALID", "当前节点尚未配置任务阶段。");
  return { stages, currentStage: node === "done" ? null : stage,
    completedStages: node === "done" ? stages.length : stages.findIndex(({ id }) => id === stage),
    totalStages: stages.length, complete: node === "done" };
}
export function taskState(id, progress, answers = {}) {
  const definition = getTaskDefinition(id);
  if (!definition) return null;
  const current = progress?.version ? progress : newTaskProgress(id);
  if (definitionFor(current).id !== id) fail("TASK_VERSION_MISMATCH", "进度不属于这项任务。");
  const node = definition.machine.states[current.node];
  if (!node) fail("TASK_STATE_INVALID", "任务状态无效。");
  const known = knownValues(definition, answers);
  const guide = definition.fields.map((field) => ({ ...field,
    reference: definition.policy === "form" ? field.id === "signature" ? `第 ${field.page} 页 · 签字区` : `第 ${field.page} 页 · 第 ${field.id.split(".")[0]} 项` : field.label,
    value: current.data.fields[field.id] ?? known[field.id] ?? null,
    valueStatus: current.data.fields[field.id] ? "provided" : known[field.id] ? "from_application" : "needs_confirmation" }));
  return { taskId: id, version: current.version, modelHash: definition.modelHash, workflow: definition.workflow, policy: definition.policy,
    revision: current.revision, node: current.node, status: current.status, data: current.data, confirmation: current.confirmation,
    progress: stageProgress(definition, current.node),
    needsRecheck: current.needsRecheck ?? false, source: definition.source, fieldCatalog: formFieldCatalog(definition), checkCatalog: definition.checks,
    ...(definition.policy === "form" ? { prefill: prefillState(guide, current.data) } : {}),
    requirements: definition.requirements ?? [], acquisition: definition.acquisition ?? [], reviewInstructions: definition.reviewInstructions,
    requiredCoverage: definition.requiredCoverage ?? [], automaticChecks: automaticChecks(definition, current.data, answers),
    ...(definition.policy === "form" || definition.document ? { guide, document: definition.document ?? { template: "schengen", title: "申根申请表填写对照页" },
      travelDates: travelDays(answers) } : {}),
    nextAction: { type: node.meta.action, title: node.meta.title, guidance: node.meta.guidance,
      questions: current.node === "self_check" ? definition.checks.map(({ id, label, question, guidance }) => ({ id, question: question ?? label, guidance: guidance ?? label, answer: current.data.checks[id] ?? null }))
        .filter(({ answer }) => answer !== true) : [],
      events: Object.keys(node.on ?? {}), tool: "advance_task" } };
}
function validateData(definition, value) {
  const parsed = schemas[definition.policy].safeParse(value);
  if (!parsed.success) fail("TASK_DATA_INVALID", "任务数据无效，请使用当前字段目录及完整数据结构，不提交原文件或无关信息。");
  const data = parsed.data, fields = new Map(formFieldCatalog(definition).map((field) => [field.id, field])), checks = new Set(definition.checks.map(({ id }) => id));
  if (Object.keys(data.fields).some((id) => !fields.has(id)) || [...Object.keys(data.checks), ...Object.keys(data.review?.checks ?? {})].some((id) => !checks.has(id))
    || data.review?.findings.some(({ fieldId }) => fieldId && !fields.has(fieldId))) fail("TASK_DATA_INVALID", "字段或检查项不在当前任务目录中。");
  for (const [id, value] of Object.entries(data.fields)) {
    if (fields.get(id).type === "date" && !dateSchema.safeParse(value).success) fail("TASK_DATA_INVALID", "请输入有效的日历日期。");
    if (fields.get(id).type === "number" && (!/^\d+(\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))) fail("TASK_DATA_INVALID", "金额等数值字段请填写有效的非负数字。");
  }
  if (definition.policy === "material") {
    const coverage = new Set(definition.requiredCoverage.map(({ id }) => id));
    if (data.review?.coverage.some((id) => !coverage.has(id))) fail("TASK_DATA_INVALID", "读取范围不属于这项任务。");
    if (definition.document?.template !== "itinerary" && data.rows.length) fail("TASK_DATA_INVALID", "这项任务不接受行程条目。");
  }
  return data;
}
export function advanceTask(progress, { revision, event, data }, answers = {}) {
  const definition = definitionFor(progress), before = taskState(definition.id, progress, answers);
  if (revision !== before.revision) fail("TASK_REVISION_CONFLICT", "任务进度已变化，请读取最新数据后再提交。");
  if (!event && data === undefined) return progress;
  if (event && !before.nextAction.events.includes(event)) fail("TASK_EVENT_INVALID", "当前步骤不接受这个操作，请按 nextAction 继续。");
  if (before.node === "done" && event !== "EDIT") fail("TASK_REOPEN_REQUIRED", "修改前请先重新打开任务。");
  let next = validateData(definition, data ?? before.data);
  const editable = definition.policy === "form" ? ["prepare", "filling"] : definition.policy === "passport" ? ["prepare", "await_upload"] : ["prepare", "filling", "acquiring", "await_upload"];
  if (event !== "EDIT" && !editable.includes(before.node) && (JSON.stringify(next.fields) !== JSON.stringify(before.data.fields)
    || JSON.stringify(next.rows) !== JSON.stringify(before.data.rows))) fail("TASK_REOPEN_REQUIRED", "修改内容前请先 EDIT，旧检查和确认将失效。");
  if (event === "EDIT") next = resetChecks(next, definition.policy);
  if (["ASSISTED_CHECK", "RETRY"].includes(event)) next = definition.policy === "form" ? { ...next, review: null } : resetChecks(next, definition.policy);
  if (event === "SELF_CHECK" && definition.policy !== "form") next.review = null;
  const machine = getMachine(definition), actor = createActor(machine, { snapshot: machine.resolveState({ value: before.node, context: { data: next, answers } }) });
  let node;
  try { actor.start(); if (event) actor.send({ type: event }); const snapshot = actor.getSnapshot(); if (snapshot.status === "error") throw snapshot.error; node = snapshot.value; }
  finally { actor.stop(); }
  if (event && node === before.node) fail("TASK_CONDITIONS_UNMET", "完成条件尚未满足：请核对所需检查、读取范围、未解决的问题及用户准备确认。");
  const recordedAt = new Date().toISOString();
  return { ...progress, node, data: next, revision: before.revision + 1, status: node === "done" ? "done" : "in_progress",
    needsRecheck: ["GUIDE_READY", "FILLED", "SELF_CHECK", "ASSISTED_CHECK"].includes(event) ? false : progress.needsRecheck ?? false,
    confirmation: node === "done" ? { method: before.node === "self_check" ? "user_self_check" : "assistant_reported_review", confirmedBy: "user", recordedAt, officialApproval: false } : null,
    history: [...progress.history, { recordedAt, revision: before.revision + 1, version: definition.version, modelHash: definition.modelHash,
      from: before.node, to: node, event: event ?? "SAVE", data: structuredClone(next),
      ...(definition.policy !== "form" ? { answers: { arrivalDate: answers.arrivalDate, departureDate: answers.departureDate } } : {}) }] };
}
export function replayTaskHistory(progress) {
  const definition = definitionFor(progress);
  let replayed = newTaskProgress(definition.id);
  for (const entry of progress.history) {
    if (entry.version !== definition.version || entry.modelHash !== definition.modelHash || entry.from !== replayed.node || entry.revision !== replayed.revision + 1) fail("TASK_REPLAY_MISMATCH", "执行记录的版本、起点或顺序不一致。");
    replayed = entry.event === "APPLICATION_CHANGED" ? invalidateTask(replayed)
      : advanceTask(replayed, { revision: replayed.revision, event: entry.event === "SAVE" ? undefined : entry.event, data: entry.data }, entry.answers ?? {});
    if (replayed.node !== entry.to || JSON.stringify(replayed.data) !== JSON.stringify(entry.data)) fail("TASK_REPLAY_MISMATCH", "执行记录与引擎回放结果不一致。");
  }
  if (replayed.node !== progress.node || replayed.revision !== progress.revision || JSON.stringify(replayed.data) !== JSON.stringify(progress.data)) fail("TASK_REPLAY_MISMATCH", "最终状态与执行记录不一致。");
  return { valid: true, node: replayed.node, revision: replayed.revision, transitions: progress.history.length, modelHash: definition.modelHash };
}
