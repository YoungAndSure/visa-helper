import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createActor, setup } from "xstate";
import { z } from "zod";

const definition = JSON.parse(readFileSync(new URL("../config/tasks/passport-v1.json", import.meta.url), "utf8"));
const modelHash = createHash("sha256").update(JSON.stringify(definition)).digest("hex");
export const passportRelease = { taskId: definition.id, version: definition.version, modelHash };
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "请输入有效的日历日期。");
export const passportDataSchema = z.object({
  fields: z.object({ issueDate: date.optional(), expiryDate: date.optional() }).strict().default({}),
  checks: z.record(z.string(), z.boolean()).default({}),
  prepared: z.boolean().default(false), confirmedDetails: z.boolean().default(false),
  review: z.object({ documentRead: z.literal(true), checks: z.record(z.string(), z.boolean()),
    findings: z.array(z.object({ fieldId: z.enum(["issueDate", "expiryDate"]).optional(),
      message: z.string().min(1).max(1200), severity: z.enum(["issue", "unreadable", "note"]) }).strict()).max(80),
  }).strict().nullable().default(null),
}).strict();

// Calendar arithmetic clamps to the final day of a month (including leap years).
function addMonths(value, months) {
  const [year, month, day] = value.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}
export function passportDateChecks(fields, answers = {}) {
  const arrival = date.safeParse(answers.arrivalDate).success ? answers.arrivalDate : null;
  const departure = date.safeParse(answers.departureDate).success ? answers.departureDate : null;
  const issue = fields.issueDate, expiry = fields.expiryDate;
  const minimumExpiry = departure ? addMonths(departure, 3) : null;
  const latestArrival = issue ? addMonths(issue, 120) : null;
  return [
    { id: "issued_within_ten_years", status: issue && arrival ? (issue <= arrival && arrival <= latestArrival ? "pass" : "fail") : "unknown",
      referenceDate: arrival, limitDate: latestArrival, guidance: "以已确认的预计入境日核对签发后10年，不推断递交日期。" },
    { id: "validity", status: expiry && minimumExpiry ? (expiry >= minimumExpiry && (!issue || expiry > issue) ? "pass" : "fail") : "unknown",
      referenceDate: departure, limitDate: minimumExpiry, guidance: "到期日须覆盖预计离境日后3个日历月。" },
  ];
}
const allChecks = (checks) => definition.checks.every(({ id }) => checks[id] === true);
const dateOK = (data, answers, requireKnown = false) => passportDateChecks(data.fields, answers)
  .every(({ status }) => requireKnown ? status === "pass" : status !== "fail");
const machine = setup({ guards: {
  reviewProvided: ({ context: { data } }) => data.review?.documentRead === true,
  selfConfirmed: ({ context: { data, answers } }) => data.prepared && allChecks(data.checks) && dateOK(data, answers),
  assistedConfirmed: ({ context: { data, answers } }) => data.prepared && data.confirmedDetails && data.review?.documentRead
    && dateOK(data, answers, true) && data.review.checks.issued_within_ten_years === true && data.review.checks.validity === true
    && data.checks.blank_pages === true && !data.review.findings.some(({ severity }) => severity !== "note"),
} }).createMachine({ ...definition.machine, context: { data: {}, answers: {} } });

export function newPassportProgress() {
  return { taskId: "passport", status: "in_progress", version: definition.version, modelHash, revision: 0,
    node: "prepare", data: passportDataSchema.parse({}), history: [], confirmation: null };
}
export function passportState(progress, answers = {}, ErrorType = Error) {
  const current = progress?.version ? progress : newPassportProgress();
  if (current.version !== definition.version || current.modelHash !== modelHash) throw new ErrorType("TASK_VERSION_MISMATCH", "护照任务配置版本不一致，不能静默继续。");
  const node = definition.machine.states[current.node];
  if (!node) throw new ErrorType("TASK_STATE_INVALID", "护照任务状态无效。");
  return { taskId: "passport", version: current.version, modelHash, revision: current.revision,
    node: current.node, status: current.status, data: current.data, confirmation: current.confirmation,
    needsRecheck: current.needsRecheck ?? false, source: definition.source,
    fieldCatalog: definition.fields, checkCatalog: definition.checks,
    automaticChecks: passportDateChecks(current.data.fields, answers),
    nextAction: { type: node.meta.action, title: node.meta.title, guidance: node.meta.guidance,
      questions: definition.checks.map(({ id, question, guidance }) => ({ id, question, guidance, answer: current.data.checks[id] ?? null })),
      events: Object.keys(node.on ?? {}), tool: "advance_task" } };
}
export function invalidatePassport(progress) {
  const data = { ...progress.data, checks: {}, review: null, prepared: false, confirmedDetails: false };
  return { ...progress, node: "prepare", status: "in_progress", revision: progress.revision + 1, data,
    needsRecheck: true, confirmation: null, history: [...progress.history, { recordedAt: new Date().toISOString(),
      revision: progress.revision + 1, version: definition.version, modelHash, from: progress.node, to: "prepare",
      event: "APPLICATION_CHANGED", data: structuredClone(data) }] };
}
export function advancePassport(progress, { revision, event, data }, answers, ErrorType) {
  const before = passportState(progress, answers, ErrorType);
  if (revision !== before.revision) throw new ErrorType("TASK_REVISION_CONFLICT", "护照任务已变化，请先读取最新进度。");
  if (!event && data === undefined) return progress;
  if (event && !before.nextAction.events.includes(event)) throw new ErrorType("TASK_EVENT_INVALID", "当前护照步骤不接受这个操作。");
  if (before.node === "done" && event !== "EDIT") throw new ErrorType("TASK_REOPEN_REQUIRED", "修改前请先重新打开护照任务。");
  const parsed = passportDataSchema.safeParse(data ?? before.data);
  if (!parsed.success) throw new ErrorType("TASK_DATA_INVALID", "护照任务数据无效，请使用字段目录及有效的日历日期；不要提交号码、姓名或原文件。");
  const next = parsed.data;
  const checkIds = new Set(definition.checks.map(({ id }) => id));
  if ([...Object.keys(next.checks), ...Object.keys(next.review?.checks ?? {})].some((id) => !checkIds.has(id))) {
    throw new ErrorType("TASK_DATA_INVALID", "检查项不在护照任务目录中。");
  }
  // New observations after a report need a new review; saving confirmation alone is allowed.
  if (["self_check", "assisted_check"].includes(before.node) && event !== "EDIT" && JSON.stringify(next.fields) !== JSON.stringify(before.data.fields)) {
    throw new ErrorType("TASK_REOPEN_REQUIRED", "修改护照日期前请先 EDIT，旧检查将失效。");
  }
  if (event === "EDIT") Object.assign(next, { checks: {}, review: null, prepared: false, confirmedDetails: false });
  if (["ASSISTED_CHECK", "RETRY"].includes(event)) Object.assign(next, { review: null, checks: {}, prepared: false, confirmedDetails: false });
  if (event === "SELF_CHECK") next.review = null;
  const actor = createActor(machine, { snapshot: machine.resolveState({ value: before.node, context: { data: next, answers } }) });
  let node;
  try {
    actor.start(); if (event) actor.send({ type: event });
    const snapshot = actor.getSnapshot(); if (snapshot.status === "error") throw snapshot.error;
    node = snapshot.value;
  } finally { actor.stop(); }
  if (event && node === before.node) throw new ErrorType("TASK_CONDITIONS_UNMET", "护照检查尚未完成：请处理日期或未读清的问题，确认空白页及原件已准备好；辅助检查还需用户核对提取信息。");
  const recordedAt = new Date().toISOString();
  return { ...progress, node, data: next, revision: before.revision + 1, status: node === "done" ? "done" : "in_progress",
    needsRecheck: ["SELF_CHECK", "ASSISTED_CHECK"].includes(event) ? false : progress.needsRecheck ?? false,
    confirmation: node === "done" ? { method: before.node === "self_check" ? "user_self_check" : "assistant_reported_review",
      confirmedBy: "user", recordedAt, officialApproval: false } : null,
    history: [...progress.history, { recordedAt, revision: before.revision + 1, version: definition.version, modelHash,
      from: before.node, to: node, event: event ?? "SAVE", data: structuredClone(next),
      answers: { arrivalDate: answers.arrivalDate, departureDate: answers.departureDate } }] };
}
export function replayPassport(progress, ErrorType) {
  let replayed = newPassportProgress();
  for (const entry of progress.history) {
    if (entry.version !== definition.version || entry.modelHash !== modelHash || entry.from !== replayed.node || entry.revision !== replayed.revision + 1) {
      throw new ErrorType("TASK_REPLAY_MISMATCH", "护照执行记录版本或顺序不一致。");
    }
    replayed = entry.event === "APPLICATION_CHANGED" ? invalidatePassport(replayed)
      : advancePassport(replayed, { revision: replayed.revision, event: entry.event === "SAVE" ? undefined : entry.event, data: entry.data }, entry.answers ?? {}, ErrorType);
    if (replayed.node !== entry.to || JSON.stringify(replayed.data) !== JSON.stringify(entry.data)) throw new ErrorType("TASK_REPLAY_MISMATCH", "护照历史回放结果不一致。");
  }
  if (replayed.node !== progress.node || replayed.revision !== progress.revision || JSON.stringify(replayed.data) !== JSON.stringify(progress.data)) throw new ErrorType("TASK_REPLAY_MISMATCH", "护照最终状态与记录不一致。");
  return { valid: true, node: replayed.node, revision: replayed.revision, transitions: progress.history.length, modelHash };
}
