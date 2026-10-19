/**
 * V1.3-C §22/§41:Admin Console 的 API 客户端。
 *
 * 与 Public 客户端(app/client/backend-api.ts)刻意分层:
 * - 这里的类型含运维内部字段(authCheck / failureCode),只能被 /admin 页面消费,
 *   不得进入普通聊天 UI。
 * - 所有请求走 canonical `/backend-api/admin/*`;浏览器运行时与页面登录相关端点
 *   已随后端退役,前端零引用。
 */

import { callBackend } from "./backend-api";

/**
 * POST /api/admin/sessions/revoke-all:吊销调用者(ADMIN)的全部 Session(含当前这条)。
 * 后端删库成功后会清 Cookie;前端收到成功后必须清本地认证状态并回到 /admin/login。
 */
export function revokeAllAdminSessions(): Promise<{ revoked: number }> {
  return callBackend<{ revoked: number }>("/admin/sessions/revoke-all", {
    method: "POST",
  });
}

/** 后端 Python Worker 暴露的运行状态(与 provider-runtime.ts 的枚举一致)。 */
export type AdminProviderState = "READY" | "BUSY" | "LOGIN_REQUIRED";

/** Provider 状态轮询间隔:页面可见时刷新,隐藏时跳过,卸载即停表 */
export const PROVIDER_STATUS_POLL_INTERVAL_MS = 15000;

export interface AdminProviderStatus {
  /** 后端回显的 Provider 标识(GEMINI_WEB),仅 Admin 面可见 */
  provider: string;
  status: AdminProviderState;
  /** GET/CHECK 返回;RESTART 只返回 provider + status */
  authCheck?: AdminProviderAuthCheck;
}

export interface AdminProviderAuthCheck {
  result:
    | "NOT_CHECKED"
    | "MODEL_CATALOG_OK"
    | "LOGIN_REQUIRED"
    | "BUSY"
    | "NOT_READY"
    | "CHECK_FAILED";
  /** 后端明确声明:只验证模型目录,不代表聊天生成可用 */
  scope: "MODEL_CATALOG_ONLY";
  checkedAt: string | null;
  modelCount: number | null;
  failureCode: string | null;
}

export function getAdminProviderStatus(
  signal?: AbortSignal,
): Promise<AdminProviderStatus> {
  return callBackend<AdminProviderStatus>("/admin/provider/status", { signal });
}

/** POST /api/admin/provider/check:检查凭据能否完成模型目录请求，不发送聊天消息。 */
export function checkAdminProvider(
  signal?: AbortSignal,
): Promise<AdminProviderStatus> {
  return callBackend<AdminProviderStatus>("/admin/provider/check", {
    method: "POST",
    signal,
  });
}

/**
 * POST /api/admin/provider/restart:重启后端 Python Worker。
 * 已有重启或活动请求时后端返回 409 PROVIDER_RESTART_CONFLICT;
 * HTTP 等待超时返回 504 PROVIDER_RESTART_TIMEOUT(后台可能仍在重启)。
 */
export function restartAdminProvider(
  signal?: AbortSignal,
): Promise<AdminProviderStatus> {
  return callBackend<AdminProviderStatus>("/admin/provider/restart", {
    method: "POST",
    signal,
  });
}
