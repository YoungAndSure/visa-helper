import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationStore } from "../src/workflow.js";
import { DEFAULT_CONFIG_DIR, getActiveRuleVersion } from "../src/checklist.js";

async function newStore() {
  const dir = await mkdtemp(join(tmpdir(), "visa-helper-test-"));
  return new ApplicationStore(join(dir, "applications.json"));
}
const basic = {
  nationality: "CN", residence: "CN", applicationCity: "北京", destination: "IS",
  purpose: "tourism", arrivalDate: "2027-06-01", departureDate: "2027-06-10",
  ageGroup: "adult", otherSchengenCountries: "no",
};
const ids = (state) => state.tasks.map((task) => task.id);

test("complete snapshots generate ordered tasks and persist the selected rules", async () => {
  const store = await newStore();
  let { application } = await store.advance({ answers: {} });
  assert.equal(application.questionGroup.id, "basic");
  assert.equal(application.questions.length, 9);
  ({ application } = await store.advance({ applicationId: application.id, revision: application.revision, answers: basic }));
  assert.equal(application.questionGroup.id, "adult");
  ({ application } = await store.advance({ applicationId: application.id, revision: application.revision, answers: { ...basic, occupation: "employed" } }));
  assert.equal(application.status, "tasks_ready");
  assert.deepEqual(ids(application).slice(-2), ["employer_license", "employment_letter"]);
  assert.ok(!ids(application).includes("travel_consent_certificate"));
  assert.equal((await store.get(application.id)).ruleVersion, application.ruleVersion);
  assert.equal(JSON.parse(await readFile(store.filePath, "utf8"))[application.id].answers.occupation, "employed");
});

test("multi-country decisions and age corrections select only applicable tasks", async () => {
  const store = await newStore();
  const answers = { ...basic, otherSchengenCountries: "yes" };
  let { application } = await store.advance({ answers });
  assert.equal(application.questionGroup.id, "multi_country");
  answers.icelandMainDestination = "yes";
  answers.occupation = "employed";
  ({ application } = await store.advance({ applicationId: application.id, revision: application.revision, answers }));
  assert.ok(ids(application).includes("intra_schengen_transport"));
  assert.ok(ids(application).includes("employment_letter"));
  ({ application } = await store.advance({ applicationId: application.id, revision: application.revision,
    answers: { ...answers, ageGroup: "minor", inSchool: "yes", minorTravel: "one_parent", guardianAbroad: "no" } }));
  assert.equal(application.status, "tasks_ready");
  assert.ok(ids(application).includes("travel_consent_certificate"));
  assert.ok(!ids(application).includes("employment_letter"));
});

test("task selection persists and rejects incomplete or removed materials", async () => {
  const store = await newStore();
  let { application } = await store.advance({ answers: {} });
  await assert.rejects(store.startTask(application.id, "passport"), { code: "QUESTIONS_INCOMPLETE" });
  ({ application } = await store.advance({ applicationId: application.id, revision: application.revision, answers: { ...basic, occupation: "employed" } }));
  const selected = await store.startTask(application.id, "employment_letter");
  assert.equal(selected.activeTask.status, "in_progress");
  assert.equal((await store.get(application.id)).activeTask.id, "employment_letter");
  ({ application } = await store.advance({ applicationId: application.id, revision: application.revision, answers: { ...basic, occupation: "retired" } }));
  assert.equal(application.activeTask, null);
  await assert.rejects(store.startTask(application.id, "employment_letter"), { code: "TASK_NOT_FOUND" });
});

test("a configuration-only version switch affects new applications, not existing ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visa-helper-rules-"));
  const configDir = join(dir, "config");
  await mkdir(join(configDir, "rules"), { recursive: true });
  const v1 = getActiveRuleVersion();
  const pack = JSON.parse(await readFile(join(DEFAULT_CONFIG_DIR, "rules", `${v1}.json`), "utf8"));
  await writeFile(join(configDir, "rules", `${v1}.json`), JSON.stringify(pack));
  await writeFile(join(configDir, "active.json"), JSON.stringify({ version: v1 }));
  const store = new ApplicationStore(join(dir, "applications.json"), configDir);
  const { application: old } = await store.advance({ answers: {} });
  const v2 = "iceland-tourism-test-v2";
  pack.version = v2;
  pack.tasks.push({ id: "config_added_file", title: "配置新增材料", checklistItem: "test" });
  pack.machine.states.materials_common.entry[0].params.ids.push("config_added_file");
  await writeFile(join(configDir, "rules", `${v2}.json`), JSON.stringify(pack));
  await writeFile(join(configDir, "active.json"), JSON.stringify({ version: v2 }));
  const { application: fresh } = await store.advance({ answers: {} });
  assert.equal(old.ruleVersion, v1);
  assert.equal(fresh.ruleVersion, v2);
  const answers = { ...basic, occupation: "employed" };
  const { application: oldReady } = await store.advance({ applicationId: old.id, revision: old.revision, answers });
  const { application: newReady } = await store.advance({ applicationId: fresh.id, revision: fresh.revision, answers });
  assert.ok(!ids(oldReady).includes("config_added_file"));
  assert.ok(ids(newReady).includes("config_added_file"));
});
