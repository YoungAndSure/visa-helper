import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVisaServer } from "../src/server.js";
import { ApplicationStore } from "../src/workflow.js";

test("MCP exposes question groups and produces the file-task queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visa-helper-mcp-"));
  const server = createVisaServer(new ApplicationStore(join(dir, "applications.json")));
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "get_questions"));
    assert.ok(tools.tools.some((tool) => tool.name === "submit_answers"));
    assert.ok(tools.tools.some((tool) => tool.name === "get_task_queue"));
    const opener = tools.tools.find((tool) => tool.name === "open_visa_helper");
    assert.equal(opener._meta.ui.resourceUri, "ui://visa-helper/application-v2.html");
    const resource = await client.readResource({ uri: opener._meta.ui.resourceUri });
    assert.match(resource.contents[0].text, /文件任务队列/);

    const created = await client.callTool({ name: "create_application", arguments: {} });
    const id = created.structuredContent.application.id;
    const premature = await client.callTool({ name: "get_task_queue", arguments: { applicationId: id } });
    assert.equal(premature.structuredContent.error.code, "QUESTIONS_INCOMPLETE");
    const questions = await client.callTool({ name: "get_questions", arguments: { applicationId: id } });
    assert.equal(questions.structuredContent.application.questionGroup.id, "basic");
    const answered = await client.callTool({ name: "submit_answers", arguments: { applicationId: id, answers: {
      nationality: "CN", residence: "CN", applicationCity: "北京", destination: "IS",
      purpose: "tourism", arrivalDate: "2027-06-01", departureDate: "2027-06-10",
      ageGroup: "adult", otherSchengenCountries: "no",
    } } });
    assert.equal(answered.structuredContent.application.questionGroup.id, "adult");
    await client.callTool({ name: "submit_answers", arguments: { applicationId: id, answers: { occupation: "employed" } } });
    const queue = await client.callTool({ name: "get_task_queue", arguments: { applicationId: id } });
    assert.equal(queue.structuredContent.application.status, "tasks_ready");
    assert.ok(queue.structuredContent.application.tasks.some((task) => task.id === "employment_letter"));
  } finally {
    await client.close();
    await server.close();
  }
});
