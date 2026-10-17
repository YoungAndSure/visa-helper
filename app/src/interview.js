import { z } from "zod";

export const INTERVIEW_PROTOCOL_VERSION = "1.0";
const questionSchema = z.object({
  id: z.string(), title: z.string(), type: z.enum(["choice", "date", "text"]),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
}).passthrough();
const issueSchema = z.object({
  code: z.string(), message: z.string(), questionId: z.string().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
});

export const advanceInputSchema = z.object({
  applicationId: z.string().uuid().optional().describe("Omit to create. Supply to resume or replace this application's complete answers."),
  revision: z.number().int().nonnegative().optional().describe("Required when replacing an existing snapshot; use the latest returned revision."),
  answers: z.record(z.string(), z.string()).optional().describe("COMPLETE questionId → canonical string value snapshot, never a patch. Omitted with applicationId means read/resume; explicit {} withdraws all answers. Start with {} to obtain the question catalog."),
  clientTools: z.array(z.string().max(150)).max(100).optional().describe("Optional actual callable Visa Helper tool names for compatibility diagnostics; never fabricate an inventory."),
}).strict();

export const advanceOutputSchema = z.object({
  protocolVersion: z.literal(INTERVIEW_PROTOCOL_VERSION),
  applicationId: z.string().uuid().nullable(), revision: z.number().int().nonnegative(),
  ruleVersion: z.string(), saved: z.boolean(), status: z.string(),
  answers: z.record(z.string(), z.string()), questionCatalog: z.array(questionSchema),
  decision: z.object({ nodeId: z.string(), evaluationId: z.string().nullable() }).passthrough(),
  nextAction: z.discriminatedUnion("type", [
    z.object({ type: z.literal("ask"), questionId: z.string(), question: questionSchema }),
    z.object({ type: z.literal("repair"), issues: z.array(issueSchema), instruction: z.string() }),
    z.object({ type: z.literal("clarify"), code: z.string(), reason: z.string(), instruction: z.string() }),
    z.object({ type: z.literal("blocked"), code: z.string(), reason: z.string() }),
    z.object({ type: z.literal("complete"), taskCount: z.number().int(), presentation: z.object({
      tool: z.literal("get_task_queue"), arguments: z.object({ applicationId: z.string().uuid() }),
    }) }),
  ]),
  notice: z.string(), assistantGuidance: z.string(),
}).passthrough();

export function interviewReply({ application, saved, issues, conflict }, instructions) {
  let nextAction;
  if (conflict) nextAction = { type: "clarify", code: conflict.code, reason: conflict.message,
    instruction: "Use returned answers and revision as the latest baseline. Reconcile the user's explicit changes, then resubmit a COMPLETE snapshot. Do not blindly retry the stale snapshot or ask the user to repeat facts already known." };
  else if (issues?.length) nextAction = { type: "repair", issues,
    instruction: "No submitted answers were saved. Repair representation using the question catalog and facts already explicitly provided, then resubmit the COMPLETE intended snapshot. Never change a fact to fit an option or an else branch. If meaning is ambiguous, ask the user." };
  else if (application.status === "questions") nextAction = { type: "ask", questionId: application.nextQuestion.id, question: application.nextQuestion };
  else if (application.status === "tasks_ready") nextAction = { type: "complete", taskCount: application.tasks.length,
    presentation: { tool: "get_task_queue", arguments: { applicationId: application.id } } };
  else if (application.status === "needs_correction") nextAction = { type: "clarify", code: "CONTRADICTORY_ANSWERS", reason: application.reason,
    instruction: "Check the saved facts against the user's explicit information; correct a transcription error yourself, otherwise ask for clarification. Submit a COMPLETE corrected snapshot using the returned revision." };
  else nextAction = { type: "blocked", code: application.status.toUpperCase(), reason: application.reason ?? application.notice };
  const message = nextAction.type === "ask" ? `下一题：${nextAction.question.title}`
    : nextAction.type === "complete" ? "申请信息已齐全。请执行返回的清单展示动作，提示用户点击一项材料开始准备。"
    : nextAction.type === "repair" ? "本次问答未保存，请依据已有事实修正格式；含义不明确时再向用户澄清。"
    : nextAction.reason;
  return {
    content: [{ type: "text", text: message }],
    structuredContent: {
      protocolVersion: INTERVIEW_PROTOCOL_VERSION,
      applicationId: application.id, revision: application.revision, ruleVersion: application.ruleVersion,
      saved, status: application.status, answers: application.answers,
      questionCatalog: application.questionCatalog, decision: application.decision,
      nextAction, notice: application.notice, assistantGuidance: instructions,
    },
    ...(application.status === "tasks_ready" ? { _meta: { application } } : {}),
  };
}
