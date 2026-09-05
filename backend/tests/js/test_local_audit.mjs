import assert from "node:assert/strict";
import test from "node:test";

import { createLocalAuditContext, runLocalAuditRules } from "../../static/local-audit-engine.js";
import { preprocessFilesLocally } from "../../static/local-recognition.js";
import { buildSafePackageFromAnalysis } from "../../static/privacy.js";

function preprocessing(documents) {
  return {
    schema_version: "local-document-context/v1",
    created_at: "2026-09-05T00:00:00.000Z",
    processed_locally: true,
    raw_files_uploaded: false,
    documents,
  };
}

function document(overrides = {}) {
  return {
    document_id: "document-001",
    material_id: "material-001",
    source_ref: "local-file-001",
    local_name: "passport.pdf",
    media_type: "application/pdf",
    kind: "pdf",
    size: 100,
    last_modified: null,
    full_text: "PASSPORT",
    pages: [],
    images: [],
    recognition: {
      status: "success",
      text_source: "pdf_text_layer",
      ocr_status: "not_required",
      error: null,
    },
    ...overrides,
  };
}

test("preprocessor creates normalized documents without raw File references", async () => {
  const source = {
    name: "notes.txt",
    type: "text/plain",
    size: 12,
    lastModified: 1,
    webkitRelativePath: "materials/notes.txt",
    async text() { return "hello"; },
  };
  const result = await preprocessFilesLocally([source]);
  assert.equal(result.schema_version, "local-document-context/v1");
  assert.equal(result.documents[0].full_text, "hello");
  assert.equal("file" in result.documents[0], false);
});

test("built-in rules discover candidates from the shared context", async () => {
  const context = createLocalAuditContext({
    country: "IS",
    visaType: "schengen-tourism",
    checklist: [],
    preprocessing: preprocessing([document()]),
  });
  const audit = await runLocalAuditRules(context);
  const passport = audit.rule_results.find((result) => result.rule_id === "passport.material-candidate");
  assert.equal(passport.status, "pass");
  assert.deepEqual(passport.matched_document_ids, ["document-001"]);
  assert.equal(Object.isFrozen(context.documents[0]), true);
});

test("custom rules plug into the engine and failures stay isolated", async () => {
  const context = createLocalAuditContext({
    country: "IS",
    visaType: "schengen-tourism",
    preprocessing: preprocessing([document()]),
  });
  const rules = [
    { id: "custom.pass", title: "Custom pass", async run() { return { status: "pass", reason: "ok" }; } },
    { id: "custom.error", title: "Custom error", async run() { throw new Error("boom"); } },
  ];
  const audit = await runLocalAuditRules(context, { rules });
  assert.deepEqual(audit.rule_results.map((result) => result.status), ["pass", "error"]);
  assert.match(audit.rule_results[1].reason, /boom/);
});

test("privacy pipeline consumes audit context without copying local filenames", async () => {
  const context = createLocalAuditContext({
    country: "IS",
    visaType: "schengen-tourism",
    preprocessing: preprocessing([document({ full_text: "Name: Example User" })]),
  });
  const audit = await runLocalAuditRules(context);
  const safePackage = buildSafePackageFromAnalysis(audit);
  assert.equal(safePackage.materials[0].material_id, "material-001");
  assert.equal("local_name" in safePackage.materials[0], false);
  assert.match(safePackage.materials[0].text, /\[REDACTED_NAME\]/);
});
