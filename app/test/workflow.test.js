import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationStore } from "../src/workflow.js";

async function newStore() {
  const dir = await mkdtemp(join(tmpdir(), "visa-helper-test-"));
  return new ApplicationStore(join(dir, "applications.json"));
}

test("server controls step order and restores progress from storage", async () => {
  const store = await newStore();
  const created = await store.create();
  await assert.rejects(
    store.submit(created.id, "trip", { arrivalDate: "2027-01-01", departureDate: "2027-01-10" }),
    { code: "STEP_NOT_ALLOWED" },
  );
  const scenario = await store.submit(created.id, "scenario", {
    nationality: "CN", residence: "CN", destination: "IS", purpose: "tourism",
  });
  assert.equal(scenario.currentStep, "trip");
  await assert.rejects(
    store.submit(created.id, "trip", { arrivalDate: "2027-01-10", departureDate: "2027-01-01" }),
    { code: "INVALID_DATES" },
  );
  const trip = await store.submit(created.id, "trip", {
    arrivalDate: "2027-01-01", departureDate: "2027-01-10",
  });
  assert.equal(trip.currentStep, "review");
  assert.deepEqual((await store.get(created.id)).completedSteps, ["scenario", "trip"]);
  const done = await store.submit(created.id, "review", {});
  assert.equal(done.status, "walkthrough_complete");
  assert.equal(done.currentStep, null);
});

test("unsupported paths never become active applications", async () => {
  const store = await newStore();
  const created = await store.create();
  await assert.rejects(
    store.submit(created.id, "scenario", {
      nationality: "CN", residence: "CN", destination: "FR", purpose: "tourism",
    }),
    { code: "UNSUPPORTED_PATH" },
  );
  assert.equal((await store.get(created.id)).currentStep, "scenario");
  const file = JSON.parse(await readFile(store.filePath, "utf8"));
  assert.deepEqual(file[created.id].data, {});
});
