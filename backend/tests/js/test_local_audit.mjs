import assert from "node:assert/strict";
import test from "node:test";

import { createLocalAuditContext, runLocalAuditRules } from "../../static/local-audit-engine.js";
import { preprocessFilesLocally } from "../../static/local-recognition.js";
import { boxesForSensitiveWords, buildSafePackage, detectSensitiveRanges, validateSafePackage } from "../../static/privacy.js";

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

test("privacy detector maps sensitive OCR words to visual boxes", () => {
  assert.deepEqual(detectSensitiveRanges("Phone: 13800000000")[0].type, "phone");
  const boxes = boxesForSensitiveWords([
    { text: "Email:", line: "1", left: 10, top: 20, width: 40, height: 12 },
    { text: "person@example.com", line: "1", left: 55, top: 20, width: 130, height: 12 },
  ]);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].type, "email");
  assert.ok(boxes[0].width >= 130);
});

test("safe package contains only anonymous sanitized file copies", () => {
  const workspace = {
    country: "IS",
    visa_type: "schengen-tourism",
    materials: [{
      material_id: "material-001",
      source_ref: "local-file-001",
      kind: "image",
      media_type: "image/jpeg",
      pages: [{ redactions: [] }],
      sanitized_file: {
        media_type: "image/jpeg",
        content: "data:image/jpeg;base64,/9j/c2FuaXRpemVkLWltYWdl",
        size: 24,
        page_count: 1,
        redaction_count: 0,
      },
      review_status: "ready",
    }],
  };
  const safePackage = buildSafePackage(workspace, true);
  assert.equal(safePackage.materials[0].material_id, "material-001");
  assert.equal("pages" in safePackage.materials[0], false);
  assert.deepEqual(validateSafePackage(safePackage), []);
});
