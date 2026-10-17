import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { ApplicationStore, PATH, WorkflowError } from "./workflow.js";
import { nativeFormAvailable, requestQuestion } from "./forms.js";
import { advanceInputSchema, advanceOutputSchema, interviewReply } from "./interview.js";
import { APP_VERSION, WIDGET_HTML, UI_RESOURCE_URI, UI_ALIASES, serverInfo, checkClient } from "./release.js";

const here = dirname(fileURLToPath(import.meta.url));
const defaultStore = new ApplicationStore(process.env.VISA_HELPER_DATA_FILE ?? join(here, "../data/applications.json"));
const resourceUri = UI_RESOURCE_URI;
const instructions = `Use advance_application as the ONLY interview/progress interface for both guided single-question answers and whole travel-plan descriptions. On first use call it with answers:{} and clientTools listing the Visa Helper tools YOU CAN ACTUALLY INVOKE, to obtain an application ID, revision and questionCatalog. Reuse that ID throughout; to resume, call with applicationId and OMIT answers, never send {} to read. No need to call separate create/get_questions/submit/ask tools. Those are legacy compatibility tools. get_server_info remains optional diagnostics. When supplying clientTools, list only tools you can actually invoke; never fabricate an inventory. If clientTools was omitted, compare returned serverInfo.requiredClientTools against your actual tool inventory before continuing. A not_checked result is not proof of compatibility. Missing tools must be reported with serverInfo version/build while preserving the application.
GPT owns natural-language understanding and the COMPLETE questionId-to-canonical-string answer map; MCP owns validation, persistence, decision-tree routing and nextAction. Offer a brief choice of answering one question at a time or describing a whole plan. No separate mode or workflow. Use questionCatalog IDs, option.value codes and unambiguous YYYY-MM-DD dates. Reuse every explicit fact from the conversation, including later branches, before asking anything. After each answer or paragraph update the COMPLETE map and submit it with applicationId and latest revision. This is full replacement: omitted fields are withdrawn, not retained. Keep unchanged facts; omit unknown/withdrawn facts. Use returned answers as the accepted baseline. Never invent an answer, treat silence as no, or change facts merely to match an option.
Read nextAction on EVERY response. ask: use known explicit information first, otherwise ask just its question in ChatGPT with its choices. Do not load an App questionnaire or call legacy ask_next_question. repair: the submitted snapshot was NOT saved; repair encoding/format yourself only when meaning is unambiguous, keep all other intended answers and resubmit the COMPLETE corrected snapshot. Clarify ambiguity instead of guessing. clarify: resolve contradictions; for REVISION_CONFLICT reconcile the user's explicit changes onto returned latest answers/revision, never blindly overwrite. blocked: explain the reason and do not invent a checklist or bypass the tree's branch/else policy. Avoid automatic retry loops when no new information can resolve an action.
complete: follow nextAction.presentation and call the available get_task_queue display tool. This is presentation only, not another interview step. If unavailable, report the tool mismatch and preserve applicationId; never claim a checklist is visible from data alone. App UI is only for the completed material checklist; do not duplicate materials in a long chat response. presentation.status loaded is confirmed by a matching App load receipt, not merely a successful tool call. When the user selects a material use start_task and help with only that task. These are actual application-preparation records; the supplied source still awaits official verification.`;

function reply(application, { workspace = false, workingOnTask = false, includeTasks = false } = {}) {
  let nextAction;
  let message;
  if (!application) {
    nextAction = { type: "call_tool", tool: "advance_application", arguments: { answers: {} } };
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
    decision: application.decision,
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
    structuredContent: { error: { code: error.code, message: error.message },
      nextAction: { type: "blocked", code: error.code, reason: error.message } },
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

  registerTool("advance_application", {
    title: "Advance visa application with complete answers",
    description: "Single interview interface. First call answers:{} plus clientTools listing actual callable Visa Helper tools to check compatibility, create and receive the FULL questionCatalog (questions, types, canonical options). Resume with applicationId and OMIT answers. For a single reply OR a paragraph, organize all explicit facts into the COMPLETE answers map and submit with applicationId and latest revision. Missing keys withdraw prior answers. Returns authoritative answers, revision and typed nextAction: ask, repair, clarify, blocked or complete. Correct representation without asking again only when already stated facts are unambiguous. At complete follow the returned presentation action; no App UI during questions.",
    inputSchema: advanceInputSchema, outputSchema: advanceOutputSchema,
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
  }, async (args) => safely(async () => {
    const compatibility = checkClient(args);
    if (compatibility.checked && compatibility.status !== "compatible") {
      const result = failure(new WorkflowError("CLIENT_TOOLS_MISMATCH", compatibility.message));
      result.structuredContent.compatibility = compatibility;
      return result;
    }
    const result = interviewReply(await store.advance(args), instructions);
    result.structuredContent.compatibility = compatibility;
    return result;
  }));

  registerTool("open_visa_helper", {
    title: "Read Visa Helper status (compatible entry)",
    description: "Legacy compatible status entry. For new interviews and resuming use advance_application; do not start a separate legacy questionnaire. Returns serverInfo without opening App UI.",
    inputSchema: z.object({ applicationId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ applicationId }) => safely(async () => reply(applicationId ? await store.get(applicationId) : null)));

  registerTool("create_application", {
    title: "Start Iceland tourism visa checklist",
    description: "Legacy compatibility only; new interviews use advance_application. After checking client tool compatibility with get_server_info, start one application without opening App UI. Pass your actual clientTools if available so a mismatched connection is rejected before questions. Extract existing facts and submit_answers; use ask_next_question for missing facts and get_task_queue at a leaf. Covers Chinese passport holders residing in China visiting Iceland for tourism; source awaits official verification.",
    inputSchema: z.object({ clientTools: z.array(z.string().max(150)).max(100).optional() }),
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { visibility: ["app"] } },
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
    description: "Legacy compatibility only; new interviews use advance_application. Fetch the server-authoritative application state, current question group, or generated file-task queue.",
    inputSchema: { applicationId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { visibility: ["app"] } },
  }, async ({ applicationId }) => safely(async () => reply(await store.get(applicationId))));

  registerTool("get_questions", {
    title: "Get current checklist questions",
    description: "Legacy compatibility only; new interviews use advance_application. Read nextQuestion, pendingQuestions, and questionCatalog from the saved decision-tree state. No UI. Use facts from the conversation to answer first; only ask the user when a required fact is missing. Do not stop while unanswered questions remain.",
    inputSchema: { applicationId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { visibility: ["app"] } },
  }, async ({ applicationId }) => safely(async () => reply(await store.get(applicationId))));

  registerTool("submit_answers", {
    title: "Save checklist answers",
    description: "Legacy compatibility only; new interviews use advance_application. Advance the server-side decision tree with answers explicitly provided by the user. Accepts one answer or a batch extracted from a paragraph, including known facts for later groups. Use questionCatalog option values and unambiguous YYYY-MM-DD dates. Follow returned nextAction: use any remaining known facts, ask missing information in ChatGPT, clarify conflicts, or immediately call get_task_queue at a leaf. No interview UI. Existing answers can be corrected.",
    inputSchema: {
      applicationId: z.string().uuid(),
      answers: z.record(z.string(), z.string()),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { visibility: ["app"] } },
  }, async ({ applicationId, answers }) => safely(async () =>
    reply(await store.submitAnswers(applicationId, answers))));

  registerTool("ask_next_question", {
    title: "Ask the next decision-tree question",
    description: "Legacy compatibility only; new interviews use advance_application. Display one missing question using the host's native form, save the answer, and return the next decision-tree action. Use only after extracting facts already provided by the user. If native forms are unavailable, returns an explicit chat fallback; never opens an App questionnaire. Declined forms remain unanswered.",
    inputSchema: z.object({ applicationId: z.string().uuid() }),
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { visibility: ["app"] } },
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
