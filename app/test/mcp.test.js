import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVisaServer } from "../src/server.js";
import { ApplicationStore } from "../src/workflow.js";

test("MCP exposes the UI and rejects an out-of-order step", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visa-helper-mcp-"));
  const server = createVisaServer(new ApplicationStore(join(dir, "applications.json")));
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const opener = tools.tools.find((tool) => tool.name === "open_visa_helper");
    assert.equal(opener._meta.ui.resourceUri, "ui://visa-helper/application-v1.html");
    const resource = await client.readResource({ uri: opener._meta.ui.resourceUri });
    assert.match(resource.contents[0].text, /Visa Helper/);

    const created = await client.callTool({ name: "create_application", arguments: {} });
    const id = created.structuredContent.application.id;
    const rejected = await client.callTool({ name: "submit_step", arguments: {
      applicationId: id,
      stepId: "trip",
      data: { arrivalDate: "2027-01-01", departureDate: "2027-01-10" },
    }});
    assert.equal(rejected.isError, true);
    assert.equal(rejected.structuredContent.error.code, "STEP_NOT_ALLOWED");
    const state = await client.callTool({ name: "get_application", arguments: { applicationId: id } });
    assert.equal(state.structuredContent.application.currentStep, "scenario");
  } finally {
    await client.close();
    await server.close();
  }
});
