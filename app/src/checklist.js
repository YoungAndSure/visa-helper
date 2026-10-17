import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { runDecision, validateMachine } from "./decision-machine.js";

export const DEFAULT_CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "../config");
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,100}$/;
export const XSTATE_RULE_VERSION = "iceland-tourism-user-checklist-2025-03-06-xstate-1";
const LEGACY_RULE_VERSION = "iceland-tourism-user-checklist-2025-03-06-draft-1";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function getActiveRuleVersion(configDir = DEFAULT_CONFIG_DIR) {
  const { version } = readJson(join(configDir, "active.json"));
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) throw new Error("Invalid active rule version");
  return version;
}

export function loadRulePack(version, configDir = DEFAULT_CONFIG_DIR) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) throw new Error("Invalid rule version");
  const source = readFileSync(join(configDir, "rules", `${version}.json`), "utf8");
  let pack = JSON.parse(source);
  if (pack.version !== version || !Array.isArray(pack.questionGroups) || !Array.isArray(pack.tasks)) {
    throw new Error(`Invalid rule pack: ${version}`);
  }
  if (!pack.machine) {
    if (version !== LEGACY_RULE_VERSION) throw new Error(`No XState migration for rule version: ${version}`);
    const migrated = readJson(join(configDir, "rules", `${XSTATE_RULE_VERSION}.json`));
    const originalHash = createHash("sha256").update(source).digest("hex");
    if (migrated.legacyBridge?.version !== version || migrated.legacyBridge?.sha256 !== originalHash) throw new Error("Legacy rule pack changed; XState compatibility must be reviewed");
    const strip = ({ when, ...value }) => value;
    pack = { ...pack, engine: "xstate", machine: migrated.machine,
      questionGroups: pack.questionGroups.map(strip), tasks: pack.tasks.map(strip),
      reviewNotes: pack.reviewNotes.map((note, index) => ({ id: migrated.reviewNotes[index].id, text: note.text })) };
  }
  const questionIds = new Set();
  const groupIds = new Set();
  const taskIds = new Set();
  for (const group of pack.questionGroups) {
    if (!group.id || groupIds.has(group.id) || !Array.isArray(group.questions)) throw new Error(`Invalid question group in ${version}`);
    groupIds.add(group.id);
    for (const question of group.questions) {
      if (!question.id || questionIds.has(question.id) || !["choice", "text", "date"].includes(question.type)) throw new Error(`Invalid question in ${version}`);
      if (question.type === "choice" && (!Array.isArray(question.options) || !question.options.length)) throw new Error(`Missing options for ${question.id}`);
      questionIds.add(question.id);
    }
  }
  for (const task of pack.tasks) {
    if (!task.id || taskIds.has(task.id) || !task.title || !task.checklistItem) throw new Error(`Invalid file task in ${version}`);
    taskIds.add(task.id);
  }
  validateMachine(pack);
  return pack;
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function answerIssues(answers, version, configDir = DEFAULT_CONFIG_DIR) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return [{ code: "INVALID_SNAPSHOT", message: "answers 必须是问题 ID 到答案值的完整映射。" }];
  const questions = new Map(loadRulePack(version, configDir).questionGroups.flatMap((group) => group.questions.map((q) => [q.id, q])));
  const issues = [];
  for (const [id, value] of Object.entries(answers)) {
    const question = questions.get(id);
    if (!question) { issues.push({ questionId: id, code: "UNKNOWN_QUESTION", message: `未知问题：${id}` }); continue; }
    if (typeof value !== "string" || value.length > 120 || !value.trim()) {
      issues.push({ questionId: id, code: "INVALID_VALUE", message: `${question.title}：答案格式无效。` }); continue;
    }
    if (question.type === "choice" && !question.options.some((option) => option.value === value)) {
      issues.push({ questionId: id, code: "INVALID_OPTION", message: `${question.title}：请使用给定选项。`, options: question.options });
    }
    if (question.type === "date" && !isIsoDate(value)) issues.push({ questionId: id, code: "INVALID_DATE", message: `${question.title}：请填写 YYYY-MM-DD 格式的有效日期。` });
  }
  return issues;
}

export function validateAnswers(answers, version, configDir = DEFAULT_CONFIG_DIR) {
  const issues = answerIssues(answers, version, configDir);
  if (issues.length) throw new Error(issues[0].message);
}

export function evaluateChecklist(answers = {}, version = getActiveRuleVersion(), configDir = DEFAULT_CONFIG_DIR) {
  return runDecision(loadRulePack(version, configDir), answers).result;
}

export function evaluateChecklistWithTrace(answers = {}, version = getActiveRuleVersion(), configDir = DEFAULT_CONFIG_DIR) {
  return runDecision(loadRulePack(version, configDir), answers, { trace: true });
}
