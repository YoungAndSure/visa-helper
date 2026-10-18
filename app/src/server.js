import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { ApplicationStore, PATH, WorkflowError } from "./workflow.js";
import { advanceInputSchema, advanceOutputSchema, interviewReply } from "./interview.js";
import { APP_VERSION, WIDGET_HTML, UI_RESOURCE_URI, serverInfo, checkClient } from "./release.js";
import { advanceTaskInputSchema, TaskError } from "./tasks.js";
import { GuideLinks, createGuideHandler, renderGuideHtml } from "./form-guide.js";

const here = dirname(fileURLToPath(import.meta.url));
const defaultStore = new ApplicationStore(process.env.VISA_HELPER_DATA_FILE ?? join(here, "../data/applications.json"));
const defaultGuideLinks = new GuideLinks();
const resourceUri = UI_RESOURCE_URI;
const instructions = `Use advance_application as the ONLY interview/progress interface for both guided single-question answers and whole travel-plan descriptions. On first use call it with answers:{} and clientTools listing the Visa Helper tools YOU CAN ACTUALLY INVOKE, to obtain an application ID, revision and questionCatalog. Reuse that ID throughout; to resume, call with applicationId and OMIT answers, never send {} to read. get_server_info remains optional diagnostics. When supplying clientTools, list only tools you can actually invoke; never fabricate an inventory. If clientTools was omitted, compare returned serverInfo.requiredClientTools against your actual tool inventory before continuing. A not_checked result is not proof of compatibility. Missing tools must be reported with serverInfo version/build while preserving the application.
GPT owns natural-language understanding and the COMPLETE questionId-to-canonical-string answer map; MCP owns validation, persistence, decision-tree routing and nextAction. Offer a brief choice of answering one question at a time or describing a whole plan. No separate mode or workflow. Use questionCatalog IDs, option.value codes and unambiguous YYYY-MM-DD dates. Reuse every explicit fact from the conversation, including later branches, before asking anything. After each answer or paragraph update the COMPLETE map and submit it with applicationId and latest revision. This is full replacement: omitted fields are withdrawn, not retained. Keep unchanged facts; omit unknown/withdrawn facts. Use returned answers as the accepted baseline. Never invent an answer, treat silence as no, or change facts merely to match an option.
Read nextAction on EVERY response. ask: use known explicit information first, otherwise ask just its question in ChatGPT with its choices. Keep interview questions in ChatGPT; do not load an App questionnaire. repair: the submitted snapshot was NOT saved; repair encoding/format yourself only when meaning is unambiguous, keep all other intended answers and resubmit the COMPLETE corrected snapshot. Clarify ambiguity instead of guessing. clarify: resolve contradictions; for REVISION_CONFLICT reconcile the user's explicit changes onto returned latest answers/revision, never blindly overwrite. blocked: explain the reason and do not invent a checklist or bypass the tree's branch/else policy. Avoid automatic retry loops when no new information can resolve an action.
complete: follow nextAction.presentation and call the available get_task_queue display tool. This is presentation only, not another interview step. If unavailable, report the tool mismatch and preserve applicationId; never claim a checklist is visible from data alone. App UI is for the completed checklist and selected material guidance; do not duplicate the checklist in a long chat response. presentation.status loaded is confirmed by a matching App load receipt, not merely a successful tool call. When the user selects a material use start_task and help with only that task. These are actual application-preparation records; the supplied source still awaits official verification.
For a returned taskFlow, use advance_task to read/resume or submit its nextAction events with the latest TASK revision (separate from interview revision). data is the COMPLETE task data snapshot, not a patch. Keep user-confirmed facts, never invent missing fields; the fieldCatalog contains exact form locations and guidance. Show original PDF immediately if wanted, even without personal data. The user fills the original PDF themselves; the guide is not an official replacement form. Offer optional upload in ChatGPT OR private self-check with equal access to completion. Only submit REVIEW after actually reading the user's uploaded pages, recording coverage, every check and unresolved/unreadable findings; MCP stores your reported observations, not the attachment and not independent OCR verification. If file reading is unavailable, explain and offer self-check. Never assert regulatory approval. FINISH requires explicit user confirmation of filling, signing and relevant checks; do not infer consent from silence. EDIT reopens and clears confirmations; changes to interview facts also require rechecking. On conflicts read latest advance_task state before reconciling. Other material flows remain unimplemented.
nextAction.type open_url contains an expiring, prefilled read-only form-guide URL: open it using the current client's native browser tool (in Codex, open_in_codex with browser target and right placement), or present the exact clickable URL if opening is unavailable or the user prefers to open it themselves. Do not start another interview or change the task just to open a page. guidePresentation also supplies this URL on other task responses. A queued browser request is not evidence of a displayed page. If the link has expired, read advance_task without event or data to get a fresh URL.`;

function taskReply(application, { workingOnTask = false } = {}) {
  const nextAction = workingOnTask
    ? application.taskFlow?.nextAction ?? { type: "work_on_task", task: application.activeTask }
    : { type: "choose_task", recommendedTask: application.activeTask ?? application.tasks[0] };
  const message = workingOnTask ? `正在准备：${application.activeTask.title}。`
    : `材料清单共 ${application.tasks.length} 项。点击一项材料开始准备。`;
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { application, taskFlow: workingOnTask ? application.taskFlow : undefined, supportedPath: PATH, nextAction, assistantGuidance: instructions },
    _meta: { application },
  };
}

function failure(error) {
  if (!(error instanceof WorkflowError) && !(error instanceof TaskError)) throw error;
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

export function createVisaServer(store = defaultStore, guideLinks = defaultGuideLinks) {
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
      };
      const application = result._meta?.application ?? result.structuredContent?.application;
      const flow = result.structuredContent?.taskFlow ?? application?.taskFlow;
      const guideLink = flow ? guideLinks.create(application, flow) : null;
      const nextAction = guideLink && ["start_task", "advance_task"].includes(name) && ["prepare", "filling"].includes(flow.node)
        ? { type: "open_url", url: guideLink.url, expiresAt: guideLink.expiresAt, title: "申请表填写对照页",
          placement: "right", instruction: "在客户端内置浏览器打开，或将此链接交给用户自行打开。页面已整理已知信息及未知项目的填写说明。",
          taskAction: flow.nextAction }
        : result.structuredContent?.nextAction;
      const receipt = application?.uiReceipt;
      const presentation = application?.status === "tasks_ready" ? {
        status: receipt?.buildHash === info.buildHash && receipt?.uiSourceHash === info.ui.sourceHash
          && receipt?.applicationUpdatedAt === application.updatedAt ? "loaded" : "not_confirmed",
        receivedAt: receipt?.receivedAt ?? null,
      } : undefined;
      return { ...result, structuredContent: { ...result.structuredContent, nextAction, serverInfo: info, ...(presentation ? { presentation } : {}),
          ...(guideLink ? { guidePresentation: { ...guideLink, action: "open_in_client_browser", placement: "right" } } : {}) },
        _meta: { ...result._meta, serverInfo: info, ...(flow ? {
          guideLink, guideDocument: renderGuideHtml(flow),
        } : {}) } };
    });
  }

  server.registerResource("visa-helper-material-checklist", resourceUri, {}, async () => ({
    contents: [{ uri: resourceUri, mimeType: "text/html;profile=mcp-app", text: WIDGET_HTML,
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

  registerTool("get_task_queue", {
    title: "Show visa materials checklist",
    description: "Display a completed application's App checklist with clickable material tasks, or refresh its data from the App. Call only when advance_application returns complete. Does not collect answers or advance the interview.",
    inputSchema: z.object({ applicationId: z.string().uuid() }),
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { resourceUri, visibility: ["model", "app"] }, "openai/outputTemplate": resourceUri, "openai/widgetAccessible": true },
  }, async ({ applicationId }) => safely(async () => {
    const application = await store.get(applicationId);
    if (application.status !== "tasks_ready") throw new WorkflowError("QUESTIONS_INCOMPLETE", "请先在对话中补齐申请信息。");
    return taskReply(application);
  }));

  registerTool("start_task", {
    title: "Start preparing one material",
    description: "Select or resume a material task without resetting its progress. The Schengen PDF form returns its XState taskFlow, full field catalog, guide, optional self-check/upload branches and nextAction; continue with advance_task. Other tasks return original requirements only. Upload is optional; never demand a file to complete self-check.",
    inputSchema: { applicationId: z.string().uuid(), taskId: z.string().min(1) },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true },
  }, async ({ applicationId, taskId }) => safely(async () => taskReply(await store.startTask(applicationId, taskId), { workingOnTask: true })));

  registerTool("advance_task", {
    title: "Continue one material preparation task",
    description: "Read/resume with applicationId and taskId only. To save or advance, provide latest task revision and optionally COMPLETE data plus an event from nextAction.events. Only schengen_form is implemented. Returns field/check catalogs, printable guide and nextAction. Original form is always available; user fills it themselves. Upload review is optional, self-check can complete without personal fields or an attachment. Record REVIEW only after reading the user's file; findings are assistant-reported observations. FINISH requires explicit user filling/signing/check confirmations. EDIT clears old checks. Never substitute task revision for interview revision.",
    inputSchema: advanceTaskInputSchema,
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true },
  }, async (args) => safely(async () => {
    const result = await store.advanceTask(args);
    return { content: [{ type: "text", text: result.taskFlow.nextAction.title }],
      structuredContent: { ...result, nextAction: result.taskFlow.nextAction, assistantGuidance: instructions },
      _meta: { application: result.application } };
  }));

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
  if (defaultGuideLinks.baseUrl) {
    const guidePort = Number(process.env.VISA_HELPER_GUIDE_PORT ?? 8788);
    createServer(createGuideHandler(defaultStore, defaultGuideLinks)).listen(guidePort, host, () => {
      console.log(`Visa Helper read-only guide listener on port ${guidePort}`);
    });
  }
}
