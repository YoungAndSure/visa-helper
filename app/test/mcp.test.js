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
    for (const name of ["open_visa_helper", "create_application", "get_application", "get_questions", "submit_answers"]) {
      assert.equal(tools.tools.find((tool) => tool.name === name)._meta?.ui?.resourceUri, undefined, `${name} must not load interview UI`);
    }
    const workspace = tools.tools.find((tool) => tool.name === "get_task_queue");
    assert.equal(workspace._meta.ui.resourceUri, "ui://visa-helper/task-workspace-v3.html");
    const resource = await client.readResource({ uri: workspace._meta.ui.resourceUri });
    assert.match(resource.contents[0].text, /全部材料/);

    const opened = await client.callTool({ name: "open_visa_helper", arguments: {} });
    assert.equal(opened.structuredContent.application, null);
    assert.equal(opened.structuredContent.nextAction.tool, "create_application");

    const created = await client.callTool({ name: "create_application", arguments: {} });
    assert.equal(created.structuredContent.nextAction.type, "answer_or_ask");
    assert.equal(created.structuredContent.nextAction.question.id, "nationality");
    const id = created.structuredContent.application.id;
    const premature = await client.callTool({ name: "get_task_queue", arguments: { applicationId: id } });
    assert.equal(premature.structuredContent.error.code, "QUESTIONS_INCOMPLETE");
    const questions = await client.callTool({ name: "get_questions", arguments: { applicationId: id } });
    assert.equal(questions.structuredContent.application.questionGroup.id, "basic");
    const partial = await client.callTool({ name: "submit_answers", arguments: { applicationId: id, answers: { nationality: "CN" } } });
    assert.equal(partial.structuredContent.nextAction.question.id, "residence");
    assert.equal(partial.structuredContent.nextAction.pendingCount, 8);
    const answered = await client.callTool({ name: "submit_answers", arguments: { applicationId: id, answers: {
      nationality: "CN", residence: "CN", applicationCity: "北京", destination: "IS",
      purpose: "tourism", arrivalDate: "2027-06-01", departureDate: "2027-06-10",
      ageGroup: "adult", otherSchengenCountries: "no",
    } } });
    assert.equal(answered.structuredContent.application.questionGroup.id, "adult");
    const leaf = await client.callTool({ name: "submit_answers", arguments: { applicationId: id, answers: { occupation: "employed" } } });
    assert.equal(leaf.structuredContent.nextAction.tool, "get_task_queue");
    assert.equal(leaf.structuredContent.application.taskCount, 12);
    assert.equal(leaf.structuredContent.application.tasks, undefined);
    const queue = await client.callTool({ name: "get_task_queue", arguments: { applicationId: id } });
    assert.equal(queue.structuredContent.application.status, "tasks_ready");
    assert.equal(queue.structuredContent.nextAction.type, "choose_task");
    assert.ok(queue._meta.application.tasks.some((task) => task.id === "employment_letter"));
    const started = await client.callTool({ name: "start_task", arguments: { applicationId: id, taskId: "employment_letter" } });
    assert.equal(started.structuredContent.nextAction.type, "work_on_task");
    assert.equal(started._meta.application.activeTask.id, "employment_letter");
    assert.equal(started._meta.application.activeTask.status, "in_progress");
  } finally {
    await client.close();
    await server.close();
  }
});
