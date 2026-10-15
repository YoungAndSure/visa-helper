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

test("one adult applicant answers groups and receives an ordered file-task queue", async () => {
  const store = await newStore();
  const created = await store.create();
  assert.equal(created.status, "questions");
  assert.equal(created.questionGroup.id, "basic");
  assert.equal(created.questions.length, 9);
  const partial = await store.submitAnswers(created.id, { nationality: "CN", residence: "CN" });
  assert.equal(partial.questionGroup.id, "basic");
  const next = await store.submitAnswers(created.id, Object.fromEntries(Object.entries(basic).filter(([key]) => !["nationality", "residence"].includes(key))));
  assert.equal(next.questionGroup.id, "adult");
  const ready = await store.submitAnswers(created.id, { occupation: "employed" });
  assert.equal(ready.status, "tasks_ready");
  assert.deepEqual(ids(ready).slice(-2), ["employer_license", "employment_letter"]);
  assert.ok(!ids(ready).includes("travel_consent_certificate"));
  assert.equal((await store.get(created.id)).ruleVersion, created.ruleVersion);
  assert.equal(JSON.parse(await readFile(store.filePath, "utf8"))[created.id].answers.occupation, "employed");
});

test("independent decisions add tasks and corrected answers remove stale branches", async () => {
  const store = await newStore();
  const { id } = await store.create();
  await store.submitAnswers(id, { ...basic, otherSchengenCountries: "yes" });
  assert.equal((await store.get(id)).questionGroup.id, "multi_country");
  await store.submitAnswers(id, { icelandMainDestination: "yes" });
  const employed = await store.submitAnswers(id, { occupation: "employed" });
  assert.ok(ids(employed).includes("intra_schengen_transport"));
  assert.ok(ids(employed).includes("employment_letter"));
  const changed = await store.submitAnswers(id, { ageGroup: "minor", inSchool: "yes", minorTravel: "one_parent", guardianAbroad: "no" });
  assert.equal(changed.status, "tasks_ready");
  assert.ok(ids(changed).includes("travel_consent_certificate"));
  assert.ok(!ids(changed).includes("employment_letter"));
  assert.ok(ids(changed).includes("school_letter"));
});

test("out-of-scope and ambiguous routes cannot generate a definitive queue", async () => {
  const store = await newStore();
  const foreign = await store.create();
  assert.equal((await store.submitAnswers(foreign.id, { ...basic, nationality: "other" })).status, "unsupported");
  const multi = await store.create();
  await store.submitAnswers(multi.id, { ...basic, otherSchengenCountries: "yes" });
  const unsure = await store.submitAnswers(multi.id, { icelandMainDestination: "unsure" });
  assert.equal(unsure.status, "needs_review");
  assert.deepEqual(unsure.tasks, []);
  const dates = await store.create();
  const invalid = await store.submitAnswers(dates.id, { ...basic, departureDate: "2027-05-30" });
  assert.equal(invalid.status, "needs_correction");
});

test("answer validation rejects unknown values without changing stored answers", async () => {
  const store = await newStore();
  const { id } = await store.create();
  await assert.rejects(store.submitAnswers(id, { occupation: "student" }), { code: "INVALID_ANSWERS" });
  await assert.rejects(store.submitAnswers(id, { arrivalDate: "2027-02-30" }), { code: "INVALID_ANSWERS" });
  assert.deepEqual((await store.get(id)).answers, {});
});

test("legacy walkthrough record remains readable", async () => {
  const store = await newStore();
  await store.saveAll({ old: { id: "old", status: "walkthrough_complete", data: { trip: { arrivalDate: "2027-06-01" } } } });
  const legacy = await store.get("old");
  assert.equal(legacy.status, "legacy_walkthrough");
  assert.equal(legacy.data.trip.arrivalDate, "2027-06-01");
  await assert.rejects(store.submitAnswers("old", { nationality: "CN" }), { code: "LEGACY_APPLICATION" });
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
  const old = await store.create();
  const v2 = "iceland-tourism-test-v2";
  pack.version = v2;
  pack.tasks.push({ id: "config_added_file", title: "配置新增材料", checklistItem: "test", when: true });
  await writeFile(join(configDir, "rules", `${v2}.json`), JSON.stringify(pack));
  await writeFile(join(configDir, "active.json"), JSON.stringify({ version: v2 }));
  const fresh = await store.create();
  assert.equal(old.ruleVersion, v1);
  assert.equal(fresh.ruleVersion, v2);
  await store.submitAnswers(old.id, basic);
  await store.submitAnswers(fresh.id, basic);
  const oldReady = await store.submitAnswers(old.id, { occupation: "employed" });
  const newReady = await store.submitAnswers(fresh.id, { occupation: "employed" });
  assert.ok(!ids(oldReady).includes("config_added_file"));
  assert.ok(ids(newReady).includes("config_added_file"));
});
