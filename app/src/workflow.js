import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_CONFIG_DIR, evaluateChecklist, getActiveRuleVersion, loadRulePack, validateAnswerPatch } from "./checklist.js";

export const PATH = Object.freeze({
  id: "cn-passport-cn-resident-is-tourism",
  label: "中国护照 · 居住中国 · 冰岛旅游",
  ruleStatus: "simulation_draft",
});

export class WorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function publicState(record, configDir = DEFAULT_CONFIG_DIR) {
  if (!record.answers) {
    return {
      id: record.id, path: PATH, status: "legacy_walkthrough", data: record.data,
      updatedAt: record.updatedAt,
      notice: "这是旧版交互演示记录。请新建申请，以使用材料决策树。",
    };
  }
  const result = evaluateChecklist(record.answers, record.ruleVersion, configDir);
  const questionCatalog = loadRulePack(record.ruleVersion, configDir).questionGroups.flatMap((group) => group.questions);
  return {
    id: record.id,
    path: PATH,
    ruleVersion: record.ruleVersion,
    status: result.status,
    answers: record.answers,
    questionGroup: result.group ? { id: result.group.id, title: result.group.title, total: result.group.questions.length } : null,
    questions: result.questions,
    questionCatalog,
    tasks: result.tasks,
    reviewNotes: result.reviewNotes ?? [],
    reason: result.reason ?? null,
    updatedAt: record.updatedAt,
    notice: result.notice,
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
      records[record.id] = record;
      return publicState(record, this.configDir);
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
      record.updatedAt = new Date().toISOString();
      return publicState(record, this.configDir);
    });
  }
}
