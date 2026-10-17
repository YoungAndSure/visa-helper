import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_CONFIG_DIR, evaluateChecklist, evaluateChecklistWithTrace, getActiveRuleVersion, loadRulePack, validateAnswerPatch } from "./checklist.js";

export const PATH = Object.freeze({
  id: "cn-passport-cn-resident-is-tourism",
  label: "中国护照 · 居住中国 · 冰岛旅游",
  ruleStatus: "pending_verification",
});

export class WorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function publicState(record, configDir = DEFAULT_CONFIG_DIR, evaluation) {
  if (!record.answers) {
    return {
      id: record.id, path: PATH, status: "legacy_walkthrough", data: record.data,
      updatedAt: record.updatedAt,
      notice: "这是旧版交互演示记录。请新建申请，以使用材料决策树。",
    };
  }
  const result = evaluation ?? evaluateChecklist(record.answers, record.ruleVersion, configDir);
  const pack = loadRulePack(record.ruleVersion, configDir);
  const questionCatalog = pack.questionGroups.flatMap((group) => group.questions);
  const pendingQuestions = result.status === "questions"
    ? result.questions.filter((question) => record.answers[question.id] === undefined)
    : result.questions;
  const tasks = result.tasks.map((task) => ({ ...task, status: record.taskProgress?.[task.id]?.status ?? "todo" }));
  return {
    id: record.id,
    path: PATH,
    ruleVersion: record.ruleVersion,
    decision: { ...result.decision, evaluationId: record.evaluations?.at(-1)?.id ?? null },
    status: result.status,
    answers: record.answers,
    questionGroup: result.group ? { id: result.group.id, title: result.group.title, total: result.group.questions.length } : null,
    questions: result.questions,
    pendingQuestions,
    nextQuestion: result.status === "questions" ? pendingQuestions[0] ?? null : null,
    questionCatalog,
    tasks,
    activeTask: tasks.find((task) => task.id === record.activeTaskId) ?? null,
    uiReceipt: record.uiReceipt ?? null,
    reviewNotes: result.reviewNotes ?? [],
    reason: result.reason?.replaceAll("本模拟", "当前流程").replaceAll("当前模拟", "当前版本") ?? null,
    updatedAt: record.updatedAt,
    notice: pack.source?.status === "user_supplied_unverified"
      ? `材料依据：你提供的 ${pack.source.createdDate.slice(0, 4)} 年签证材料审核表，尚待与现行官方要求核对。`
      : result.notice,
  };
}

export class ApplicationStore {
  constructor(filePath, configDir = DEFAULT_CONFIG_DIR) {
    this.filePath = filePath;
    this.configDir = configDir;
    this.queue = Promise.resolve();
  }

  async readAll() {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  async saveAll(records) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(records, null, 2), { mode: 0o600 });
    await rename(temp, this.filePath);
  }

  async mutate(change) {
    const operation = this.queue.then(async () => {
      const records = await this.readAll();
      const result = change(records);
      await this.saveAll(records);
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async create() {
    return this.mutate((records) => {
      const record = {
        id: randomUUID(),
        ruleVersion: getActiveRuleVersion(this.configDir),
        answers: {},
        updatedAt: new Date().toISOString(),
      };
      const { result, execution } = evaluateChecklistWithTrace(record.answers, record.ruleVersion, this.configDir);
      record.evaluations = [{ id: randomUUID(), recordedAt: record.updatedAt, ...execution }];
      records[record.id] = record;
      return publicState(record, this.configDir, result);
    });
  }

  async get(id) {
    const record = (await this.readAll())[id];
    if (!record) throw new WorkflowError("NOT_FOUND", "找不到该申请。");
    return publicState(record, this.configDir);
  }

  async submitAnswers(id, patch) {
    return this.mutate((records) => {
      const record = records[id];
      if (!record) throw new WorkflowError("NOT_FOUND", "找不到该申请。");
      if (!record.answers) throw new WorkflowError("LEGACY_APPLICATION", "旧版演示记录无法填写新问卷，请新建申请。");
      try {
        validateAnswerPatch(patch, record.ruleVersion, this.configDir);
      } catch (error) {
        throw new WorkflowError("INVALID_ANSWERS", error.message);
      }
      record.answers = { ...record.answers, ...patch };
      delete record.uiReceipt;
      record.updatedAt = new Date().toISOString();
      const { result, execution } = evaluateChecklistWithTrace(record.answers, record.ruleVersion, this.configDir);
      record.evaluations ??= [];
      record.evaluations.push({ id: randomUUID(), recordedAt: record.updatedAt, answerPatch: structuredClone(patch), ...execution });
      return publicState(record, this.configDir, result);
    });
  }

  async startTask(id, taskId) {
    return this.mutate((records) => {
      const record = records[id];
      if (!record) throw new WorkflowError("NOT_FOUND", "找不到该申请。");
      const state = publicState(record, this.configDir);
      if (state.status !== "tasks_ready") throw new WorkflowError("QUESTIONS_INCOMPLETE", "请先在对话中补齐申请信息。");
      if (!state.tasks.some((task) => task.id === taskId)) throw new WorkflowError("TASK_NOT_FOUND", "这项材料不在当前清单中，请刷新清单。");
      record.taskProgress ??= {};
      record.taskProgress[taskId] = { status: "in_progress" };
      record.activeTaskId = taskId;
      record.updatedAt = new Date().toISOString();
      return publicState(record, this.configDir);
    });
  }

  async recordUiReady(id, receipt, expectedUpdatedAt) {
    return this.mutate((records) => {
      const record = records[id];
      if (!record) throw new WorkflowError("NOT_FOUND", "找不到该申请。");
      if (publicState(record, this.configDir).status !== "tasks_ready") throw new WorkflowError("QUESTIONS_INCOMPLETE", "申请信息尚未完整。");
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== record.updatedAt) {
        throw new WorkflowError("UI_STATE_CHANGED", "申请状态已变化，请重新读取清单。");
      }
      record.uiReceipt = { ...receipt, applicationUpdatedAt: record.updatedAt, receivedAt: new Date().toISOString() };
      return record.uiReceipt;
    });
  }
}
