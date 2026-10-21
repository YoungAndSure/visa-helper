import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVisaServer } from "../src/server.js";
import { ApplicationStore } from "../src/workflow.js";
import { GuideLinks, createGuideHandler } from "../src/form-guide.js";
import { browser, until } from "./support/browser.mjs";
import { basicAnswers } from "./support/decision-scenarios.mjs";
import { PDFDocument } from "pdf-lib";

for (const mode of ["standard", "compatibility", "no-context"]) test(`material buttons, chat handoff, pause and resume work with ${mode} host bridge`, { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "visa-ui-regression-")), store = new ApplicationStore(join(root, "applications.json"));
  const { application } = await store.advance({ answers: { ...basicAnswers, occupation: "employed" } });
  const links = new GuideLinks(), mcp = createVisaServer(store, links), client = new Client({ name: "ui-regression", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await mcp.connect(st); await client.connect(ct);
  const call = (params) => client.callTool(params), initial = await call({ name: "get_task_queue", arguments: { applicationId: application.id } });
  const widget = (await client.readResource({ uri: initial.structuredContent.serverInfo.ui.resourceUri })).contents[0].text;
  const messages = [], calls = [], contexts = [], downloads = []; let failStart = false, activeBrowser;
  const escape = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");
  const host = `<!doctype html><meta charset="utf-8"><iframe id="widget" style="width:900px;height:1000px;border:0" src="/widget"></iframe><script>
    const initial=${escape(initial)};
    addEventListener('message',async({data:m,source})=>{
      if(!m?.id)return;
      if(m.method==='ui/initialize'){
        if('${mode}'==='compatibility')return;
        source.postMessage({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'regression-host',version:'1'},hostCapabilities:{},hostContext:{}}},'*');
        source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:initial},'*');return;
      }
      let result={};
      if(m.method==='tools/call') result=await(await fetch('/rpc',{method:'POST',body:JSON.stringify(m.params)})).json();
      if(m.method==='ui/update-model-context'){
        if('${mode}'==='no-context'){source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Context unsupported'}},'*');return;}
        await fetch('/context',{method:'POST',body:JSON.stringify(m.params)});
      }
      if(m.method==='ui/message')await fetch('/message',{method:'POST',body:JSON.stringify(m.params)});
      if(m.method==='ui/download-file')await fetch('/download',{method:'POST',body:JSON.stringify(m.params)});
      source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');
    });</script>`;
  const legacy = `<script>window.openai={toolOutput:${escape(initial.structuredContent)},toolResponseMetadata:{mcp_tool_result:${escape(initial)}},
    callTool:async(name,args)=>({mcp_tool_result:await(await fetch('/rpc',{method:'POST',body:JSON.stringify({name,arguments:args})})).json()}),
    setWidgetState:(state)=>{window.savedWidgetState=state;window.openai.widgetState=state;
      dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{widgetState:state}}}));},
    sendFollowUpMessage:async({prompt})=>{await fetch('/context',{method:'POST',body:JSON.stringify({structuredContent:window.savedWidgetState.modelContent})});await fetch('/message',{method:'POST',body:JSON.stringify({content:[{type:'text',text:prompt}]})});}
  };</script>`;
  let guideHandler;
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/") return res.end(host);
      if (req.url === "/widget") return res.end(mode === "compatibility" ? widget.replace('<script type="module">', legacy + '<script type="module">') : widget);
      if (req.url.startsWith("/guides/") || req.url.startsWith("/forms/")) return guideHandler(req, res);
      let body = ""; for await (const chunk of req) body += chunk;
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/message") { messages.push(JSON.parse(body)); return res.end("{}"); }
      if (req.url === "/context") { contexts.push(JSON.parse(body).structuredContent); return res.end("{}"); }
      if (req.url === "/download") { downloads.push(JSON.parse(body)); return res.end("{}"); }
      if (req.url === "/rpc") {
        const params = JSON.parse(body); calls.push(params);
        if (params.name === "start_task" && failStart) { failStart = false; return res.end(JSON.stringify({ isError: true, structuredContent: { error: { message: "测试连接暂不可用，请重试" } } })); }
        const result = await call(params);
        // Model-visible data must suffice when the host strips widget-only metadata.
        delete result._meta; return res.end(JSON.stringify(result));
      }
      res.writeHead(404).end();
    } catch (error) { res.writeHead(500).end(JSON.stringify({ message: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  links.baseUrl = `http://127.0.0.1:${server.address().port}`; guideHandler = createGuideHandler(store, links);
  try {
    activeBrowser = await browser(root, links.baseUrl);
    const evaluate = activeBrowser.evaluate, frame = "document.querySelector('iframe').contentDocument";
    const text = () => evaluate("document.querySelector('iframe')?.contentDocument?.body?.innerText ?? ''");
    const idle = () => evaluate(`${frame}.querySelector('button') && !${frame}.querySelector('button:disabled')`);
    const click = async (label) => { await until(idle, "UI ready"); return evaluate(`Array.from(${frame}.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)} && !b.disabled).click()`); };
    const selected = async (id) => { await until(async () => (await store.get(application.id)).activeTask?.id === id, `select ${id}`); await until(idle, `render ${id}`); };
    const selectRow = async (id, title) => {
      if (await evaluate(`${frame}.querySelector('#all-tasks').hidden`)) {
        const count = messages.length;
        await click("全部任务");
        await until(async () => !(await store.get(application.id)).activeTask && await idle(), "back to checklist");
        assert.equal(await evaluate(`${frame}.querySelector('#all-tasks').hidden`), false);
        assert.equal(messages.length, count, "Returning to overview must not insert a user message");
      }
      await evaluate(`Array.from(${frame}.querySelectorAll('.task')).find(row=>row.textContent.includes(${JSON.stringify(title)})).querySelector('button').click()`);
      await selected(id);
    };
    await until(async () => (await text()).includes("全部材料"), "initial checklist");
    assert.doesNotMatch(await text(), /尚待|2025|材料依据/);
    // Top-level entry must both change the task view AND ask the current chat to continue.
    await click("开始准备"); await selected("schengen_form");
    if (mode === "no-context") {
      await until(async () => (await text()).includes("当前客户端不支持此操作"), "unsupported context error");
      assert.equal(messages.length, 0, "Never expose IDs or send an ambiguous trigger if background delivery failed");
      assert.doesNotMatch(await text(), /申请 ID|start_task/);
      return;
    }
    await until(() => messages.length === 1, "top button chat handoff");
    assert.equal(messages[0].content[0].text, "准备统一申根签证申请表");
    assert.equal(contexts.at(-1).taskId, "schengen_form");
    assert.equal(contexts.at(-1).applicationId, application.id);
    assert.equal(contexts.at(-1).nextAction.type, "prepare_form");
    assert.equal(await evaluate(`${frame}.querySelector('#all-tasks').hidden`), true);
    assert.equal(await evaluate(`${frame}.querySelector('progress').getAttribute('aria-label')`), "当前任务阶段进度");
    assert.match(await text(), /阶段 1 \/ 3/);
    assert.doesNotMatch(await text(), /已完成 0 \/ 12 项材料/);
    await click("查看已生成的预填表"); await until(async () => (await store.get(application.id)).taskFlow?.node === "filling");
    await until(async () => (await text()).includes("阶段 2 / 3"));
    const guideUrl = await evaluate(`${frame}.querySelector('a[href*="/guides/"]').href`);
    const page = await (await fetch(guideUrl)).text(); assert.equal((page.match(/data-page="/g) ?? []).length, 4);
    assert.doesNotMatch(page, /填好后的自查|□/);
    const pdfUrl = await evaluate(`${frame}.querySelector('a[href*="/forms/"]').href`);
    const pdfResponse = await fetch(pdfUrl); assert.equal(pdfResponse.status, 200);
    assert.equal((await PDFDocument.load(await pdfResponse.arrayBuffer())).getForm().getTextField("Intended date of arrival 1").getText(), "01-06-2027");
    if (mode === "standard") {
      await click("下载预填申请表 PDF"); await until(() => downloads.length === 1, "PDF download channel");
      assert.equal(downloads[0].contents[0].mimeType, "application/pdf");
    } else assert.match(await text(), /打开预填PDF后可另存为文件/);
    await click("按提示自己填写");
    await until(async () => (await store.get(application.id)).taskFlow?.data.fillMode === "manual" && await idle());
    assert.equal(contexts.at(-1).nextAction.type, "open_url");
    await click("让助手帮我预填");
    await until(async () => (await store.get(application.id)).taskFlow?.data.fillMode === "assisted" && await idle());
    assert.equal(contexts.at(-1).nextAction.type, "prepare_form");
    await click("保存并暂停，准备其他材料");
    await until(async () => !(await store.get(application.id)).activeTask && await idle());
    assert.match(await text(), /已暂停/);
    assert.equal(await evaluate(`${frame}.querySelector('progress').getAttribute('aria-label')`), "材料准备完成进度");
    assert.equal(await evaluate(`${frame}.querySelector('#all-tasks').hidden`), false);
    // Per-material entry exercises errors visibly, then succeeds without redoing the interview.
    failStart = true;
    await evaluate(`Array.from(${frame}.querySelectorAll('.task')).find(row=>row.textContent.includes('护照照片')).querySelector('button').click()`);
    await until(async () => (await text()).includes("测试连接暂不可用"), "visible tool error");
    const beforePhoto = messages.length;
    await selectRow("photo", "护照照片"); await until(() => messages.length === beforePhoto + 1, "row button chat handoff");
    assert.equal(messages.at(-1).content[0].text, "准备护照照片");
    assert.equal(contexts.at(-1).taskId, "photo");
    assert.match(await text(), /阶段 1 \/ 2/);
    await click("不上传，自己检查"); await until(async () => (await store.get(application.id)).taskFlow?.node === "self_check"); await until(idle);
    assert.match(await text(), /阶段 2 \/ 2/);
    await evaluate(`${frame}.querySelector('input[type=checkbox]').click()`);
    const flow = (await store.get(application.id)).taskFlow, check = flow.checkCatalog[0].id;
    await click("保存并暂停，准备其他材料"); await until(async () => !(await store.get(application.id)).activeTask && await idle());
    const persisted = await new ApplicationStore(store.filePath).get(application.id);
    assert.equal(persisted.tasks.find(({ id }) => id === "photo").status, "paused");
    await selectRow("schengen_form", "统一申根签证申请表");
    assert.equal((await store.get(application.id)).taskFlow.node, "filling");
    assert.equal((await store.get(application.id)).taskFlow.data.fillMode, "assisted");
    assert.match(await text(), /阶段 2 \/ 3/);
    await selectRow("photo", "护照照片");
    assert.equal((await store.get(application.id)).taskFlow.node, "self_check");
    assert.equal((await store.get(application.id)).taskFlow.data.checks[check], true);
    await evaluate(`Array.from(${frame}.querySelectorAll('input[type=checkbox]')).filter(input=>!input.checked).forEach(input=>input.click())`);
    const messageCount = messages.length;
    await click("确认完成这项材料");
    await until(async () => !(await store.get(application.id)).activeTask && await idle(), "complete returns to full list");
    assert.equal(await evaluate(`${frame}.querySelector('#all-tasks').hidden`), false);
    assert.equal(await evaluate(`${frame}.querySelector('progress').value`), 1);
    assert.match(await evaluate(`Array.from(${frame}.querySelectorAll('.task')).find(row=>row.textContent.includes('护照照片')).textContent`), /已完成/);
    assert.match(await evaluate(`Array.from(${frame}.querySelectorAll('.task')).find(row=>row.textContent.includes('统一申根签证申请表')).textContent`), /已暂停/);
    assert.equal(messages.length, messageCount, "Completion must show the queue without another synthetic user message");
    for (const message of messages) {
      assert.doesNotMatch(JSON.stringify(message), /[0-9a-f]{8}-[0-9a-f-]{27,}|申请 ID|材料任务 ID|start_task|advance_task|applicationId|taskId/);
    }
    assert.equal((await store.get(application.id)).answers.arrivalDate, basicAnswers.arrivalDate);
    assert.equal(activeBrowser.errors.length, 0);
    assert.ok(calls.some(({ name, arguments: args }) => name === "start_task" && args.action === "pause"));
  } finally {
    await activeBrowser?.close(); await new Promise((resolve) => server.close(resolve));
    await client.close(); await mcp.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
