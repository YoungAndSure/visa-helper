/**
 * visa-helper content script
 *
 * 只在 manifest.json content_scripts.matches 命中的页面（*.vfsglobal.com）注入。
 *
 * Phase 0 范围：
 * - 监听页面的 focusin 事件
 * - 把"被聚焦的字段信息"打包成 {kind: 'field-focus', selector, label, type} 发到 service worker
 *
 * Phase 2 起：service worker 拿到建议值后回送 {kind: 'fill', selector, value}，
 * 由本脚本找到目标元素、派发 input/change 事件，写回表单。
 */

(function () {
  const log = (...args: unknown[]) => console.log("[visa-helper/content]", ...args);
  log("content script loaded", location.href);

  /** 把元素路径压缩成一个稳定 selector（Phase 0 够用） */
  function shortSelector(el: Element): string {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el instanceof HTMLInputElement && el.name) return `[name="${CSS.escape(el.name)}"]`;
    if (el instanceof HTMLSelectElement && el.name) return `[name="${CSS.escape(el.name)}"]`;
    if (el instanceof HTMLTextAreaElement && el.name) return `[name="${CSS.escape(el.name)}"]`;
    // 退化到 nth-of-type
    const parent = el.parentElement;
    if (!parent) return el.tagName.toLowerCase();
    const siblings = Array.from(parent.children).filter(
      (c) => c.tagName === el.tagName,
    );
    const idx = siblings.indexOf(el) + 1;
    return `${el.tagName.toLowerCase()}:nth-of-type(${idx})`;
  }

  /** 找该 input 最近的 label（zh / en / 多语言都可能） */
  function findLabel(el: Element): string {
    // 1) <label for="...">
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return (lbl.textContent || "").trim();
      }
    }
    // 2) parent <label>
    let cur: Element | null = el;
    for (let i = 0; i < 3 && cur; i++) {
      cur = cur.parentElement;
      if (cur && cur.tagName === "LABEL") return (cur.textContent || "").trim();
    }
    // 3) 紧邻的上一兄弟元素（比如 div 包的 label + input）
    const prev = (el.parentElement?.previousElementSibling ?? el.previousElementSibling) as HTMLElement | null;
    if (prev) {
      const t = (prev.textContent || "").trim();
      if (t && t.length <= 100) return t;
    }
    return "";
  }

  function describe(el: Element): {
    selector: string;
    label: string;
    type: string;
  } {
    const tag = el.tagName.toLowerCase();
    const t =
      el instanceof HTMLInputElement
        ? (el.type || "text")
        : el instanceof HTMLSelectElement
        ? "select"
        : tag;
    return {
      selector: shortSelector(el),
      label: findLabel(el).slice(0, 120),
      type: t,
    };
  }

  /** 暴露一个挂件：如果 service worker 想主动查"当前光标所在字段"，可注入这个 */
  let lastFocused: Element | null = null;

  document.addEventListener("focusin", (ev) => {
    const t = ev.target as Element | null;
    if (!t) return;
    // 只关心表单元素，避免给 div/button 噪音
    if (
      !(t instanceof HTMLInputElement) &&
      !(t instanceof HTMLSelectElement) &&
      !(t instanceof HTMLTextAreaElement)
    ) {
      return;
    }
    lastFocused = t;
    const desc = describe(t);
    chrome.runtime.sendMessage({ kind: "field-focus", ...desc }, () => void chrome.runtime.lastError);
  });

  // 字段写回（Phase 2 起真正实现）
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.kind === "fill") {
      const { selector, value } = msg as { kind: string; selector: string; value: string };
      try {
        const el = document.querySelector(selector) as
          | HTMLInputElement
          | HTMLSelectElement
          | HTMLTextAreaElement
          | null;
        if (!el) {
          sendResponse({ ok: false, error: "element not found" });
          return true;
        }
        el.focus();
        el.value = value;
        // 触发 React 等框架能感知的事件
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
      return true;
    }
    if (msg.kind === "describe-focused") {
      if (!lastFocused) {
        sendResponse({ ok: false, error: "no focused field" });
        return true;
      }
      sendResponse({ ok: true, ...describe(lastFocused) });
      return true;
    }
    return false;
  });
})();
