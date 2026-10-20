import { mkdir, writeFile, rm } from "node:fs/promises";
import { runFlowSuite, reportMarkdown, contractUrl } from "../test/support/flow-suite.mjs";
const update = process.argv.includes("--update-contract");
if (update && process.env.CI) throw new Error("CI must not update flow contracts.");
const output = new URL("../.local/test-results/", import.meta.url);
await mkdir(output, { recursive: true });
for (const file of ["flow-coverage.json", "flow-coverage.md"]) await rm(new URL(file, output), { force: true });
let result;
try { result = await runFlowSuite({ checkContract: !update }); }
catch (error) {
  result = { passed: false, failures: [`Scenario execution failed: ${error.message}`], reports: [], rules: [], scenarios: [], modelSignature: null,
    totals: { nodes: 0, nodesCovered: 0, edges: 0, edgesCovered: 0, branches: 0, branchesCovered: 0 } };
}
await writeFile(new URL("flow-coverage.json", output), JSON.stringify({ ...result, contract: undefined }, null, 2) + "\n");
await writeFile(new URL("flow-coverage.md", output), reportMarkdown(result));
if (update && result.passed) {
  await writeFile(contractUrl, JSON.stringify(result.contract, null, 2) + "\n");
  console.log("Reviewed flow contract written. Inspect and commit the diff.");
}
console.log(JSON.stringify({ passed: result.passed, flows: result.reports.length, ...result.totals }));
if (!result.passed) { console.error(result.failures.join("\n")); process.exitCode = 1; }
