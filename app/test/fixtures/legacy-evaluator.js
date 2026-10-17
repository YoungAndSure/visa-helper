// Frozen 0.4.1 evaluator: used only as an independent migration oracle.
import { readFileSync } from "node:fs";
import jsonLogic from "json-logic-js";
export const legacyPack = JSON.parse(readFileSync(new URL("../../config/rules/iceland-tourism-user-checklist-2025-03-06-draft-1.json", import.meta.url), "utf8"));
const applies = (rule, answers) => Boolean(jsonLogic.apply(rule ?? true, answers));
export function evaluateLegacy(answers = {}) {
  const pack = legacyPack;
  for (const group of pack.questionGroups) {
    if (!applies(group.when, answers)) continue;
    if (group.questions.some((question) => answers[question.id] === undefined)) {
      return { status: "questions", group, questions: group.questions, tasks: [], notice: pack.notice };
    }
    for (const stop of pack.stopRules.filter((rule) => rule.afterGroup === group.id)) {
      if (applies(stop.when, answers)) return {
        status: stop.status, reason: stop.reason,
        group: stop.status === "needs_correction" ? group : null,
        questions: stop.status === "needs_correction" ? group.questions : [], tasks: [], notice: pack.notice,
      };
    }
  }
  return { status: "tasks_ready", questions: [],
    tasks: pack.tasks.filter((task) => applies(task.when, answers)).map(({ when, dependsOn, ...task }) => ({ ...task, matchedConditions: dependsOn ?? [], status: "todo" })),
    reviewNotes: pack.reviewNotes.filter((note) => applies(note.when, answers)).map((note) => note.text), notice: pack.notice };
}
