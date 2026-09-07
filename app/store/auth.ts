import { create } from "zustand";

import {
  BackendApiError,
  getAuthSession,
  login as apiLogin,
  logout as apiLogout,
  setUnauthorizedHandler,
} from "../client/backend-api";
import { closeAllStreams } from "./active-streams";

/**
 * SEC-1 §11.1:认证状态机。localStorage 一律不做真相源,
 * 每次页面加载由 AuthGate 触发 probe() 重新判定。
 */
export type AuthStatus = "checking" | "authenticated" | "unauthenticated";

/** 登录表单错误:code 对应后端错误信封,或本地 NETWORK_ERROR */
export interface LoginError {
  code: string;
  /** AUTH_RATE_LIMITED 时来自 Retry-After 头的秒数 */
  retryAfterSeconds?: number;
}

interface AuthState {
  status: AuthStatus;
  expiresAt: string | null;
  loginError: LoginError | null;
  /** 最近一次 logout 失败原因;成功登出或全局 401 下线时清空 */
  logoutError: LoginError | null;
}

interface AuthActions {
  /** 页面加载探测;/api/auth/session 永不 401,无异常分支(网络失败保持 checking) */
  probe(): Promise<void>;
  /** 登录;成功返回 true,失败把错误写入 loginError(不触发全局登出) */
  login(password: string): Promise<boolean>;
  /**
   * 主动登出(§8.1-B):仅 /auth/logout 成功(204)后才关全部 SSE 并迁移
   * unauthenticated。Cookie 是 HttpOnly,前端删不掉,服务端未确认前下线 =
   * UI 显示已退出而 Cookie 仍有效,刷新即重新 authenticated。失败保持
   * authenticated 与既有 SSE,错误写入 logoutError,返回 false。
   */
  logout(): Promise<boolean>;
  /** 全局 401 / SSE probe 失效;幂等,仅 authenticated → unauthenticated 单向迁移 */
  markUnauthorized(): void;
}

export type AuthStore = AuthState & AuthActions;

export const useAuthStore = create<AuthStore>()((set, get) => ({
  status: "checking",
  expiresAt: null,
  loginError: null,
  logoutError: null,

  async probe() {
    const session = await getAuthSession();
    set({
      status: session.authenticated ? "authenticated" : "unauthenticated",
      expiresAt: session.expiresAt,
    });
  },

  async login(password) {
    try {
      const session = await apiLogin(password);
      set({
        status: "authenticated",
        expiresAt: session.expiresAt,
        loginError: null,
      });
      return true;
    } catch (error) {
      set({
        loginError:
          error instanceof BackendApiError
            ? { code: error.code, retryAfterSeconds: error.retryAfterSeconds }
            : { code: "NETWORK_ERROR" },
      });
      return false;
    }
  },

  async logout() {
    try {
      await apiLogout();
    } catch (error) {
      set({
        logoutError:
          error instanceof BackendApiError
            ? { code: error.code, retryAfterSeconds: error.retryAfterSeconds }
            : { code: "NETWORK_ERROR" },
      });
      return false;
    }
    closeAllStreams();
    set({
      status: "unauthenticated",
      expiresAt: null,
      loginError: null,
      logoutError: null,
    });
    return true;
  },

  markUnauthorized() {
    if (get().status !== "authenticated") return;
    closeAllStreams();
    set({
      status: "unauthenticated",
      expiresAt: null,
      loginError: null,
      logoutError: null,
    });
  },
}));

// §11.1:全局 401 → markUnauthorized;回调在模块加载时注册
setUnauthorizedHandler(() => useAuthStore.getState().markUnauthorized());
