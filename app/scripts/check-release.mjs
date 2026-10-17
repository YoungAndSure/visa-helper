#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createVisaServer } from "../src/server.js";

const endpoint = process.argv[2] ?? "http://127.0.0.1:18081/mcp";
const clientToolFile = process.argv[3];
const expected = createVisaServer().releaseInfo();
const client = new Client({ name: "visa-helper-release-check", version: expected.version });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  const listed = (await client.listTools()).tools;
  assert.ok(listed.some((tool) => tool.name === "get_server_info"),
    `target reports ${client.getServerVersion()?.version ?? "unknown"} and has no get_server_info; expected ${expected.version}`);
  const clientTools = clientToolFile ? JSON.parse(await readFile(clientToolFile, "utf8")) : listed.map((tool) => tool.name);
  const result = await client.callTool({ name: "get_server_info", arguments: { clientTools } });
  const actual = result.structuredContent.serverInfo;
  for (const field of ["version", "buildHash", "toolContractHash"]) assert.equal(actual[field], expected[field], `${field} mismatch`);
  assert.equal(actual.ui.sourceHash, expected.ui.sourceHash, "UI source mismatch");
  assert.deepEqual(actual.rules, expected.rules, "Rule model or execution engine mismatch");
  assert.deepEqual(actual.interview, expected.interview, "Interview protocol mismatch");
  assert.equal(result.structuredContent.compatibility.status, "compatible", JSON.stringify(result.structuredContent.compatibility));
  assert.deepEqual(listed.map((tool) => tool.name).sort(), [...expected.tools].sort(), "Unexpected or missing MCP tools");
  const ui = await client.readResource({ uri: actual.ui.resourceUri });
  assert.ok(ui.contents[0].text.includes(actual.ui.sourceHash), "served HTML lacks its expected fingerprint");
  assert.doesNotMatch(ui.contents[0].text, /恢复申请|模拟/);
  const response = await fetch(new URL("/version", endpoint));
  assert.equal(response.status, 200);
  const httpInfo = await response.json();
  assert.equal(httpInfo.instanceId, actual.instanceId, "HTTP and MCP target different server instances");
  assert.equal(httpInfo.buildHash, actual.buildHash);
  console.log(JSON.stringify({ status: "pass", version: actual.version, build: actual.buildHash.slice(0, 12),
    interviewProtocol: actual.interview.protocolVersion, interviewTool: actual.interview.tool,
    engine: actual.rules.engine, engineVersion: actual.rules.engineVersion, model: actual.rules.modelHash.slice(0, 12),
    tools: actual.toolContractHash.slice(0, 12), ui: actual.ui.sourceHash.slice(0, 12),
    hostInventoryChecked: Boolean(clientToolFile),
    inventorySource: clientToolFile ? "provided host snapshot" : "server tools/list only; ChatGPT snapshot not checked",
  }));
} catch (error) {
  console.error(`Release check failed: ${error.message}`);
  process.exitCode = 1;
} finally { await client.close(); }
