import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getActiveRuleVersion, loadRulePack } from "./checklist.js";
import { INTERVIEW_PROTOCOL_VERSION } from "./interview.js";
import { ENGINE_VERSION, hash } from "./decision-machine.js";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (text) => createHash("sha256").update(text).digest("hex");
const packageInfo = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
export const APP_VERSION = packageInfo.version;
export const UI_RESOURCE_URI = "ui://visa-helper/material-checklist-v4.html";
export const WIDGET_SOURCE = readFileSync(join(appDir, "public/application.html"), "utf8");
export const UI_SOURCE_HASH = digest(WIDGET_SOURCE);
export const WIDGET_HTML = WIDGET_SOURCE.replaceAll("__VISA_APP_VERSION__", packageInfo.version).replaceAll("__VISA_UI_SOURCE_HASH__", UI_SOURCE_HASH);
export const REQUIRED_CLIENT_TOOLS = [
  "advance_application", "get_task_queue", "start_task",
];
const files = ["package.json", "package-lock.json", "public/application.html",
  ...readdirSync(join(appDir, "src")).filter((file) => file.endsWith(".js")).sort().map((file) => `src/${file}`)];
const buildHash = digest(files.map((file) => `${file}\0${readFileSync(join(appDir, file), "utf8")}\0`).join(""));
const instanceId = randomUUID();
const startedAt = new Date().toISOString();

export function serverInfo(contracts, configDir) {
  const activeVersion = getActiveRuleVersion(configDir);
  const active = loadRulePack(activeVersion, configDir);
  return {
    service: "visa-helper", version: packageInfo.version, buildHash,
    interview: { protocolVersion: INTERVIEW_PROTOCOL_VERSION, tool: "advance_application", answerSubmission: "full_snapshot" },
    instanceId, startedAt,
    toolContractHash: digest(JSON.stringify([...contracts].sort((a, b) => a.name.localeCompare(b.name)))),
    tools: contracts.map((tool) => tool.name), requiredClientTools: REQUIRED_CLIENT_TOOLS,
    ui: { resourceUri: UI_RESOURCE_URI, sourceHash: UI_SOURCE_HASH },
    rules: { activeVersion, modelHash: hash(active), engine: "xstate", engineVersion: ENGINE_VERSION },
  };
}

function normalizeName(name) {
  return name.replace(/^mcp__codex_apps__visa_helper_/, "").replace(/^.*[.:/]/, "");
}

export function checkClient({ clientTools, clientUiHash } = {}) {
  const uiMatches = clientUiHash === undefined ? null : clientUiHash === UI_SOURCE_HASH;
  if (clientTools === undefined) return {
    status: uiMatches === false ? "ui_mismatch" : "not_checked", checked: false,
    uiMatches, message: "服务端版本可读，但未收到客户端实际可调用工具列表；不能据此认定连接已更新。",
  };
  const names = new Set(clientTools.map(normalizeName));
  const missingTools = REQUIRED_CLIENT_TOOLS.filter((name) => !names.has(name));
  return {
    status: missingTools.length ? "tools_mismatch" : uiMatches === false ? "ui_mismatch" : "compatible",
    checked: true, missingTools, uiMatches, versionToolAvailable: names.has("get_server_info"),
    message: missingTools.length ? `客户端缺少：${missingTools.join("、")}。请先更新连接，保留当前申请，暂不继续问答。`
      : uiMatches === false ? "当前页面与服务端 UI 版本不同，暂停材料操作。" : "客户端报告的工具列表与当前服务兼容。",
  };
}
