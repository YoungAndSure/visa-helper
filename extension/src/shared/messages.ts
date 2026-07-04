/**
 * 跨 context 消息类型（content script ↔ background ↔ sidepanel）。
 *
 * 现有 kinds 维持现状不破坏现有 content script / background。
 * Phase D 接 RPC 时,form-assist 的 /suggest 调用通过 fetch（不走消息总线），
 * material-audit 同理。本文件只为未来扩展留接口。
 */

export type MessageKind =
  | "ping"
  | "get-active-url"
  | "field-focus"
  | "field-fill"
  | "describe-focused"
  | "fill";

export type BaseMessage = { kind: MessageKind };

export type FieldFocusMessage = BaseMessage & {
  kind: "field-focus";
  selector: string;
  label: string;
  type: string;
};

export type GetActiveUrlMessage = BaseMessage & {
  kind: "get-active-url";
};

export type PingMessage = BaseMessage & {
  kind: "ping";
};

export type GetActiveUrlResponse = { ok: true; url: string } | { ok: false; error: string };

export type PingResponse = { ok: true; t: number; where: string };

export type FieldFocusResponse = { ok: true; ack: string } | { ok: false; error: string };

/** 任意 message 的并集 — handler 用这个 union 收消息即可。 */
export type AppMessage = FieldFocusMessage | GetActiveUrlMessage | PingMessage;