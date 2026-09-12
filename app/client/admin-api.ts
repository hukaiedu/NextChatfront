/**
 * V1.3-C §22/§41:Admin Console 的 API 客户端。
 *
 * 与 Public 客户端(app/client/backend-api.ts)刻意分层:
 * - 这里的类型含运维内部字段(profileDir / providerLoggedIn / headless / browserType / lastError),
 *   只能被 /admin 页面消费,不得进入普通聊天 UI。
 * - 所有请求走 canonical `/backend-api/admin/*`;旧 `/browser/*`、`/provider/status` 等
 *   兼容 alias 已随 V1.3-C 从后端删除,前端零引用。
 */

import { callBackend } from "./backend-api";

/** 后端浏览器实例的生命周期状态 */
export type AdminBrowserState =
  | "RUNNING"
  | "STARTING"
  | "RESTARTING"
  | "STOPPED"
  | "FAILED";

export interface AdminBrowserError {
  code: string;
  message?: string | null;
}

/** GET /api/admin/browser/status 的负载(BrowserStatusSnapshot) */
export interface AdminBrowserStatus {
  state: AdminBrowserState;
  /** "chromium" */
  browserType: string;
  headless: boolean;
  /** 持久化 Profile 目录(运维字段) */
  profileDir: string;
  startedAt: string | null;
  uptimeMs: number | null;
  /** Provider 登录态;null = 后端未探测 */
  providerLoggedIn: boolean | null;
  /** 正在 PENDING / PROCESSING / CANCELLING 的 Request 数 */
  activeRequests: number;
  lastError: AdminBrowserError | null;
  /** 后端生成该快照的时间(ISO) */
  observedAt: string;
}

export function getAdminBrowserStatus(): Promise<AdminBrowserStatus> {
  return callBackend<AdminBrowserStatus>("/admin/browser/status");
}

/** POST /api/admin/browser/restart:耗时较长(关旧实例 + 起新实例 + 打开 Provider 页面) */
export function restartAdminBrowser(): Promise<AdminBrowserStatus> {
  return callBackend<AdminBrowserStatus>("/admin/browser/restart", {
    method: "POST",
  });
}

/**
 * POST /api/admin/sessions/revoke-all:吊销调用者(ADMIN)的全部 Session(含当前这条)。
 * 后端删库成功后会清 Cookie;前端收到成功后必须清本地认证状态并回到 /admin/login。
 */
export function revokeAllAdminSessions(): Promise<{ revoked: number }> {
  return callBackend<{ revoked: number }>("/admin/sessions/revoke-all", {
    method: "POST",
  });
}

/**
 * Provider(Browser Manager 里那个 Provider 页面)的生命周期状态。
 * 与浏览器实例状态分开:浏览器可以已在跑但 Provider 页面还没打开/未登录。
 */
export type AdminProviderState =
  | "STOPPED"
  | "STARTING"
  | "LOGIN_REQUIRED"
  | "READY"
  | "BUSY"
  | "ERROR";

export interface AdminProviderStatus {
  /** 后端回显的 Provider 标识(GEMINI_WEB),仅 Admin 面可见 */
  provider: string;
  status: AdminProviderState;
}

export function getAdminProviderStatus(): Promise<AdminProviderStatus> {
  return callBackend<AdminProviderStatus>("/admin/provider/status");
}

/** POST /api/admin/provider/open:启动 Browser Manager 并打开/聚焦 Provider 页面 */
export function openAdminProvider(): Promise<AdminProviderStatus> {
  return callBackend<AdminProviderStatus>("/admin/provider/open", {
    method: "POST",
  });
}

/**
 * POST /api/admin/provider/restart:关闭 Context 后用同一 Profile 重启。
 * 有 Request 在飞时后端会拒绝(运维不该顺手打断生成)。
 */
export function restartAdminProvider(): Promise<AdminProviderStatus> {
  return callBackend<AdminProviderStatus>("/admin/provider/restart", {
    method: "POST",
  });
}
