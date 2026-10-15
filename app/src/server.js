import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { ApplicationStore, PATH, WorkflowError } from "./workflow.js";
import { nativeFormAvailable, requestQuestion } from "./forms.js";
import { APP_VERSION, WIDGET_HTML, UI_RESOURCE_URI, UI_ALIASES, serverInfo, checkClient } from "./release.js";

const here = dirname(fileURLToPath(import.meta.url));
const defaultStore = new ApplicationStore(process.env.VISA_HELPER_DATA_FILE ?? join(here, "../data/applications.json"));
const resourceUri = UI_RESOURCE_URI;
const instructions = `Before a new application, use get_server_info if available, passing clientTools containing the Visa Helper tool names YOU CAN ACTUALLY INVOKE. Never copy the server's required list as if it were your available tools. If the version tool itself is absent, use serverInfo in an existing tool response and compare its requiredClientTools with your own inventory. Missing flow tools must be reported with server version/build before continuing questions; never repeatedly claim Refresh worked or mistake a not_checked result for a successful check. Preserve the current application ID across a connection update.
Visa Helper has two stages. Interview entirely in the ChatGPT conversation; never load an App UI to ask decision-tree questions. Start with create_application. Briefly offer to guide the user one question at a time or accept a whole travel plan. Use ask_next_question to display each missing question in a native host form. Do not merely assume chat text creates a question card. If that tool reports native forms unavailable, explain once that this host lacks the form capability and continue in chat; do not claim a form was displayed.
MCP is authoritative for decision-tree progress. Read nextAction on every response. For a paragraph, extract explicitly stated facts with questionCatalog option values and call submit_answers. You may submit multiple known fields, including later groups. The server advances until it needs another fact or reaches a leaf. Keep using information already in the user's message before asking them anything else. Never invent answers, treat silence as no, or independently generate a checklist. Clarify ambiguous or contradictory information. Continue asking until the server reaches tasks_ready; do not stop after acknowledging a saved answer.
At a leaf, use get_task_queue if available, or its equivalent alias show_material_checklist. Only call tools actually in your inventory; if nextAction.tool is absent use an available nextAction.aliases entry. If neither is available, stop and report the mismatch while preserving the application. open_visa_helper remains a compatible conversation/status entry. Never claim the user sees a checklist solely because data returned. presentation.status is not_confirmed until the App reports a matching load receipt; loaded confirms the App received and rendered the checklist, not that the user has read it. Do not duplicate the checklist in chat. When the user selects a material, use start_task and help with only that task. These are actual application-preparation records; the supplied checklist source still awaits official verification.`;

function reply(application, { workspace = false, workingOnTask = false, includeTasks = false } = {}) {
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
      nextAction = { type: "call_tool", tool: "get_task_queue", arguments: { applicationId: application.id }, aliases: ["show_material_checklist"] };
      message = "决策树已到达叶子节点。下一步调用 get_task_queue 展示材料工作台。";
    }
  } else {
    nextAction = { type: application.status === "needs_correction" ? "clarify" : "explain_blocker", reason: application.reason ?? application.notice };
    message = nextAction.reason;
  }
  // Keep the complete checklist in widget-only metadata so the model does not
  // duplicate the workspace with a long list in the conversation.
  const modelApplication = application?.status === "tasks_ready" && !includeTasks ? {
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
  const server = new McpServer({ name: "visa-helper", version: APP_VERSION }, { instructions });
  const contracts = [];
  const currentInfo = () => serverInfo(contracts, store.configDir);
  server.releaseInfo = currentInfo;
  function registerTool(name, config, handler) {
    const inputSchema = typeof config.inputSchema?.safeParse === "function" ? config.inputSchema : z.object(config.inputSchema ?? {});
    contracts.push({ name, ...config, inputSchema: z.toJSONSchema(inputSchema) });
    return server.registerTool(name, { ...config, inputSchema }, async (...args) => {
      const result = await handler(...args);
      const info = currentInfo();
      const context = args[1];
      info.connection = {
        protocolVersion: context?.mcpReq.envelope?.["io.modelcontextprotocol/protocolVersion"] ?? server.server.getNegotiatedProtocolVersion() ?? "unknown",
        nativeFormsSupported: context ? nativeFormAvailable(context) : false,
      };
      if (result.resultType === "input_required") return { ...result, _meta: { ...result._meta, serverInfo: info } };
      const application = result._meta?.application ?? result.structuredContent?.application;
      const receipt = application?.uiReceipt;
      const presentation = application?.status === "tasks_ready" ? {
        status: receipt?.buildHash === info.buildHash && receipt?.uiSourceHash === info.ui.sourceHash
          && receipt?.applicationUpdatedAt === application.updatedAt ? "loaded" : "not_confirmed",
        receivedAt: receipt?.receivedAt ?? null,
      } : undefined;
      return { ...result, structuredContent: { ...result.structuredContent, serverInfo: info, ...(presentation ? { presentation } : {}) },
        _meta: { ...result._meta, serverInfo: info } };
    });
  }

  for (const uri of [resourceUri, ...UI_ALIASES]) server.registerResource(`visa-helper-${uri.split("/").pop()}`, uri, {}, async () => ({
    contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: WIDGET_HTML,
      _meta: { ui: { prefersBorder: true }, "openai/ui": { preferredDisplayMode: "inline", availableDisplayModes: ["inline"] } } }],
  }));

  registerTool("get_server_info", {
    title: "Check Visa Helper version and client tools",
    description: "Check runtime version, build fingerprint, tool-contract fingerprint, UI source fingerprint, and client compatibility BEFORE starting an application. Pass clientTools as the actual Visa Helper tool names exposed to you in this conversation, not the list from the server. Omitting it reports not_checked. This call never changes application data.",
    inputSchema: z.object({ clientTools: z.array(z.string().max(150)).max(100).optional(), clientUiHash: z.string().max(64).optional() }),
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true },
  }, async (args) => {
    const compatibility = checkClient(args);
    return { content: [{ type: "text", text: `Visa Helper ${APP_VERSION} · ${compatibility.message}` }],
      structuredContent: { compatibility, nextAction: { type: compatibility.status === "compatible" ? "continue" : "check_connection" } } };
  });

  registerTool("open_visa_helper", {
    title: "Read Visa Helper status (compatible entry)",
    description: "Stable compatible entry for older connections. Returns serverInfo even without an application ID; with an ID, returns the current decision-tree state and next action. Does not open a questionnaire. Use get_task_queue to display a completed checklist.",
    inputSchema: z.object({ applicationId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ applicationId }) => safely(async () => reply(applicationId ? await store.get(applicationId) : null)));

  registerTool("create_application", {
    title: "Start Iceland tourism visa checklist",
    description: "After checking client tool compatibility with get_server_info, start one application without opening App UI. Pass your actual clientTools if available so a mismatched connection is rejected before questions. Extract existing facts and submit_answers; use ask_next_question for missing facts and get_task_queue at a leaf. Covers Chinese passport holders residing in China visiting Iceland for tourism; source awaits official verification.",
    inputSchema: z.object({ clientTools: z.array(z.string().max(150)).max(100).optional() }),
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async (args) => safely(async () => {
    const compatibility = checkClient(args);
    if (compatibility.checked && compatibility.status !== "compatible") {
      const error = failure(new WorkflowError("CLIENT_TOOLS_MISMATCH", compatibility.message));
      error.structuredContent.compatibility = compatibility;
      return error;
    }
    const result = reply(await store.create());
    result.structuredContent.compatibility = compatibility;
    return result;
  }));

  registerTool("get_application", {
    title: "Get visa application",
    description: "Fetch the server-authoritative application state, current question group, or generated file-task queue.",
    inputSchema: { applicationId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ applicationId }) => safely(async () => reply(await store.get(applicationId))));

  registerTool("get_questions", {
    title: "Get current checklist questions",
    description: "Read nextQuestion, pendingQuestions, and questionCatalog from the saved decision-tree state. No UI. Use facts from the conversation to answer first; only ask the user when a required fact is missing. Do not stop while unanswered questions remain.",
    inputSchema: { applicationId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ applicationId }) => safely(async () => reply(await store.get(applicationId))));

  registerTool("submit_answers", {
    title: "Save checklist answers",
    description: "Advance the server-side decision tree with answers explicitly provided by the user. Accepts one answer or a batch extracted from a paragraph, including known facts for later groups. Use questionCatalog option values and unambiguous YYYY-MM-DD dates. Follow returned nextAction: use any remaining known facts, ask missing information in ChatGPT, clarify conflicts, or immediately call get_task_queue at a leaf. No interview UI. Existing answers can be corrected.",
    inputSchema: {
      applicationId: z.string().uuid(),
      answers: z.record(z.string(), z.string()),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async ({ applicationId, answers }) => safely(async () =>
    reply(await store.submitAnswers(applicationId, answers))));

  registerTool("ask_next_question", {
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

  registerTool("show_material_checklist", {
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

  registerTool("get_task_queue", {
    title: "Show visa materials checklist",
    description: "Stable checklist entry: display a completed application's App checklist with clickable material tasks. Also returns full data for older widgets. Never call during the interview. show_material_checklist is an equivalent alias, not a required follow-up call.",
    inputSchema: z.object({ applicationId: z.string().uuid() }),
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { resourceUri, visibility: ["model", "app"] }, "openai/outputTemplate": resourceUri, "openai/widgetAccessible": true },
  }, async ({ applicationId }) => safely(async () => {
    const application = await store.get(applicationId);
    if (application.status !== "tasks_ready") throw new WorkflowError("QUESTIONS_INCOMPLETE", "请先在对话中补齐申请信息。");
    return reply(application, { workspace: true, includeTasks: true });
  }));

  registerTool("start_task", {
    title: "Start preparing one material",
    description: "Select a file task from a completed checklist, save its in-progress state, and return its original checklist note. Help the user prepare only this selected material; do not invent requirements or claim completion without a file. Available from the task workspace and conversation.",
    inputSchema: { applicationId: z.string().uuid(), taskId: z.string().min(1) },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true },
  }, async ({ applicationId, taskId }) => safely(async () => reply(await store.startTask(applicationId, taskId), { workingOnTask: true })));

  registerTool("report_ui_ready", {
    title: "Confirm checklist loaded",
    description: "App-only receipt after the checklist DOM is rendered. Rejects a mismatched UI or server build. Data returned by a checklist tool alone is not proof of UI loading.",
    inputSchema: z.object({ applicationId: z.string().uuid(), uiSourceHash: z.string().length(64), buildHash: z.string().length(64), applicationUpdatedAt: z.string().optional() }),
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
  }, async ({ applicationId, uiSourceHash, buildHash, applicationUpdatedAt }) => safely(async () => {
    const info = currentInfo();
    if (uiSourceHash !== info.ui.sourceHash || buildHash !== info.buildHash) throw new WorkflowError("UI_VERSION_MISMATCH", "当前页面和服务端版本不一致，已停止材料操作。");
    return { content: [], structuredContent: { uiReceipt: await store.recordUiReady(applicationId, { uiSourceHash, buildHash }, applicationUpdatedAt) } };
  }));

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
    if (url.pathname === "/version" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(createVisaServer().releaseInfo()));
      return;
    }
    res.setHeader("X-Visa-Helper-Version", APP_VERSION);
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
