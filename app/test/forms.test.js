import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createVisaServer } from "../src/server.js";
import { ApplicationStore } from "../src/workflow.js";

test("native forms round-trip through the official HTTP handler and advance the saved tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "visa-helper-forms-"));
  const store = new ApplicationStore(join(root, "applications.json"));
  const handler = createMcpHandler(() => createVisaServer(store));
  let requestId = 0;
  async function call(name, args, inputResponses) {
    const response = await handler.fetch(new Request("http://localhost/mcp", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": name },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: {
        name, arguments: args, ...(inputResponses ? { inputResponses } : {}),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "native-form-test-host", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} }, extensions: { "openai/elicitation": { form: {} } } },
        },
      } }),
    }));
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const envelope = JSON.parse(text);
    assert.equal(envelope.error, undefined, text);
    return envelope.result;
  }
  try {
    const created = await call("create_application", {});
    const applicationId = created.structuredContent.application.id;
    let state = created;
    const answers = {
      nationality: "CN", residence: "CN", applicationCity: "北京", destination: "IS", purpose: "tourism",
      arrivalDate: "2027-06-01", departureDate: "2027-06-10", ageGroup: "adult", otherSchengenCountries: "no", occupation: "employed",
    };
    const asked = [];
    while (state.structuredContent.application.status === "questions") {
      const question = state.structuredContent.application.nextQuestion;
      const requested = await call("ask_next_question", { applicationId });
      assert.equal(requested.resultType, "input_required");
      const key = `answer_${question.id}`;
      const form = requested.inputRequests[key].params;
      assert.equal(form.mode, "form");
      const schema = form._meta["openai/elicitation"].requestedSchema;
      assert.deepEqual(Object.keys(schema.properties), [question.id]);
      if (question.type === "choice") assert.equal(schema.properties[question.id].oneOf[0].title, question.options[0].label);
      if (!asked.length) {
        const cancelled = await call("ask_next_question", { applicationId }, { [key]: { action: "cancel" } });
        assert.equal(cancelled.structuredContent.nextAction.type, "wait_for_user");
        assert.deepEqual((await store.get(applicationId)).answers, {});
      }
      state = await call("ask_next_question", { applicationId }, { [key]: { action: "accept", content: { [question.id]: answers[question.id] } } });
      asked.push(question.id);
      assert.equal((await store.get(applicationId)).answers[question.id], answers[question.id]);
    }
    assert.equal(new Set(asked).size, 10);
    assert.equal(state.structuredContent.nextAction.tool, "get_task_queue");
    assert.equal(state.structuredContent.application.taskCount, 12);
    const workspace = await call("show_material_checklist", { applicationId });
    assert.equal(workspace._meta.application.tasks.length, 12);
    assert.doesNotMatch(workspace._meta.application.notice, /模拟/);
  } finally { await handler.close(); }
});
