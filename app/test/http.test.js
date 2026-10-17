import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createVisaServer } from "../src/server.js";
import { ApplicationStore } from "../src/workflow.js";

test("official HTTP handler runs the full-snapshot loop without a native form dependency", async () => {
  const root = await mkdtemp(join(tmpdir(), "visa-helper-http-"));
  const store = new ApplicationStore(join(root, "applications.json"));
  const handler = createMcpHandler(() => createVisaServer(store));
  let requestId = 0;
  async function call(name, args) {
    const response = await handler.fetch(new Request("http://localhost/mcp", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": name },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "http-test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }),
    }));
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const envelope = JSON.parse(text);
    assert.equal(envelope.error, undefined, text);
    return envelope.result;
  }
  try {
    const created = await call("advance_application", { answers: {} });
    const { applicationId, revision } = created.structuredContent;
    assert.equal(created.structuredContent.nextAction.questionId, "nationality");
    const result = await call("advance_application", { applicationId, revision, answers: {
      nationality: "CN", residence: "CN", applicationCity: "北京", destination: "IS", purpose: "tourism",
      arrivalDate: "2027-06-01", departureDate: "2027-06-10", ageGroup: "adult", otherSchengenCountries: "no", occupation: "employed",
    } });
    assert.equal(result.structuredContent.nextAction.type, "complete");
    assert.equal(result.structuredContent.nextAction.taskCount, 12);
    assert.notEqual(result.resultType, "input_required");
    const action = result.structuredContent.nextAction.presentation;
    const workspace = await call(action.tool, action.arguments);
    assert.equal(workspace._meta.application.tasks.length, 12);
    assert.equal(workspace.structuredContent.nextAction.type, "choose_task");
  } finally { await handler.close(); }
});
