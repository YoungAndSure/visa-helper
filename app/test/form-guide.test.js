import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationStore } from "../src/workflow.js";
import { GuideLinks, createGuideHandler } from "../src/form-guide.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "visa-guide-"));
  const store = new ApplicationStore(join(dir, "applications.json"));
  const { application } = await store.advance({ answers: { nationality: "CN", residence: "CN", applicationCity: "北京",
    destination: "IS", purpose: "tourism", arrivalDate: "2027-06-01", departureDate: "2027-06-10",
    ageGroup: "adult", otherSchengenCountries: "no", occupation: "employed" } });
  let state = await store.startTask(application.id, "schengen_form");
  ({ application: state } = await store.advanceTask({ applicationId: application.id, taskId: "schengen_form", revision: 0,
    data: { ...state.taskFlow.data, fields: { "1": "TEST <b>NAME</b>" } } }));
  let time = 1000;
  const links = new GuideLinks({ baseUrl: "http://127.0.0.1:18080", now: () => time });
  const link = links.create(state, state.taskFlow), handler = createGuideHandler(store, links);
  async function request(path = new URL(link.url).pathname, method = "GET") {
    const result = { headers: {} };
    await handler({ url: path, method }, {
      setHeader(name, value) { result.headers[name] = value; },
      writeHead(status, headers) { result.status = status; Object.assign(result.headers, headers); return this; },
      end(body) { result.body = body; },
    });
    return result;
  }
  return { store, application: state, links, link, request, expire() { time += 16 * 60 * 1000; } };
}

test("standalone links render safe HTML with known values and do not expose the MCP endpoint", async () => {
  const f = await fixture(), page = await f.request();
  assert.equal(page.status, 200);
  assert.match(page.headers["Content-Type"], /text\/html/);
  assert.match(page.body, /01-06-2027/);
  assert.match(page.body, /TEST &lt;b&gt;NAME&lt;\/b&gt;/);
  assert.doesNotMatch(page.body, /<script|<iframe|<b>NAME/);
  assert.match(page.body, /请填写：按实际进入申根区/);
  assert.deepEqual([...page.body.matchAll(/data-page="(\d)"/g)].map((match) => match[1]), ["1", "2", "3", "4"]);
  for (const entry of f.application.taskFlow.guide) {
    assert.equal(page.body.split(`data-field-id="${entry.id}"`).length - 1, 1, `Field ${entry.id} must appear once in its official page group`);
    const section = page.body.split(`data-page="${entry.page}"`)[1]?.split('<article class="sheet"')[0];
    assert.ok(section.includes(`data-field-id="${entry.id}"`), `Field ${entry.id} on wrong page`);
  }
  assert.match(page.body, /签证机关专用区域/);
  assert.match(page.body, /id="signature-area"/);
  assert.equal(new URL(f.link.url).pathname.split("/").at(-1).length, 43);
  assert.ok(!f.link.url.includes(f.application.id));
  assert.equal(page.headers["Cache-Control"], "no-store, private");
  assert.equal(page.headers["Referrer-Policy"], "no-referrer");
  assert.match(page.headers["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.equal((await f.request("/mcp", "POST")).status, 404);
  assert.equal((await f.request("/version")).status, 404);
  assert.equal((await f.request(new URL(f.link.url).pathname, "POST")).status, 404);
  assert.equal((await f.request(undefined, "HEAD")).body, undefined);
});

test("expired or changed application links stop working without revealing the guide", async () => {
  const f = await fixture();
  await f.store.advanceTask({ applicationId: f.application.id, taskId: "schengen_form",
    revision: f.application.taskFlow.revision, event: "GUIDE_READY" });
  const changed = await f.request(); assert.equal(changed.status, 410); assert.doesNotMatch(changed.body, /TEST/);
  const expired = await fixture(); expired.expire();
  assert.equal((await expired.request()).status, 410);
});

test("public HTTP is an explicit test option; normal origins must use HTTPS", () => {
  assert.throws(() => new GuideLinks({ baseUrl: "http://129.204.29.242:18080", allowHttp: false }));
  assert.ok(new GuideLinks({ baseUrl: "http://129.204.29.242:18080", allowHttp: true }));
  assert.throws(() => new GuideLinks({ baseUrl: "https://user:secret@example.com" }));
});
