import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { replayTaskHistory } from "../src/tasks.js";
import { taskDefinitions } from "../src/task-definitions.js";

if (process.argv[2] === "replay") {
  const [, , , file, applicationId, taskId = "schengen_form"] = process.argv;
  if (!file || !applicationId) throw new Error("Usage: task-artifacts.mjs replay APPLICATIONS_FILE APPLICATION_ID [TASK_ID]");
  const records = JSON.parse(await readFile(file, "utf8"));
  const progress = records[applicationId]?.taskProgress?.[taskId];
  if (!progress?.version) throw new Error("No saved task workflow");
  console.log(JSON.stringify(replayTaskHistory(progress), null, 2));
} else {
  const index = ["# 冰岛材料任务与共用流程", "", "从实际运行定义生成；不包含申请人数据。各任务独立保存进度，表中流程名称表示可复用骨架。", "",
    "| 任务 ID | 材料 | 流程 |", "| --- | --- | --- |"];
  for (const pack of taskDefinitions()) {
    const lines = [`# ${pack.title}任务流程`, "", "由实际任务配置生成，不包含申请人数据。", "", `任务 ID：\`${pack.id}\`；流程：\`${pack.workflow}\`；版本：\`${pack.version}\`。`, "",
      "```mermaid", "stateDiagram-v2", `    [*] --> ${pack.machine.initial}`];
    for (const [id, state] of Object.entries(pack.machine.states)) {
      lines.push(`    ${id}: ${state.meta.title}`);
      for (const [event, transition] of Object.entries(state.on ?? {})) {
        const target = typeof transition === "string" ? transition : transition.target;
        const guard = typeof transition === "object" && transition.guard ? ` [${transition.guard}]` : "";
        lines.push(`    ${id} --> ${target}: ${event}${guard}`);
      }
    }
    lines.push("```", "", "完成后仍可 EDIT 返回准备步骤；原检查及完成确认同时清除。", "", "## 检查项目", "");
    for (const check of pack.checks) lines.push(`- ${check.label}${check.evidence === "user" ? "（由用户本人确认）" : ""}`);
    lines.push("");
    const name = pack.id === "schengen_form" ? "task-workflow-graph.md" : pack.id === "passport" ? "passport-task-workflow-graph.md" : `task-workflows/${pack.id}.md`;
    const file = new URL(`../../docs/${name}`, import.meta.url);
    await mkdir(dirname(file.pathname), { recursive: true }); await writeFile(file, lines.join("\n"));
    index.push(`| \`${pack.id}\` | [${pack.title}](${name}) | \`${pack.workflow}\` |`);
  }
  await writeFile(new URL("../../docs/material-task-workflows.md", import.meta.url), index.join("\n") + "\n");
  console.log(`Generated ${taskDefinitions().length} task diagrams and shared-workflow index.`);
}
