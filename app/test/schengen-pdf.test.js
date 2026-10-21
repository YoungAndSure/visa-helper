import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newTaskProgress, taskState, advanceTask, replayTaskHistory } from "../src/tasks.js";
import { schengenPdf, renderPrefilledPdf } from "../src/schengen-pdf.js";
import { ApplicationStore } from "../src/workflow.js";
import { GuideLinks, createGuideHandler } from "../src/form-guide.js";
import { basicAnswers } from "./support/decision-scenarios.mjs";

const facts = { ...basicAnswers, occupation: "employed" };
function state(fields = {}, fillMode) {
  const progress = newTaskProgress("schengen_form");
  const next = advanceTask(progress, { revision: 0, data: { ...progress.data, fields, ...(fillMode ? { fillMode } : {}) } }, facts);
  return taskState("schengen_form", next, facts);
}
test("original PDF inventory is pinned; text, dates, radios, purposes and funding write into distinct original fields", async () => {
  const flow = state({ "1": "EXAMPLE", "3": "TEST", "8": "female", "9": "married", "12": "ordinary", "13": "TEST00001",
    "19": "1 EXAMPLE ROAD, test@example.invalid", "19.phone": "+86 13800000000", "27.entries": "multiple",
    "30": "EXAMPLE HOTEL", "30.address": "2 EXAMPLE ROAD", "30.phone": "+354 0000000",
    "32.self": "yes", "32.self.creditCard": "yes", "32.self.cash": "no", "32.sponsor": "no" });
  const output = await renderPrefilledPdf(flow), pdf = await PDFDocument.load(output.bytes), form = pdf.getForm();
  assert.equal(pdf.getPageCount(), 4); assert.equal(form.getFields().length, 86); assert.deepEqual(output.issues, []);
  assert.equal(form.getTextField("Surname 1").getText(), "EXAMPLE");
  assert.equal(form.getTextField("Number of trvel document 1").getText(), "TEST00001");
  assert.equal(form.getTextField("Telephone no  1").getText(), "+86 13800000000");
  assert.equal(form.getTextField("Inviting persons address 1").getText(), "2 EXAMPLE ROAD");
  assert.equal(form.getTextField("Intended date of arrival 1").getText(), "01-06-2027");
  assert.equal(form.getRadioGroup("Sex").getSelected(), "1");
  assert.equal(form.getRadioGroup("Civil status").getSelected(), "Married");
  assert.equal(form.getRadioGroup("Type of travel document").getSelected(), "0");
  assert.equal(form.getRadioGroup("Number of entries requested").getSelected(), "2");
  assert.equal(form.getRadioGroup("Residence").getSelected(), "0");
  assert.equal(form.getCheckBox("Tourism").isChecked(), true);
  assert.equal(form.getCheckBox("Means of support 13").isChecked(), true);
  assert.equal(form.getCheckBox("Means of support 11").isChecked(), false);
  assert.equal(form.getCheckBox("Means of support 17").isChecked(), false);
  assert.equal(form.getTextField("Place of birth 1").getText(), undefined, "Unknown is not invented");
  assert.equal(form.getTextField("Filling in the application").getText(), undefined, "AI is not invented as a natural-person preparer");
  assert.ok(form.getTextField("Surname 1").isReadOnly() === false, "User can keep editing the generated file");
  assert.ok(flow.prefill.manualFields.some((x) => x.includes("签字")));
  assert.equal(flow.data.filled, false); assert.equal(flow.data.signed, false);
  assert.equal(flow.node, "prepare");
});

test("every configured native field and radio choice can be filled, including duplicate original export labels", async () => {
  const fields = Object.fromEntries(schengenPdf.fields.map((f) => [f.id, f.type === "text" ? "TEST" : f.options[0].value]));
  const result = await renderPrefilledPdf(state(fields));
  assert.equal(result.written.length, 77); assert.deepEqual(result.issues, []);
  for (const f of schengenPdf.fields.filter((f) => f.type === "choice" && !f.checkbox)) {
    for (const option of f.options) {
      const r = await renderPrefilledPdf(state({ [f.id]: option.value }));
      const form = (await PDFDocument.load(r.bytes)).getForm();
      assert.equal(form.getRadioGroup(f.pdfName).getSelected(), option.pdfValue, `${f.id}/${option.value}`);
      const widgets = form.getRadioGroup(f.pdfName).acroField.getWidgets();
      assert.equal(widgets.filter((w) => w.getAppearanceState()?.decodeText() !== "Off").length, 1);
    }
  }
});

test("unencodable, oversized and invalid-choice values produce explicit issues instead of clipping or guessing", async () => {
  const flow = state({ "1": "张三", "3": "W".repeat(800), "8": "uncertain", "23": "Tourism|Business", "32": "Self funded" });
  const r = await renderPrefilledPdf(flow), form = (await PDFDocument.load(r.bytes)).getForm();
  assert.deepEqual(r.issues.map((i) => i.fieldId).sort(), ["1", "3", "32", "8"]);
  assert.equal(form.getTextField("Surname 1").getText(), undefined);
  assert.equal(form.getRadioGroup("Sex").getSelected(), undefined);
  assert.equal(form.getCheckBox("Tourism").isChecked(), true);
  assert.equal(form.getCheckBox("Business¨").isChecked(), true);
  assert.equal(form.getCheckBox("Study").isChecked(), false);
});

test("manual choice and granular fields persist, resume and replay; old snapshots without a mode also replay", async () => {
  let p = newTaskProgress("schengen_form");
  p = advanceTask(p, { revision: p.revision, data: { ...p.data, fields: { "19.phone": "TEST" }, fillMode: "manual" } }, facts);
  p = advanceTask(p, { revision: p.revision, event: "GUIDE_READY" }, facts);
  assert.equal(taskState("schengen_form", p, facts).prefill.fillMode, "manual");
  assert.equal(replayTaskHistory(p).valid, true);
  let legacy = newTaskProgress("schengen_form");
  legacy = advanceTask(legacy, { revision: 0, event: "GUIDE_READY", data: { ...legacy.data, fields: { "1": "TEST" } } }, facts);
  assert.equal(Object.hasOwn(legacy.data, "fillMode"), false);
  assert.equal(replayTaskHistory(legacy).valid, true);
});

test("generated PDF links expire, invalidate on edits, preserve privacy headers and cannot access other routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "visa-pdf-http-"));
  try {
    const store = new ApplicationStore(join(root, "applications.json"));
    const { application } = await store.advance({ answers: facts });
    const selected = await store.startTask(application.id, "schengen_form");
    let clock = 0;
    const links = new GuideLinks({ baseUrl: "http://127.0.0.1:19080", now: () => clock });
    const doc = await links.createPdf(selected, selected.taskFlow), handler = createGuideHandler(store, links);
    async function request(url = doc.url, method = "GET") {
      const out = { headers: {} };
      await handler({ url: new URL(url).pathname, method }, { setHeader(k,v) { out.headers[k]=v; },
        writeHead(status, headers) { out.status=status; Object.assign(out.headers,headers); return this; }, end(body) { out.body=body; } });
      return out;
    }
    const r = await request(); assert.equal(r.status, 200); assert.equal(r.headers['Content-Type'], 'application/pdf');
    assert.equal(r.headers['Cache-Control'], 'no-store, private'); assert.equal(r.headers['Referrer-Policy'], 'no-referrer');
    assert.equal((await PDFDocument.load(r.body)).getPageCount(),4);
    assert.equal((await request(doc.url, 'HEAD')).body, undefined);
    assert.equal((await request(doc.url, 'POST')).status,404);
    assert.equal((await request(doc.url.replace('/forms/','/guides/').replace('/application.pdf',''))).status,404);
    assert.ok(!doc.url.includes(application.id));
    assert.equal((await links.createPdf(selected,selected.taskFlow)).url,doc.url,'Unchanged snapshots reuse a bounded temporary artifact');
    await store.advanceTask({applicationId:application.id,taskId:'schengen_form',revision:0,data:{...selected.taskFlow.data,fields:{'1':'UPDATED'}}});
    assert.equal((await request()).status,410);
    const current=await store.get(application.id), fresh=await links.createPdf(current,current.taskFlow);
    clock=16*60*1000;assert.equal((await request(fresh.url)).status,410);
  } finally { await rm(root,{recursive:true,force:true}); }
});
