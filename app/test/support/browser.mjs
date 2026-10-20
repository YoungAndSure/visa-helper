import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export async function until(fn, label = "browser condition", timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error(`Timed out: ${label}`);
}
export async function browser(root, url) {
  const cache = join(homedir(), ".cache/ms-playwright");
  const candidates = [process.env.CHROME_BIN, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  try { for (const name of await readdir(cache)) if (name.startsWith("chromium-")) candidates.push(join(cache, name, "chrome-linux64/chrome")); } catch {}
  let binary;
  for (const candidate of candidates.filter(Boolean)) try { await access(candidate, constants.X_OK); binary = candidate; break; } catch {}
  if (!binary) throw new Error("UI regression requires Chrome/Chromium. Set CHROME_BIN to an installed executable.");
  const child = spawn(binary, ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--no-proxy-server",
    "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${root}/chrome`, "--window-size=1000,1100", url], { stdio: "ignore" });
  const close = async () => { if (child.exitCode === null) { const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill(); await exited; } };
  let ws;
  try {
    const port = await until(async () => { try { return (await readFile(`${root}/chrome/DevToolsActivePort`, "utf8")).split("\n")[0]; } catch { return null; } }, "Chromium startup");
    const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((entry) => entry.type === "page"), "browser tab");
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
    let id = 0; const pending = new Map(), errors = [];
    ws.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) { const waiter = pending.get(message.id); pending.delete(message.id); if (waiter) message.error ? waiter.reject(message.error) : waiter.resolve(message.result); }
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
    });
    const cdp = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); ws.send(JSON.stringify({ id: requestId, method, params })); });
    await cdp("Runtime.enable");
    return { errors, cdp, async evaluate(expression) {
      const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }, async close() { ws.close(); await close(); } };
  } catch (error) { ws?.close(); await close(); throw error; }
}
