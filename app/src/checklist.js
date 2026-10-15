import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import jsonLogic from "json-logic-js";

export const DEFAULT_CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "../config");
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,100}$/;

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
  const pack = readJson(join(configDir, "rules", `${version}.json`));
  if (pack.version !== version || !Array.isArray(pack.questionGroups) || !Array.isArray(pack.tasks) || !Array.isArray(pack.stopRules)) {
    throw new Error(`Invalid rule pack: ${version}`);
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
  return pack;
}

function applies(rule, answers) {
  return Boolean(jsonLogic.apply(rule ?? true, answers));
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function validateAnswerPatch(patch, version, configDir = DEFAULT_CONFIG_DIR) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length) throw new Error("请提供至少一个问题的答案。");
  const questions = new Map(loadRulePack(version, configDir).questionGroups.flatMap((group) => group.questions.map((q) => [q.id, q])));
  for (const [id, value] of Object.entries(patch)) {
    const question = questions.get(id);
    if (!question) throw new Error(`未知问题：${id}`);
    if (typeof value !== "string" || value.length > 120 || !value.trim()) throw new Error(`${question.title}：答案格式无效。`);
    if (question.type === "choice" && !question.options.some((option) => option.value === value)) throw new Error(`${question.title}：请使用给定选项。`);
    if (question.type === "date" && !isIsoDate(value)) throw new Error(`${question.title}：请填写 YYYY-MM-DD 格式的有效日期。`);
  }
}

export function evaluateChecklist(answers = {}, version = getActiveRuleVersion(), configDir = DEFAULT_CONFIG_DIR) {
  const pack = loadRulePack(version, configDir);
  for (const group of pack.questionGroups) {
    if (!applies(group.when, answers)) continue;
    if (group.questions.some((question) => answers[question.id] === undefined)) {
      return { status: "questions", group, questions: group.questions, tasks: [], notice: pack.notice };
    }
    for (const stop of pack.stopRules.filter((rule) => rule.afterGroup === group.id)) {
      if (applies(stop.when, answers)) {
        return {
          status: stop.status, reason: stop.reason,
          group: stop.status === "needs_correction" ? group : null,
          questions: stop.status === "needs_correction" ? group.questions : [],
          tasks: [], notice: pack.notice,
        };
      }
    }
  }
  const tasks = pack.tasks.filter((task) => applies(task.when, answers)).map(({ when, dependsOn, ...task }) => ({
    ...task, matchedConditions: dependsOn ?? [], status: "todo",
  }));
  const reviewNotes = (pack.reviewNotes ?? []).filter((note) => applies(note.when, answers)).map((note) => note.text);
  return { status: "tasks_ready", questions: [], tasks, reviewNotes, notice: pack.notice };
}
