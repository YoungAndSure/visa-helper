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
const resourceUri = "ui://visa-helper/application-v2.html";
const welcome = "你可以跟着页卡逐题回答，也可以直接在聊天里写出旅行计划，我们会根据你提供的信息查缺补漏。只说已经确定的安排即可。";

function reply(application, message = "") {
  const starting = !application || (application.status === "questions" && !Object.keys(application.answers ?? {}).length);
  const assistantGuidance = starting
    ? "Show the welcome message and wait for the user. Do not enumerate the questionnaire or ask the user to fill a second form in chat while the UI is open. If the user has already described a plan, extract the explicitly stated facts using questionCatalog and submit them before asking any follow-up."
    : "The UI and chat share the same answers. Do not repeat the questionnaire in chat. When the user supplies travel-plan text, save explicit facts and ask only for missing or ambiguous information. If the user is following the UI, let the card guide them.";
  return {
    content: [{ type: "text", text: starting ? welcome : message || "已读取申请状态。" }],
    structuredContent: { application, supportedPath: PATH, assistantGuidance },
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
  const server = new McpServer({ name: "visa-helper", version: "0.2.0" });

  registerAppResource(server, "visa-helper-ui", resourceUri, {}, async () => ({
    contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: widgetHtml }],
  }));

  registerAppTool(server, "open_visa_helper", {
    title: "Open Visa Helper",
    description: "Show the Visa Helper UI. For a generic request to apply for a visa, show the returned welcome message and wait. The user may follow one-question cards or write a travel plan in chat. Do not list the full questionnaire alongside the UI. If the user already provides a plan, create an application and save explicit facts. Rules cover only an unverified Iceland tourism simulation.",
    inputSchema: { applicationId: z.string().uuid().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { resourceUri } },
  }, async ({ applicationId }) => safely(async () => reply(applicationId ? await store.get(applicationId) : null)));

  server.registerTool("create_application", {
    title: "Start Iceland tourism visa checklist",
    description: "Use when a user naturally asks for help with an Iceland tourist visa. Create one simulated application for one person. Offer two text paths: answer one question at a time in the UI, or describe the whole travel plan in chat. If the user already described a plan, extract only clearly stated facts using questionCatalog option values, save them with submit_answers, and ask only for missing answers. Do not invent answers or request passport numbers or files.",
    inputSchema: {},
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async () => reply(await store.create(), "已开始准备材料清单。用户可在页卡逐题回答，也可在对话中一口气描述旅行计划；只追问尚缺的信息。"));

  server.registerTool("get_application", {
    title: "Get visa application",
    description: "Fetch the server-authoritative application state, current question group, or generated file-task queue.",
    inputSchema: { applicationId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ applicationId }) => safely(async () => reply(await store.get(applicationId))));

  server.registerTool("get_questions", {
    title: "Get current checklist questions",
    description: "Return the current question group and the full questionCatalog. In chat, ask only questions not already answered. The UI presents one question per card. Do not invent material-selection questions. An application must be created first.",
    inputSchema: { applicationId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ applicationId }) => safely(async () => reply(await store.get(applicationId))));

  server.registerTool("submit_answers", {
    title: "Save checklist answers",
    description: "Save structured answers explicitly stated in the user's text, including facts for later question groups when clearly stated. Use questionCatalog option values and YYYY-MM-DD dates only when unambiguous. Never infer missing facts. Returns remaining questions or the file-task queue. Existing answers may be corrected.",
    inputSchema: {
      applicationId: z.string().uuid(),
      answers: z.record(z.string()),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async ({ applicationId, answers }) => safely(async () =>
    reply(await store.submitAnswers(applicationId, answers), "已保存答案，并重新计算问题与任务。")));

  server.registerTool("get_task_queue", {
    title: "Get required file tasks",
    description: "Return the file tasks generated from completed checklist answers. Each task represents one file to prepare. The draft checklist is only for simulation.",
    inputSchema: { applicationId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ applicationId }) => safely(async () => {
    const application = await store.get(applicationId);
    if (application.status !== "tasks_ready") throw new WorkflowError("QUESTIONS_INCOMPLETE", "请先完成决策树问题，才能获取文件任务队列。");
    return reply(application);
  }));

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
