import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVisaServer } from "../src/server.js";
import { ApplicationStore } from "../src/workflow.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "visa-helper-release-"));
  const store = new ApplicationStore(join(root, "applications.json"));
  const server = createVisaServer(store);
  const client = new Client({ name: "release-tests", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  return { store, server, client, close: async () => { await client.close(); await server.close(); } };
}
const facts = {
  nationality: "CN", residence: "CN", applicationCity: "北京", destination: "IS", purpose: "tourism",
  arrivalDate: "2027-06-01", departureDate: "2027-06-10", ageGroup: "adult", otherSchengenCountries: "no", occupation: "employed",
};

test("release probe identifies stale host tool snapshots without pretending an omitted list was checked", async () => {
  const { client, store, close } = await setup();
  try {
    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    const unchecked = await call("get_server_info");
    assert.equal(unchecked.structuredContent.compatibility.status, "not_checked");
    const oldTools = ["open_visa_helper", "create_application", "get_application", "get_questions", "submit_answers", "get_task_queue", "start_task"];
    const stale = await call("get_server_info", { clientTools: oldTools });
    assert.equal(stale.structuredContent.compatibility.status, "tools_mismatch");
    assert.deepEqual(stale.structuredContent.compatibility.missingTools, ["advance_application", "advance_task"]);
    const rejected = await call("advance_application", { answers: {}, clientTools: oldTools });
    assert.equal(rejected.structuredContent.error.code, "CLIENT_TOOLS_MISMATCH");
    assert.deepEqual(await store.readAll(), {});
    const { tools } = await client.listTools();
    const current = await call("get_server_info", { clientTools: tools.map((tool) => tool.name) });
    assert.equal(current.structuredContent.compatibility.status, "compatible");
    const info = current.structuredContent.serverInfo;
    for (const hash of [info.buildHash, info.toolContractHash, info.ui.sourceHash]) assert.match(hash, /^[a-f0-9]{64}$/);
    const missingRecord = await call("advance_application", { applicationId: "00000000-0000-4000-8000-000000000000" });
    assert.equal(missingRecord.structuredContent.error.code, "NOT_FOUND");
    assert.equal(missingRecord.structuredContent.serverInfo.buildHash, info.buildHash);
    const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.equal(toolsByName.get("get_task_queue")._meta.ui.resourceUri, info.ui.resourceUri);
    for (const uri of [info.ui.resourceUri]) {
      const resource = await client.readResource({ uri });
      assert.ok(resource.contents[0].text.includes(info.ui.sourceHash));
      assert.doesNotMatch(resource.contents[0].text, /模拟|恢复申请/);
    }
  } finally { await close(); }
});

test("UI data is not a loaded-page receipt; wrong UI versions are rejected and changed facts clear the receipt", async () => {
  const { client, close } = await setup();
  try {
    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    const created = await call("advance_application", { answers: facts });
    const { applicationId, revision } = created.structuredContent;
    const checklist = await call("get_task_queue", { applicationId });
    assert.equal(checklist.structuredContent.presentation.status, "not_confirmed");
    assert.equal(checklist.structuredContent.nextAction.type, "choose_task");
    const info = checklist.structuredContent.serverInfo;
    const bad = await call("report_ui_ready", { applicationId, buildHash: info.buildHash, uiSourceHash: "0".repeat(64) });
    assert.equal(bad.structuredContent.error.code, "UI_VERSION_MISMATCH");
    const reported = await call("report_ui_ready", {
      applicationId, buildHash: info.buildHash, uiSourceHash: info.ui.sourceHash,
      applicationUpdatedAt: checklist._meta.application.updatedAt,
    });
    assert.ok(reported.structuredContent.uiReceipt.receivedAt);
    assert.equal((await call("advance_application", { applicationId })).structuredContent.presentation.status, "loaded");
    const changed = await call("advance_application", { applicationId, revision, answers: { ...facts, occupation: "retired" } });
    assert.equal(changed.structuredContent.presentation.status, "not_confirmed");
    const oldState = await call("report_ui_ready", { applicationId, buildHash: info.buildHash, uiSourceHash: info.ui.sourceHash, applicationUpdatedAt: "old" });
    assert.equal(oldState.structuredContent.error.code, "UI_STATE_CHANGED");
  } finally { await close(); }
});
