(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const i of document.querySelectorAll('link[rel="modulepreload"]'))r(i);new MutationObserver(i=>{for(const l of i)if(l.type==="childList")for(const c of l.addedNodes)c.tagName==="LINK"&&c.rel==="modulepreload"&&r(c)}).observe(document,{childList:!0,subtree:!0});function s(i){const l={};return i.integrity&&(l.integrity=i.integrity),i.referrerPolicy&&(l.referrerPolicy=i.referrerPolicy),i.crossOrigin==="use-credentials"?l.credentials="include":i.crossOrigin==="anonymous"?l.credentials="omit":l.credentials="same-origin",l}function r(i){if(i.ep)return;i.ep=!0;const l=s(i);fetch(i.href,l)}})();const d=[{id:"vfs-is",label:"冰岛 · VFS Global",country:"IS",flow:"visa",defaultView:"form-assist",contextHint:"申根短期签证（C 類）填表伴行",urlPatterns:[/vfsglobal\.com\/[^/]*\/iceland/i,/^https?:\/\/is\.vfsglobal\.com/i]},{id:"udi-no",label:"挪威 · UDI",country:"NO",flow:"residence",defaultView:"form-assist",contextHint:"居留许可申请表逐项解释",urlPatterns:[/^https?:\/\/(www\.)?udi\.no\//i]},{id:"vfs-no",label:"挪威 · VFS Global",country:"NO",flow:"visa",defaultView:"form-assist",contextHint:"挪威 VFS 表单伴行",urlPatterns:[x("norway","no")]}];function x(e,t){return new RegExp(`vfsglobal\\.com[^/]*\\/(?:[a-z-]+\\/)?${e}|${t}\\.vfsglobal\\.com`,"i")}function h(e){for(const t of d)if(t.urlPatterns.some(s=>s.test(e)))return t;return null}function S(e){return e?.defaultView??"form-assist"}const n=e=>document.querySelector(e),o={url:"(loading)",detectedSite:null,view:"form-assist",userChoseView:!1,formAssistSiteId:null,auditCountryId:null};function L(){const e=o.formAssistSiteId;return e?d.find(t=>t.id===e)??null:o.detectedSite}function $(){const e=o.auditCountryId;return e?d.find(t=>t.id===e)??null:null}const p=document.querySelectorAll(".tab"),m={"form-assist":n("#view-form-assist"),"material-audit":n("#view-material-audit"),settings:n("#view-settings")},u=n("#dot-sw"),v=n("#status-sw"),a=n("#diag"),f=n("#backend-status"),C="http://localhost:8000";let E=C;function g(){p.forEach(e=>{e.setAttribute("aria-selected",String(e.dataset.view===o.view))}),Object.keys(m).forEach(e=>{m[e].hidden=e!==o.view})}function y(){const e=n("#form-assist-body"),t=L(),s=`
    <div class="site-selector" style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <label for="fa-site" style="color:var(--muted);font-size:12px;flex:0 0 auto">当前 site</label>
      <select id="fa-site" style="flex:1;font:inherit;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg)">
        <option value="" ${o.formAssistSiteId===null?"selected":""}>自动（URL 检测${o.detectedSite?` · ${o.detectedSite.country}`:""}）</option>
        ${d.map(i=>`<option value="${i.id}" ${o.formAssistSiteId===i.id?"selected":""}>${i.label}</option>`).join("")}
      </select>
    </div>
  `;if(!t){e.innerHTML=s+'<div style="color:var(--muted);font-size:13px">未匹配站点 — 在上方选择 site 进入填表流程即可（"自动" 模式只在 URL 命中已注册 site 时有效）。</div>';return}e.innerHTML=s+`
    <div style="font-size:13px">
      <div><b>${t.label}</b> · <span style="color:var(--muted)">${t.contextHint}</span></div>
      <div style="margin-top:8px;color:var(--muted)">
        Phase 0 占位：将来此处显示"当前 tab 已聚焦的字段列表 + 填入建议"。
      </div>
      <ul style="margin-top:8px">
        <li>点击 VFS 表单字段 → content script 抓 <code>{label, type}</code></li>
        <li>service worker 在 console 打 <code>field-focus</code></li>
        <li>本 view 实时收到并展示</li>
      </ul>
    </div>
  `;const r=n("#fa-site");r&&r.addEventListener("change",()=>{o.formAssistSiteId=r.value||null,y()})}function b(){const e=n("#material-audit-body"),t=$(),s=`
    <div class="audit-selector" style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <label for="ma-country" style="color:var(--muted);font-size:12px;flex:0 0 auto">审核国家</label>
      <select id="ma-country" style="flex:1;font:inherit;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg)">
        <option value="">请选择…</option>
        ${d.map(i=>`<option value="${i.id}" ${o.auditCountryId===i.id?"selected":""}>${i.label} · ${i.flow}</option>`).join("")}
      </select>
    </div>
  `;if(!t){e.innerHTML=s+`<div style="color:var(--muted);font-size:13px">
         审核哪个国家由你手动选择 — 这里不跟随 URL 检测，也不继承伴行填表的选择。
         <div style="margin-top:8px;font-size:12px">Phase 2+ 会读取 <code>audit/checklist.json</code> + <code>audit/audit.py</code> 跑核对。</div>
       </div>`;return}e.innerHTML=s+`
    <div style="font-size:13px">
      <div><b>${t.label}</b> · <span style="color:var(--muted)">${t.contextHint}</span></div>
      <div style="margin-top:8px;color:var(--muted)">
        Phase 1+：将根据所选国家加载 <code>audit/checklist-${t.country.toLowerCase()}.json</code>，
        上传材料后调 <code>POST /audit</code>（或本地 <code>audit.py</code>）。
      </div>
    </div>
  `;const r=n("#ma-country");r&&r.addEventListener("change",()=>{o.auditCountryId=r.value||null,b()})}function k(){g(),y(),b()}p.forEach(e=>{e.addEventListener("click",()=>{const t=e.dataset.view??"form-assist";o.view=t,o.userChoseView=!0,g(),t==="settings"&&w()})});function w(){a.textContent="pinging…",chrome.runtime.sendMessage({kind:"ping"},e=>{if(chrome.runtime.lastError){a.textContent="ERR: "+chrome.runtime.lastError.message,u.classList.remove("ok"),u.classList.add("err"),v.textContent="service worker 未响应";return}v.textContent=`service worker OK (${new Date(e.t).toISOString()})`,u.classList.add("ok"),a.textContent=JSON.stringify(e,null,2)})}n("#ping-sw").addEventListener("click",w);n("#ping-backend").addEventListener("click",async()=>{a.textContent="pinging backend…",f.textContent="…";try{const t=await(await fetch(`${E}/healthz`)).json();f.innerHTML=`<span class="dot ${t.llm_available?"ok":""}"></span> ${t.llm_available?"LLM 已配置":"LLM 未配置"}`,a.textContent=JSON.stringify(t,null,2)}catch(e){f.innerHTML='<span class="dot err"></span> 后端不可达',a.textContent="ERR: "+e.message}});async function A(){const e=await new Promise(t=>{chrome.runtime.sendMessage({kind:"get-active-url"},s=>{chrome.runtime.lastError||!s?.ok?chrome.tabs.query({active:!0,currentWindow:!0},r=>{t(r[0]?.url??"(no active tab)")}):t(s.url)})});o.url=e,o.detectedSite=h(e),o.userChoseView||(o.view=S(o.detectedSite)),k()}window.addEventListener("DOMContentLoaded",A);
//# sourceMappingURL=sidepanel-_gq8u-Ip.js.map
