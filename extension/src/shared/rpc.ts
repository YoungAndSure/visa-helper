/**
 * RPC 客户端骨架。
 *
 * Phase B 阶段：只实装 health()。其他方法（suggest / extract / verify / run /
 * checklist）留空骨架，等 Phase D 接 RPC 时补完。
 *
 * 设计要点：
 * - 所有调用返回 RpcResult<T>，模块只判 ok / reason，不抛异常
 * - 网络失败 → reason='offline'
 * - HTTP 4xx/5xx → reason='http' + status + detail
 * - response 里 value=null + rationale 含 'LLM' → reason='unconfigured'
 */

import type { RpcResult } from "./types";

export class RpcClient {
  constructor(public backendUrl: string) {}

  setBackendUrl(url: string): void {
    this.backendUrl = url;
  }

  /** 轻量探活,设置 tab 也用这个 */
  async health(): Promise<RpcResult<{ status: string; llm_available: boolean }>> {
    try {
      const r = await fetch(`${this.backendUrl}/healthz`);
      if (!r.ok) {
        return { ok: false, reason: "http", status: r.status };
      }
      const data = (await r.json()) as { status: string; llm_available: boolean };
      return { ok: true, data };
    } catch {
      return { ok: false, reason: "offline" };
    }
  }

  // ---- Phase D 占位（接 RPC 时实装） ----
  async _formAssistSuggest(_req: unknown): Promise<RpcResult<unknown>> {
    return { ok: false, reason: "unconfigured", detail: "Phase B: not wired yet" };
  }
  async _formAssistExtract(_req: unknown): Promise<RpcResult<unknown>> {
    return { ok: false, reason: "unconfigured", detail: "Phase B: not wired yet" };
  }
  async _materialAuditVerify(_req: unknown): Promise<RpcResult<unknown>> {
    return { ok: false, reason: "unconfigured", detail: "Phase B: not wired yet" };
  }
  async _materialAuditChecklist(_country: string): Promise<RpcResult<unknown>> {
    return { ok: false, reason: "unconfigured", detail: "Phase B: not wired yet" };
  }
  async _materialAuditRun(_req: unknown): Promise<RpcResult<unknown>> {
    return { ok: false, reason: "unconfigured", detail: "Phase B: not wired yet" };
  }
}