import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const PATH = Object.freeze({
  id: "cn-passport-cn-resident-is-tourism",
  label: "中国护照 · 居住中国 · 冰岛旅游",
  ruleStatus: "pending_verification",
});

const STEPS = Object.freeze([
  { id: "scenario", title: "确认申请场景", fields: ["nationality", "residence", "destination", "purpose"] },
  { id: "trip", title: "记录旅行计划", fields: ["arrivalDate", "departureDate"] },
  { id: "review", title: "查看准备状态", fields: [] },
]);

const REQUIRED_SCENARIO = {
  nationality: "CN",
  residence: "CN",
  destination: "IS",
  purpose: "tourism",
};

export class WorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function publicState(record) {
  return {
    id: record.id,
    path: PATH,
    status: record.status,
    currentStep: record.currentStep,
    completedSteps: record.completedSteps,
    steps: STEPS,
    data: record.data,
    updatedAt: record.updatedAt,
    notice: "当前仅验证应用交互。官方签证规则和材料清单尚未发布。",
  };
}

export class ApplicationStore {
  constructor(filePath) {
    this.filePath = filePath;
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
      const now = new Date().toISOString();
      const record = {
        id: randomUUID(),
        status: "in_progress",
        currentStep: "scenario",
        completedSteps: [],
        data: {},
        updatedAt: now,
      };
      records[record.id] = record;
      return publicState(record);
    });
  }

  async get(id) {
    const record = (await this.readAll())[id];
    if (!record) throw new WorkflowError("NOT_FOUND", "找不到该申请。");
    return publicState(record);
  }

  async submit(id, stepId, input) {
    return this.mutate((records) => {
      const record = records[id];
      if (!record) throw new WorkflowError("NOT_FOUND", "找不到该申请。");
      if (record.currentStep !== stepId) {
        throw new WorkflowError("STEP_NOT_ALLOWED", "请先完成当前步骤。");
      }
      if (stepId === "scenario") {
        for (const [field, value] of Object.entries(REQUIRED_SCENARIO)) {
          if (input[field] !== value) {
            throw new WorkflowError("UNSUPPORTED_PATH", "当前原型仅支持中国护照、居住中国、赴冰岛旅游。不可推断其他路径的要求。");
          }
        }
        record.data.scenario = { ...REQUIRED_SCENARIO };
      } else if (stepId === "trip") {
        const { arrivalDate, departureDate } = input;
        if (!isIsoDate(arrivalDate) || !isIsoDate(departureDate) || arrivalDate >= departureDate) {
          throw new WorkflowError("INVALID_DATES", "请填写有效的入境和离境日期，且离境日期晚于入境日期。");
        }
        record.data.trip = { arrivalDate, departureDate };
      } else if (stepId === "review") {
        // The walkthrough ends here. No visa readiness claim is made while rules are pending.
      } else {
        throw new WorkflowError("UNKNOWN_STEP", "未知步骤。");
      }
      record.completedSteps.push(stepId);
      const index = STEPS.findIndex((step) => step.id === stepId);
      record.currentStep = STEPS[index + 1]?.id ?? null;
      if (!record.currentStep) record.status = "walkthrough_complete";
      record.updatedAt = new Date().toISOString();
      return publicState(record);
    });
  }
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
