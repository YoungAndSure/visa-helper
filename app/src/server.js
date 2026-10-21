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
const instructions = `Use advance_application as the ONLY interview/progress interface for both grouped guided answers and whole travel-plan descriptions. On first use call it with answers:{} and clientTools listing the Visa Helper tools YOU CAN ACTUALLY INVOKE, to obtain an application ID, revision and questionCatalog. Reuse that ID throughout; to resume, call with applicationId and OMIT answers, never send {} to read. get_server_info remains optional diagnostics. When supplying clientTools, list only tools you can actually invoke; never fabricate an inventory. If clientTools was omitted, compare returned serverInfo.requiredClientTools against your actual tool inventory before continuing. A not_checked result is not proof of compatibility. Missing tools must be reported with serverInfo version/build while preserving the application.
GPT owns natural-language understanding and the COMPLETE questionId-to-canonical-string answer map; MCP owns validation, persistence, decision-tree routing and nextAction. Default to listing all unanswered questions in the current returned group together, so the user can answer in one message or describe a whole plan. Only use one-question mode when explicitly requested. No separate mode or workflow. Use questionCatalog IDs, option.value codes and unambiguous YYYY-MM-DD dates. Reuse every explicit fact from the conversation, including later branches, before asking anything. After each answer or paragraph update the COMPLETE map and submit it with applicationId and latest revision. This is full replacement: omitted fields are withdrawn, not retained. Keep unchanged facts; omit unknown/withdrawn facts. Use returned answers as the accepted baseline. Never invent an answer, treat silence as no, or change facts merely to match an option.
Read nextAction on EVERY response. ask: use known explicit information first, otherwise ask ALL nextAction.questions together as a numbered group in ChatGPT with their choices; accept partial replies, do not repeat accepted facts or ask inactive branches. Keep interview questions in ChatGPT; do not load an App questionnaire. repair: the submitted snapshot was NOT saved; repair encoding/format yourself only when meaning is unambiguous, keep all other intended answers and resubmit the COMPLETE corrected snapshot. Clarify ambiguity instead of guessing. clarify: resolve contradictions; for REVISION_CONFLICT reconcile the user's explicit changes onto returned latest answers/revision, never blindly overwrite. blocked: explain the reason and do not invent a checklist or bypass the tree's branch/else policy. Avoid automatic retry loops when no new information can resolve an action.
complete: follow nextAction.presentation and call the available get_task_queue display tool. This is presentation only, not another interview step. If unavailable, report the tool mismatch and preserve applicationId; never claim a checklist is visible from data alone. App UI is for the completed checklist and selected material guidance; do not duplicate the checklist in a long chat response. presentation.status loaded is confirmed by a matching App load receipt, not merely a successful tool call. When the user selects a material in chat use start_task (widget selections have already called it; read their background handoff) and immediately explain its current step and collect the missing information for only that task. When the user says wait, pause or wants another material, first save explicitly collected data via advance_task, then call start_task with action:pause, or select the other task; never mark a pause as completion. Resume with start_task using the same taskId. Keep source provenance and internal verification status in developer records; do not display internal source-audit commentary in the product. Never claim official verification or approval that has not occurred.
When a widget sends a short task action (for example 准备护照), use its visa-helper-task-context/1 background context for applicationId, taskId and nextAction. The widget already called MCP to select the task. Read advance_task using those references if more details are needed; do not reselect or restart the task, do not ask for internal IDs, and never echo IDs, tool instructions or background context into user-facing chat. Background context alone does not prove a new model turn ran. After chat-driven start/resume/pause, follow nextAction.presentation to render the App again: a selected task shows its own card and stage progress; paused or finished tasks show the full checklist with done/paused statuses. A widget-driven selection already updated that card; do not duplicate it. At nextAction choose_task, wait for the user to select the next material, never auto-start one.
For a returned taskFlow, use advance_task to read/resume or submit its nextAction events with the latest TASK revision (separate from interview revision). data is the COMPLETE task data snapshot, not a patch. Keep user-confirmed facts, never invent missing fields; the fieldCatalog defines the allowed task fields and their guidance. For policy form, keep the conversation in the filling step until the user explicitly says the original form is filled. Then use FILLED and offer the two review methods (if the same user reply already explicitly chooses private self-check, apply that choice without asking again); only after the user chooses private self-check use SELF_CHECK and ask its unanswered questions interactively. Do not show or ask the self-check checklist during HTML guidance, filling, review-method selection or optional upload. Never treat generated guide content as a filled original form. Show the original PDF immediately if wanted, even without personal data; the user fills it themselves and the guide is not an official replacement form. Offer optional upload in ChatGPT OR private self-check with equal access to completion. Only submit REVIEW after actually reading the user's uploaded pages, recording coverage, every check and unresolved/unreadable findings; MCP stores your reported observations, not the attachment and not independent OCR verification. If file reading is unavailable, explain and offer self-check. Never assert regulatory approval. FINISH requires explicit user confirmation and this task's completion conditions; filling and signing apply only to the form policy. Never infer consent from silence. EDIT reopens and clears confirmations; changes to interview facts also require rechecking. On conflicts read latest advance_task state before reconciling. Passport task passport supports private question-led self-check or optional photo review. Use checkCatalog questions to guide self-check, recording only explicit user confirmations. Passport data fields accept only issueDate and expiryDate; never store names, passport numbers, images or file URLs. Agent-extracted dates must be confirmed by the user (confirmedDetails). For assisted review, actually read the uploaded bio page before REVIEW, record documentRead/checks/findings, and ask the user to verify blank pages separately (checks.blank_pages); a bio-page image cannot prove this. automaticChecks compares dates with the confirmed itinerary; fail cannot be overridden by checked boxes. User self-check may complete without disclosing any dates. FINISH requires prepared:true explicitly confirmed by the user and the relevant checks; passport does not require filling or signing a form. All 25 configured Iceland checklist task IDs now have independent task instances. Reuse returned workflow, requirements, acquisition, fieldCatalog, checkCatalog, requiredCoverage and reviewInstructions; do not improvise requirements. Generic material data is a COMPLETE snapshot: fields (string values using catalog IDs), checks, prepared, confirmedDetails, rows (only for daily_itinerary), review null or {documentRead:true,coverage:[requiredCoverage IDs],checks,findings}. Do not reuse passport or form fields for another task. For assisted generic material completion, document checks must be in review.checks, user-only checks in data.checks, every requiredCoverage ID must actually have been read, and the user must confirm the observations and readiness. A photo cannot prove authenticity, recency, physical dimensions, complete original page count, institutional issuance or signatures; ask the user for such checks. SELF_CHECK remains possible without upload or personal fields. ACQUIRE enters guidance for obtaining actual third-party documents; READY returns to checks, never means an order, certification or payment was executed. Document tasks also allow GUIDE_READY for a partial HTML guide and FILLED when the real material is ready to check. daily_itinerary rows use date, location, plan, transport, accommodation; use confirmed facts only, unknown values stay missing. Templates are guides/drafts; employer/school/sponsor signatures or official certification still require the actual issuer. A task can finish by user inspection of an externally prepared document without storing it. Known failed automatic checks cannot be overridden with checkboxes.
nextAction.type open_url contains an expiring, prefilled read-only form-guide URL: open it using the current client's native browser tool (in Codex, open_in_codex with browser target and right placement), or present the exact clickable URL if opening is unavailable or the user prefers to open it themselves. Do not start another interview or change the task just to open a page. guidePresentation also supplies this URL on other task responses. A queued browser request is not evidence of a displayed page. If the link has expired, read advance_task without event or data to get a fresh URL.`;

function taskReply(application, { workingOnTask = false } = {}) {
  const nextAction = workingOnTask
    ? application.taskFlow?.nextAction ?? { type: "work_on_task", task: application.activeTask }
    : { type: "choose_task", recommendedTask: application.activeTask ?? application.tasks[0] };
  const message = workingOnTask ? `正在准备：${application.activeTask.title}。${application.taskFlow?.nextAction.guidance ?? ""}`
    : `材料清单共 ${application.tasks.length} 项。点击一项材料开始准备。`;
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { application, taskFlow: workingOnTask ? application.taskFlow : undefined, supportedPath: PATH, nextAction, assistantGuidance: instructions },
    _meta: { application },
  };
}

// Navigation references and the authoritative next step travel as background model
// context. The visible chat action never needs application IDs or tool instructions.
function taskHandoff(application, flow, nextAction) {
  if (application?.status !== "tasks_ready") return null;
  const taskId = flow?.taskId ?? nextAction?.pausedTaskId ?? nextAction?.completedTaskId ?? null;
  return { protocol: "visa-helper-task-context/1", applicationId: application.id,
    applicationUpdatedAt: application.updatedAt, workspace: application.activeTask ? "task" : "checklist",
    activeTaskId: application.activeTask?.id ?? null, taskId,
    taskTitle: application.tasks.find(({ id }) => id === taskId)?.title ?? null,
    taskRevision: flow?.revision ?? null, node: flow?.node ?? null, nextAction,
    ...(application.activeTask ? {} : { tasks: application.tasks.map(({ id, title, status }) => ({ id, title, status })) }) };
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
      let nextAction = guideLink && ["start_task", "advance_task"].includes(name) && ["prepare", "filling"].includes(flow.node)
        ? { type: "open_url", url: guideLink.url, expiresAt: guideLink.expiresAt, title: flow.document?.title ?? "填写指引与草稿",
          placement: "right", instruction: "在客户端内置浏览器打开，或将此链接交给用户自行打开。页面已整理已知信息及未知项目的填写说明。",
          taskAction: flow.nextAction }
        : result.structuredContent?.nextAction;
      if (name === "start_task" && application?.status === "tasks_ready") nextAction = { ...nextAction,
        presentation: { tool: "get_task_queue", arguments: { applicationId: application.id } } };
      const handoff = taskHandoff(application, flow, nextAction);
      const receipt = application?.uiReceipt;
      const presentation = application?.status === "tasks_ready" ? {
        status: receipt?.buildHash === info.buildHash && receipt?.uiSourceHash === info.ui.sourceHash
          && receipt?.applicationUpdatedAt === application.updatedAt ? "loaded" : "not_confirmed",
        receivedAt: receipt?.receivedAt ?? null,
      } : undefined;
      return { ...result, structuredContent: { ...result.structuredContent, nextAction, serverInfo: info, ...(presentation ? { presentation } : {}),
          ...(handoff ? { handoff } : {}),
          ...(guideLink ? { guidePresentation: { ...guideLink, action: "open_in_client_browser", placement: "right" } } : {}) },
        _meta: { ...result._meta, serverInfo: info, ...(flow?.guide && flow.document ? {
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
    description: "Single interview interface. First call answers:{} plus clientTools listing actual callable Visa Helper tools to check compatibility, create and receive the FULL questionCatalog (questions, types, canonical options). Resume with applicationId and OMIT answers. For a single reply OR a paragraph, organize all explicit facts into the COMPLETE answers map and submit with applicationId and latest revision. Missing keys withdraw prior answers. Returns authoritative answers, revision and typed nextAction: ask (ALL unanswered questions in the current group, with options; present them together by default), repair, clarify, blocked or complete. Correct representation without asking again only when already stated facts are unambiguous. At complete follow the returned presentation action; no App UI during questions.",
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
    description: "Display a completed application's material workspace: the selected task card with stage progress, or the full checklist when no task is active. Also refreshes App data. Use after the interview is complete and on returned presentation actions. Does not collect answers or advance the interview.",
    inputSchema: z.object({ applicationId: z.string().uuid() }),
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { resourceUri, visibility: ["model", "app"] }, "openai/outputTemplate": resourceUri, "openai/widgetAccessible": true },
  }, async ({ applicationId }) => safely(async () => {
    const application = await store.get(applicationId);
    if (application.status !== "tasks_ready") throw new WorkflowError("QUESTIONS_INCOMPLETE", "请先在对话中补齐申请信息。");
    return taskReply(application, { workingOnTask: Boolean(application.activeTask) });
  }));

  registerTool("start_task", {
    title: "Start preparing one material",
    description: "Select/resume a material without resetting progress, or action:pause when the user says wait/pause. Switching to another material automatically pauses the unfinished active task. Pause preserves its node, saved data and checks. Read returned requirements and nextAction, then immediately guide the user through THIS material in chat. Every configured Iceland material has optional self-check/upload branches; continue with advance_task. Save collected task data via advance_task before pausing. Upload is optional.",
    inputSchema: { applicationId: z.string().uuid(), taskId: z.string().min(1), action: z.enum(["start", "pause"]).optional() },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true },
  }, async ({ applicationId, taskId, action }) => safely(async () => {
    const application = await store.startTask(applicationId, taskId, action);
    const result = taskReply(application, { workingOnTask: action !== "pause" });
    if (action === "pause") {
      result.content = [{ type: "text", text: "已暂停并保留当前材料的准备进度，可以选择其他材料，之后再继续。" }];
      result.structuredContent.nextAction = { type: "choose_task", pausedTaskId: taskId };
    }
    return result;
  }));

  registerTool("advance_task", {
    title: "Continue one material preparation task",
    description: "Read/resume with applicationId and taskId only. To save or advance, provide latest task revision and optionally COMPLETE data plus an event from nextAction.events. All configured Iceland checklist task IDs are implemented via shared workflows and task-specific policies. Read taskFlow for requirements, acquisition, catalogs, requiredCoverage, reviewInstructions, automaticChecks and nextAction. Generic material snapshots: fields, checks, prepared, confirmedDetails, rows (itinerary only), review:null or {documentRead:true,coverage:[catalog IDs],checks,findings}. Required document checks go in review.checks and user-only checks in data.checks. ACQUIRE/READY guide actual external preparation; they do not execute bookings or certification. GUIDE_READY/FILLED are available for HTML drafting workflows. Passport data: fields {issueDate?,expiryDate?} in YYYY-MM-DD, checks keyed by checkCatalog IDs, prepared boolean, confirmedDetails boolean, review null or {documentRead:true,checks,findings}. For passport FINISH requires explicit readiness and checks, not form filling/signing; extracted dates require user confirmation; blank pages require user inspection. For form tasks the original PDF is always available and filled by the user. Upload review is optional, self-check can complete without personal fields or an attachment. Record REVIEW only after reading the user's file; findings are assistant-reported observations. For schengen_form FINISH requires explicit user filling/signing/check confirmations. EDIT clears old checks. Never substitute task revision for interview revision.",
    inputSchema: advanceTaskInputSchema,
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true },
  }, async (args) => safely(async () => {
    const result = await store.advanceTask(args);
    const nextAction = result.taskFlow.status === "done" ? { type: "choose_task", completedTaskId: args.taskId,
      presentation: { tool: "get_task_queue", arguments: { applicationId: args.applicationId } },
      instruction: "The material is complete. Show the full checklist with saved done/paused statuses. Let the user choose; do not start another task automatically." }
      : result.taskFlow.nextAction;
    return { content: [{ type: "text", text: result.taskFlow.nextAction.title }],
      structuredContent: { ...result, nextAction, assistantGuidance: instructions },
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
