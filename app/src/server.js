import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { ApplicationStore, PATH, WorkflowError } from "./workflow.js";
import { nativeFormAvailable, requestQuestion } from "./forms.js";

const here = dirname(fileURLToPath(import.meta.url));
const widgetHtml = readFileSync(join(here, "../public/application.html"), "utf8");
const defaultStore = new ApplicationStore(process.env.VISA_HELPER_DATA_FILE ?? join(here, "../data/applications.json"));
const resourceUri = "ui://visa-helper/material-checklist-v4.html";
const instructions = `Visa Helper has two stages. Interview entirely in the ChatGPT conversation; never load an App UI to ask decision-tree questions. Start with create_application. Briefly offer to guide the user one question at a time or accept a whole travel plan. Use ask_next_question to display each missing question in a native host form. Do not merely assume chat text creates a question card. If that tool reports native forms unavailable, explain once that this host lacks the form capability and continue in chat; do not claim a form was displayed.
MCP is authoritative for decision-tree progress. Read nextAction on every response. For a paragraph, extract explicitly stated facts with questionCatalog option values and call submit_answers. You may submit multiple known fields, including later groups. The server advances until it needs another fact or reaches a leaf. Keep using information already in the user's message before asking them anything else. Never invent answers, treat silence as no, or independently generate a checklist. Clarify ambiguous or contradictory information. Continue asking until the server reaches tasks_ready; do not stop after acknowledging a saved answer.
At a leaf, immediately call show_material_checklist, which renders the App task workspace. Do not call the removed open_visa_helper entry point. Follow with at most a short sentence telling the user to click a material to start. Do not copy the whole checklist or add a long explanatory essay to the chat. Task details and progress belong in the workspace. When a user selects a material, use start_task and help with that task only; use its checklist note as the source and do not claim a file was produced or a task completed. These are the user's actual application-preparation records. Source verification is separate: the supplied checklist has not yet been checked against current official requirements.`;

function reply(application, { workspace = false, workingOnTask = false } = {}) {
  let nextAction;
  let message;
  if (!application) {
    nextAction = { type: "call_tool", tool: "create_application", arguments: {} };
    message = "请先开始对话问答，再根据用户信息推进决策树。";
  } else if (application.status === "questions") {
    nextAction = { type: "answer_or_ask", question: application.nextQuestion, pendingCount: application.pendingQuestions.length,
      tool: "ask_next_question", arguments: { applicationId: application.id } };
    message = `下一题：${application.nextQuestion.title}`;
  } else if (application.status === "tasks_ready") {
    if (workingOnTask) {
      nextAction = { type: "work_on_task", task: application.activeTask };
      message = `正在准备：${application.activeTask.title}。`;
    } else if (workspace) {
      nextAction = { type: "choose_task", recommendedTask: application.activeTask ?? application.tasks[0] };
      message = `材料清单共 ${application.tasks.length} 项。点击一项材料开始准备。`;
    } else {
      nextAction = { type: "call_tool", tool: "show_material_checklist", arguments: { applicationId: application.id } };
      message = "决策树已到达叶子节点。下一步调用 show_material_checklist 展示材料工作台。";
    }
  } else {
    nextAction = { type: application.status === "needs_correction" ? "clarify" : "explain_blocker", reason: application.reason ?? application.notice };
    message = nextAction.reason;
  }
  // Keep the complete checklist in widget-only metadata so the model does not
  // duplicate the workspace with a long list in the conversation.
  const modelApplication = application?.status === "tasks_ready" ? {
    id: application.id, status: application.status, taskCount: application.tasks.length,
    activeTask: workingOnTask ? application.activeTask : undefined,
    notice: application.notice,
  } : application;
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { application: modelApplication, supportedPath: PATH, nextAction, assistantGuidance: instructions },
    ...(application?.status === "tasks_ready" ? { _meta: { application } } : {}),
  };
}

function failure(error) {
  if (!(error instanceof WorkflowError)) throw error;
  return {
    isError: true,
    content: [{ type: "text", text: error.message }],
    structuredContent: { error: { code: error.code, message: error.message } },
  };
}

async function safely(action) {
  try {
    return await action();
  } catch (error) {
    return failure(error);
  }
}

export function createVisaServer(store = defaultStore) {
  const server = new McpServer({ name: "visa-helper", version: "0.4.0" }, { instructions });

  server.registerResource("visa-helper-materials", resourceUri, {}, async () => ({
    contents: [{ uri: resourceUri, mimeType: "text/html;profile=mcp-app", text: widgetHtml,
      _meta: { ui: { prefersBorder: true }, "openai/ui": { preferredDisplayMode: "inline", availableDisplayModes: ["inline"] } } }],
  }));

  server.registerTool("create_application", {
    title: "Start Iceland tourism visa checklist",
    description: "Start application preparation for one person without opening App UI. Extract facts already provided using questionCatalog and call submit_answers. For missing facts call ask_next_question for a native question form. At a completed leaf call show_material_checklist. Current coverage is Chinese passport holders residing in China visiting Iceland for tourism; checklist source still needs official verification.",
    inputSchema: {},
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async () => reply(await store.create()));

  server.registerTool("get_application", {
    title: "Get visa application",
    description: "Fetch the server-authoritative application state, current question group, or generated file-task queue.",
    inputSchema: { applicationId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ applicationId }) => safely(async () => reply(await store.get(applicationId))));

  server.registerTool("get_questions", {
    title: "Get current checklist questions",
    description: "Read nextQuestion, pendingQuestions, and questionCatalog from the saved decision-tree state. No UI. Use facts from the conversation to answer first; only ask the user when a required fact is missing. Do not stop while unanswered questions remain.",
    inputSchema: { applicationId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ applicationId }) => safely(async () => reply(await store.get(applicationId))));

  server.registerTool("submit_answers", {
    title: "Save checklist answers",
    description: "Advance the server-side decision tree with answers explicitly provided by the user. Accepts one answer or a batch extracted from a paragraph, including known facts for later groups. Use questionCatalog option values and unambiguous YYYY-MM-DD dates. Follow returned nextAction: use any remaining known facts, ask missing information in ChatGPT, clarify conflicts, or immediately call get_task_queue at a leaf. No interview UI. Existing answers can be corrected.",
    inputSchema: {
      applicationId: z.string().uuid(),
      answers: z.record(z.string(), z.string()),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async ({ applicationId, answers }) => safely(async () =>
    reply(await store.submitAnswers(applicationId, answers))));

  server.registerTool("ask_next_question", {
    title: "Ask the next decision-tree question",
    description: "Display one missing question using the host's native form, save the answer, and return the next decision-tree action. Use only after extracting facts already provided by the user. If native forms are unavailable, returns an explicit chat fallback; never opens an App questionnaire. Declined forms remain unanswered.",
    inputSchema: z.object({ applicationId: z.string().uuid() }),
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async ({ applicationId }, context) => safely(async () => {
    const application = await store.get(applicationId);
    if (application.status !== "questions") return reply(application);
    if (!nativeFormAvailable(context)) {
      const result = reply(application);
      result.structuredContent.nextAction.type = "ask_in_chat";
      result.structuredContent.nativeForm = { supported: false, displayed: false,
        reason: "当前连接未声明原生表单能力；可在支持的 ChatGPT Work 网页或桌面端测试。" };
      return result;
    }
    const form = requestQuestion(context, application.nextQuestion);
    if ("resultType" in form) return form;
    if (form.action !== "accept") {
      const result = reply(application);
      result.structuredContent.nextAction.type = "wait_for_user";
      result.structuredContent.nativeForm = { supported: true, action: form.action };
      return result;
    }
    return reply(await store.submitAnswers(applicationId, { [application.nextQuestion.id]: form.content[application.nextQuestion.id] }));
  }));

  server.registerTool("show_material_checklist", {
    title: "Show my visa materials checklist",
    description: "At a completed decision-tree leaf, display the App checklist with clickable material tasks. Never call during the interview. After display, only briefly tell the user to click a material to begin; do not repeat the checklist in chat.",
    inputSchema: { applicationId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { resourceUri }, "openai/outputTemplate": resourceUri },
  }, async ({ applicationId }) => safely(async () => {
    const application = await store.get(applicationId);
    if (application.status !== "tasks_ready") throw new WorkflowError("QUESTIONS_INCOMPLETE", "请先完成决策树问题，才能获取文件任务队列。");
    return reply(application, { workspace: true });
  }));

  server.registerTool("get_task_queue", {
    title: "Read materials for the workspace",
    description: "Load a completed checklist for the App workspace. To display the checklist in chat use show_material_checklist instead.",
    inputSchema: z.object({ applicationId: z.string().uuid() }),
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
  }, async ({ applicationId }) => safely(async () => {
    const application = await store.get(applicationId);
    if (application.status !== "tasks_ready") throw new WorkflowError("QUESTIONS_INCOMPLETE", "请先在对话中补齐申请信息。");
    return { content: [], structuredContent: { application,
      nextAction: { type: "call_tool", tool: "show_material_checklist", arguments: { applicationId } } } };
  }));

  server.registerTool("start_task", {
    title: "Start preparing one material",
    description: "Select a file task from a completed checklist, save its in-progress state, and return its original checklist note. Help the user prepare only this selected material; do not invent requirements or claim completion without a file. Available from the task workspace and conversation.",
    inputSchema: { applicationId: z.string().uuid(), taskId: z.string().min(1) },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true },
  }, async ({ applicationId, taskId }) => safely(async () => reply(await store.startTask(applicationId, taskId), { workingOnTask: true })));

  return server;
}

export function createVisaHttpHandler(store = defaultStore) {
  return toNodeHandler(createMcpHandler(() => createVisaServer(store)));
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!["127.0.0.1", "::1", "localhost"].includes(host) &&
      !(host === "0.0.0.0" && process.env.VISA_HELPER_PRIVATE_CONTAINER === "1")) {
    throw new Error("This prototype has no user authentication and must listen on loopback only.");
  }
  const mcpHandler = createVisaHttpHandler();
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Visa Helper MCP App prototype");
      return;
    }
    if (url.pathname === "/mcp" && req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name",
        "Access-Control-Expose-Headers": "Mcp-Session-Id",
      }).end();
      return;
    }
    if (url.pathname === "/mcp" && ["POST", "GET", "DELETE"].includes(req.method)) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      try {
        await mcpHandler(req, res);
      } catch (error) {
        console.error("MCP request failed:", error);
        if (!res.headersSent) res.writeHead(500).end("Internal server error");
      }
      return;
    }
    res.writeHead(404).end("Not found");
  });
  httpServer.listen(port, host, () => {
    console.log(`Visa Helper MCP App listening on http://${host}:${port}/mcp`);
  });
}
