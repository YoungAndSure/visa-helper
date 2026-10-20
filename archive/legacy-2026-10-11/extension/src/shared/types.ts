/**
 * 跨模块共享的 TS 类型。
 *
 * 这些类型同时被 sidepanel shell + 两个 module 使用。
 * 业务专属类型（form-assist 自己用什么、material-audit 自己用什么）
 * 放在各自 module 内的 types.ts / schemas.ts，本文件只放真正"共用"的。
 */

/** 字段被聚焦时 content script 抓到的描述 */
export type FieldDescriptor = {
  selector: string;
  label: string;
  type: string;
};

/** 申请人上下文(KYC),与后端 shared/schemas_common.py 的 ApplicantContext 同步 */
export type ApplicantContext = {
  full_name?: string | null;
  full_name_romanized?: string | null;
  passport_no?: string | null;
  id_card_no?: string | null;
  dob?: string | null;
  nationality?: string | null;
  occupation?: string | null;
  employer?: string | null;
  address?: string | null;
  phone?: string | null;
  extra?: Record<string, string>;
};

/** Shell 传给 module 的 ctx */
export type ShellContext = {
  backendUrl: string;
  detectedSite: SiteProfile | null;
  onError?: (reason: string) => void;
};

/** 通用 RPC 返回值 */
export type RpcResult<T> =
  | { ok: true; data: T; meta?: { unconfigured?: boolean } }
  | { ok: false; reason: "offline" | "http" | "unconfigured"; status?: number; detail?: string };

import type { SiteProfile } from "./sites";