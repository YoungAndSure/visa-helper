/**
 * visa-helper service worker (background script, MV3)
 *
 * Phase 0 范围:
 * - 注册 sidePanel 行为（用户点工具栏图标自动打开侧边栏到当前 tab）
 * - 收到 content script 的 "field-focus" 事件时打日志（Phase 2 起改成调用 /suggest）
 * - 提供一个 ping handler 用来从 sidepanel 验证 service worker 是否活跃
 */

const log = (...args: unknown[]) => console.log("[visa-helper/sw]", ...args);

log("service worker alive");

// 把 toolbar 按钮的点击切换成"为当前 tab 打开 side panel"
// （现在 Chrome 124+ 也允许所有页面都开，但点按钮更显式）
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  switch (msg.kind) {
    case "ping": {
      sendResponse({ ok: true, t: Date.now(), where: "service-worker" });
      break;
    }
    case "get-active-url": {
      // 侧边栏自己也能调 chrome.tabs.query，但经 SW 走可以统一在这层加白名单/缓存。
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const url = tabs[0]?.url ?? "";
        sendResponse({ ok: true, url });
      });
      return true; // 异步 sendResponse 必须 return true
    }
    case "field-focus": {
      // Phase 0：仅日志。Phase 2 起：拉后端 /suggest 后把建议 push 给 active 的 side panel。
      log("field-focus", {
        selector: msg.selector,
        label: msg.label,
        type: msg.type,
      });
      sendResponse({ ok: true, ack: "logged" });
      break;
    }
    case "field-fill": {
      // Phase 2 起：sidepanel 让内容脚本写入。Phase 0 暂无实现，先 log。
      log("field-fill req", { selector: msg.selector, value: msg.value });
      sendResponse({ ok: true });
      break;
    }
    default:
      sendResponse({ ok: false, error: `unknown kind: ${(msg as { kind: string }).kind}` });
  }
  return true; // 保持 sendResponse 通道
});
