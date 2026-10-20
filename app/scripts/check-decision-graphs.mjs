import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getActiveRuleVersion, loadRulePack, evaluateChecklistWithTrace } from "../src/checklist.js";
import { writeDecisionArtifacts } from "./decision-artifacts.mjs";
const version = getActiveRuleVersion(), pack = loadRulePack(version), { execution } = evaluateChecklistWithTrace({}, version);
const directory = await mkdtemp(join(tmpdir(), "visa-graph-check-"));
try {
  await writeDecisionArtifacts(pack, execution, directory);
  for (const name of await readdir(directory)) {
    const expected = await readFile(join(directory, name), "utf8");
    let actual;
    try { actual = await readFile(new URL(`../../docs/decision-graph/${name}`, import.meta.url), "utf8"); }
    catch { throw new Error(`Missing decision artifact: ${name}`); }
    if (actual !== expected) throw new Error(`Decision artifact is stale: ${name}; run npm run decision:graph --prefix app`);
  }
  console.log("Checked interview decision diagram and all executable exports.");
} finally { await rm(directory, { recursive: true, force: true }); }
