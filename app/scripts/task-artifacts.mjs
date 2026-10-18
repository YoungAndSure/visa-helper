import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { replayTaskHistory } from "../src/tasks.js";

// No application data is read when exporting the public task diagram.
if (process.argv[2] === "replay") {
  const [, , , file, applicationId] = process.argv;
  if (!file || !applicationId) throw new Error("Usage: task-artifacts.mjs replay APPLICATIONS_FILE APPLICATION_ID");
  const records = JSON.parse(await readFile(file, "utf8"));
  const progress = records[applicationId]?.taskProgress?.schengen_form;
  if (!progress?.version) throw new Error("No saved Schengen form workflow");
  console.log(JSON.stringify(replayTaskHistory(progress), null, 2));
} else {
  const pack = JSON.parse(await readFile(new URL("../config/tasks/schengen-form-v1.json", import.meta.url), "utf8"));
  const lines = ["# 申根申请表任务流程", "", "由任务配置生成，不包含申请人数据。", "", "```mermaid", "stateDiagram-v2", `    [*] --> ${pack.machine.initial}`];
  for (const [id, state] of Object.entries(pack.machine.states)) {
    lines.push(`    ${id}: ${state.meta.title}`);
    for (const [event, transition] of Object.entries(state.on ?? {})) {
      const target = typeof transition === "string" ? transition : transition.target;
      const guard = typeof transition === "object" && transition.guard ? ` [${transition.guard}]` : "";
      lines.push(`    ${id} --> ${target}: ${event}${guard}`);
    }
  }
  lines.push("```", "", "完成后仍可 EDIT 返回整理资料；原检查及完成确认同时清除。", "");
  const file = resolve(new URL("../../docs/task-workflow-graph.md", import.meta.url).pathname);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, lines.join("\n"));
  console.log("Task diagram generated.");
}
