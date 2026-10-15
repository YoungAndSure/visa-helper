import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ApplicationStore, PATH, WorkflowError } from "./workflow.js";

const here = dirname(fileURLToPath(import.meta.url));
const widgetHtml = readFileSync(join(here, "../public/application.html"), "utf8");
const defaultStore = new ApplicationStore(process.env.VISA_HELPER_DATA_FILE ?? join(here, "../data/applications.json"));
const resourceUri = "ui://visa-helper/task-workspace-v3.html";
const instructions = `Visa Helper has two stages. Interview entirely in the ChatGPT conversation; never load an App UI to ask decision-tree questions. Start with create_application. Briefly offer to guide the user one question at a time or accept a whole travel plan, then ask the returned nextQuestion. Use the host's native question presentation if available, otherwise ordinary chat.
MCP is authoritative for decision-tree progress. Read nextAction on every response. For a paragraph, extract explicitly stated facts with questionCatalog option values and call submit_answers. You may submit multiple known fields, including later groups. The server advances until it needs another fact or reaches a leaf. Keep using information already in the user's message before asking them anything else. Never invent answers, treat silence as no, or independently generate a checklist. Clarify ambiguous or contradictory information. Continue asking until the server reaches tasks_ready; do not stop after acknowledging a saved answer.
At a leaf, immediately call get_task_queue, which renders the App task workspace. Follow with at most a short sentence telling the user to click a material to start. Do not copy the whole checklist or add a long explanatory essay to the chat. Task details and progress belong in the workspace. When a user selects a material, use start_task and help with that task only; use its checklist note as the source and do not claim a file was produced or a task completed.`;

function reply(application, { workspace = false, workingOnTask = false } = {}) {
  let nextAction;
  let message;
  if (!application) {
    nextAction = { type: "call_tool", tool: "create_application", arguments: {} };
    message = "请先开始对话问答，再根据用户信息推进决策树。";
  } else if (application.status === "questions") {
    nextAction = { type: "answer_or_ask", question: application.nextQuestion, pendingCount: application.pendingQuestions.length };
    message = `下一题：${application.nextQuestion.title}`;
  } else if (application.status === "tasks_ready") {
    if (workingOnTask) {
      nextAction = { type: "work_on_task", task: application.activeTask };
      message = `正在准备：${application.activeTask.title}。`;
    } else if (workspace) {
      nextAction = { type: "choose_task", recommendedTask: application.activeTask ?? application.tasks[0] };
      message = `材料清单共 ${application.tasks.length} 项。点击一项材料开始准备。`;
    } else {
      nextAction = { type: "call_tool", tool: "get_task_queue", arguments: { applicationId: application.id } };
      message = "决策树已到达叶子节点。下一步调用 get_task_queue 展示材料工作台。";
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
  const server = new McpServer({ name: "visa-helper", version: "0.3.0" }, { instructions });

  registerAppResource(server, "visa-helper-ui", resourceUri, {}, async () => ({
    contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: widgetHtml }],
  }));

  server.registerTool("open_visa_helper", {
    title: "Resume Visa Helper conversation",
    description: "Compatibility entry point for conversation only; does not display UI. Prefer create_application to start a visa request. An existing application returns nextAction: continue the interview, or call get_task_queue once the decision tree is complete.",
    inputSchema: { applicationId: z.string().uuid().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ applicationId }) => safely(async () => reply(applicationId ? await store.get(applicationId) : null)));

  server.registerTool("create_application", {
    title: "Start Iceland tourism visa checklist",
    description: "Start a visa request for one person without opening UI. Interview in ChatGPT: offer step-by-step questions or a free-form travel plan. Extract facts already provided using questionCatalog and call submit_answers; ask nextQuestion only if the user's message lacks its answer. Continue until nextAction tells you to show the final checklist. Current rules simulate China-resident Chinese passport holders visiting Iceland for tourism.",
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
      answers: z.record(z.string()),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async ({ applicationId, answers }) => safely(async () =>
    reply(await store.submitAnswers(applicationId, answers))));

  registerAppTool(server, "get_task_queue", {
    title: "Show materials task workspace",
    description: "At a completed decision-tree leaf, display the App checklist with clickable material tasks. Never call during the interview. After display, only briefly tell the user to click a material to begin; do not repeat the checklist in chat.",
    inputSchema: { applicationId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { resourceUri } },
  }, async ({ applicationId }) => safely(async () => {
    const application = await store.get(applicationId);
    if (application.status !== "tasks_ready") throw new WorkflowError("QUESTIONS_INCOMPLETE", "请先完成决策树问题，才能获取文件任务队列。");
    return reply(application, { workspace: true });
  }));

  server.registerTool("start_task", {
    title: "Start preparing one material",
    description: "Select a file task from a completed checklist, save its in-progress state, and return its original checklist note. Help the user prepare only this selected material; do not invent requirements or claim completion without a file. Available from the task workspace and conversation.",
    inputSchema: { applicationId: z.string().uuid(), taskId: z.string().min(1) },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async ({ applicationId, taskId }) => safely(async () => reply(await store.startTask(applicationId, taskId), { workingOnTask: true })));

  return server;
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!["127.0.0.1", "::1", "localhost"].includes(host) &&
      !(host === "0.0.0.0" && process.env.VISA_HELPER_PRIVATE_CONTAINER === "1")) {
    throw new Error("This prototype has no user authentication and must listen on loopback only.");
  }
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
        "Access-Control-Allow-Headers": "content-type, mcp-session-id",
        "Access-Control-Expose-Headers": "Mcp-Session-Id",
      }).end();
      return;
    }
    if (url.pathname === "/mcp" && ["POST", "GET", "DELETE"].includes(req.method)) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      const server = createVisaServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => { transport.close(); server.close(); });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
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
