import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVisaServer } from "../src/server.js";
import { ApplicationStore } from "../src/workflow.js";

const removed = ["open_visa_helper", "create_application", "get_application", "get_questions", "submit_answers", "ask_next_question", "show_material_checklist"];
test("MCP exposes exactly six tools and rejects removed endpoints and resource aliases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visa-helper-mcp-"));
  const store = new ApplicationStore(join(dir, "applications.json"));
  const server = createVisaServer(store);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st); await client.connect(ct);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["advance_application", "advance_task", "get_server_info", "get_task_queue", "report_ui_ready", "start_task"]);
    for (const name of removed) await assert.rejects(client.callTool({ name, arguments: {} }), /not found|not exist|unknown/i);
    assert.deepEqual(await store.readAll(), {});
    const modelTools = tools.filter((t) => t._meta?.ui?.visibility?.includes("model") ?? true);
    assert.equal(modelTools.length, 5);
    assert.deepEqual(tools.find((t) => t.name === "report_ui_ready")._meta.ui.visibility, ["app"]);
    assert.equal(tools.find((t) => t.name === "advance_application")._meta?.ui?.resourceUri, undefined);
    const { resources } = await client.listResources();
    assert.deepEqual(resources.map((r) => r.uri), ["ui://visa-helper/material-checklist-v4.html"]);
    const resource = await client.readResource({ uri: resources[0].uri });
    assert.match(resource.contents[0].text, /全部材料/);
    assert.doesNotMatch(resource.contents[0].text, /模拟|恢复申请/);
    for (const uri of ["ui://visa-helper/application-v2.html", "ui://visa-helper/task-workspace-v3.html"]) {
      await assert.rejects(client.readResource({ uri }), /not found|not exist|unknown/i);
    }
  } finally { await client.close(); await server.close(); }
});
