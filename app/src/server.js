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
const resourceUri = "ui://visa-helper/application-v1.html";

function reply(application, message = "") {
  return {
    content: message ? [{ type: "text", text: message }] : [],
    structuredContent: { application, supportedPath: PATH },
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
  const server = new McpServer({ name: "visa-helper", version: "0.1.0" });

  registerAppResource(server, "visa-helper-ui", resourceUri, {}, async () => ({
    contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: widgetHtml }],
  }));

  registerAppTool(server, "open_visa_helper", {
    title: "Open Visa Helper",
    description: "Open the Visa Helper application UI. Shows the supported Iceland tourism prototype path. Does not assert current visa requirements.",
    inputSchema: { applicationId: z.string().uuid().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { resourceUri } },
  }, async ({ applicationId }) => safely(async () => reply(applicationId ? await store.get(applicationId) : null)));

  server.registerTool("create_application", {
    title: "Create visa application",
    description: "Create a Visa Helper application for the China-passport, China-resident, Iceland-tourism prototype path. No official visa rules are active yet.",
    inputSchema: {},
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async () => reply(await store.create(), "已创建申请。请在界面中确认申请场景。"));

  server.registerTool("get_application", {
    title: "Get visa application",
    description: "Fetch the server-authoritative state and next allowed step of an existing Visa Helper application.",
    inputSchema: { applicationId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ applicationId }) => safely(async () => reply(await store.get(applicationId))));

  server.registerTool("submit_step", {
    title: "Submit application step",
    description: "Submit only the current step. The server validates order and values and returns the next allowed step. This prototype does not accept passport numbers or files.",
    inputSchema: {
      applicationId: z.string().uuid(),
      stepId: z.enum(["scenario", "trip", "review"]),
      data: z.object({
        nationality: z.string().optional(),
        residence: z.string().optional(),
        destination: z.string().optional(),
        purpose: z.string().optional(),
        arrivalDate: z.string().optional(),
        departureDate: z.string().optional(),
      }),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  }, async ({ applicationId, stepId, data }) => safely(async () =>
    reply(await store.submit(applicationId, stepId, data), "已保存当前步骤。")));

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
