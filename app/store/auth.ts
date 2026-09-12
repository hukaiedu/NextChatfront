import { create } from "zustand";

import {
  AuthSessionInfo,
  BackendApiError,
  BackendUserType,
  bootstrapAnonymous,
  getAuthSession,
  login as apiLogin,
  logout as apiLogout,
  setUnauthorizedHandler,
} from "../client/backend-api";
import { closeAllStreams } from "./active-streams";

/**
 * V1.3-C §7/§8/§9:匿名自动进入的认证状态机(用户已明确授权本轮前端改造)。
 *
 * 状态:
 * - unknown        刚加载,还没探测
 * - bootstrapping  正在探测 / 建匿名身份
 * - authenticated  有有效身份(ANONYMOUS / ADMIN / REGISTERED)
 * - blocked        DISABLED Cookie:后端拒发匿名身份(401),重试无用
 * - error          网络/5xx:可手动 Retry
 *
 * 真相永远来自 GET /auth/session(§46),localStorage 不参与;
 * Cookie 是 HttpOnly(§47),前端不读也不写。
 */
export type AuthStatus =
  | "unknown"
  | "bootstrapping"
  | "authenticated"
  | "blocked"
  | "error";

export type AuthUserType = BackendUserType;

/** 登录表单错误:code 对应后端错误信封,或本地 NETWORK_ERROR / ADMIN_UNAVAILABLE */
export interface LoginError {
  code: string;
  /** AUTH_RATE_LIMITED 时来自 Retry-After 头的秒数 */
  retryAfterSeconds?: number;
}

interface AuthState {
  status: AuthStatus;
  userType: AuthUserType | null;
  expiresAt: string | null;
  /**
   * FIX-02 身份实例代数:本地原以为有效的身份其实已经没了就 +1(主动清除,或探测
   * 回来说没有)。两个身份可以 userType 完全相同(旧匿名 Session 被吊销 → 新匿名),
   * 光比 userType 会漏;React 把「失效 → 重建」合并成一次渲染也会漏。
   */
  identityEpoch: number;
  /** error 态的失败原因码;离开 error 时清空 */
  bootstrapErrorCode: string | null;
  adminLoginError: LoginError | null;
  /** 最近一次 Admin logout 失败原因;成功或身份失效时清空 */
  logoutError: LoginError | null;
}

interface AuthActions {
  /**
   * 页面启动引导(§5/§9):session 有效 → 直接 authenticated;
   * 无有效身份 → POST /auth/anonymous 建匿名身份。single-flight,
   * React StrictMode 双 effect 不会重复建 User(§12/§13)。
   * 网络/5xx 自动重试 1 次,仍失败进 error(§11)。
   */
  bootstrap(): Promise<void>;
  /** error 态的用户手动重试(不自动循环,§10/§11) */
  retryBootstrap(): void;
  /**
   * 轻量身份刷新(§45):focus / visibilitychange 时重新探测;
   * 若身份已失效则重新 bootstrap,不重放任何业务请求(§14)。
   */
  refreshIdentity(): void;
  /**
   * 管理员登录(§19):只有「authenticated === true 且 userType === ADMIN」才算成功;
   * COMPAT 模式下 200 + ANONYMOUS 必须判为 Admin unavailable。
   */
  adminLogin(password: string): Promise<boolean>;
  /**
   * 主动登出(§43):仅 /auth/logout 成功(204)后才清本地状态。
   * 失败保持既有状态并写 logoutError。
   */
  logout(): Promise<boolean>;
  /**
   * 业务 API 401(§14):标记当前 identity 失效 → 重新 bootstrap。
   * **不重放原 mutation**(调用方自己提示用户重试)。
   */
  markIdentityStale(): void;
  /**
   * 清空本地身份但不重新引导(§42):revoke-all 之后 Cookie 已失效,
   * 此时自动 bootstrap 会立刻建出新的匿名身份,掩盖「已登出」的事实。
   */
  clearIdentity(): void;
}

export type AuthStore = AuthState & AuthActions;

/** bootstrap 的网络/5xx 自动重试次数:首次 + 重试 1 次(§11) */
const BOOTSTRAP_MAX_ATTEMPTS = 2;

/** 整个页面生命周期内共享的 in-flight bootstrap(§12/§13) */
let bootstrapInFlight: Promise<void> | null = null;

function isRetryable(error: unknown): boolean {
  // 401(AUTH_REQUIRED,含 DISABLED)等确定性拒绝不重试;网络/5xx 才重试
  if (error instanceof BackendApiError) {
    return (
      error.status >= 500 ||
      error.status === 0 ||
      error.code === "NETWORK_ERROR"
    );
  }
  return true;
}

export const useAuthStore = create<AuthStore>()((set, get) => {
  /** 单次尝试:probe → 必要时 anonymous */
  async function attempt(): Promise<"ok" | "blocked" | "retry"> {
    try {
      const session = await getAuthSession();
      if (session.authenticated) {
        set({
          status: "authenticated",
          userType: session.userType ?? null,
          expiresAt: session.expiresAt,
          bootstrapErrorCode: null,
        });
        return "ok";
      }
      // FIX-02:本地还自认有效,后端却说没有 —— 接下来建的是「另一个身份」
      if (get().status === "authenticated") {
        set({ identityEpoch: get().identityEpoch + 1 });
      }
      const created = await bootstrapAnonymous();
      set({
        status: "authenticated",
        userType: created.userType ?? null,
        expiresAt: created.expiresAt,
        bootstrapErrorCode: null,
      });
      return "ok";
    } catch (error) {
      console.error("[Auth] 匿名身份引导失败", error);
      if (error instanceof BackendApiError && error.status === 401) {
        // §10:DISABLED Cookie 指向的用户被拒绝,不新建、不循环
        set({
          status: "blocked",
          userType: null,
          expiresAt: null,
          bootstrapErrorCode: error.code,
        });
        return "blocked";
      }
      return isRetryable(error) ? "retry" : "blocked";
    }
  }

  async function runBootstrap(): Promise<void> {
    if (get().status !== "authenticated") {
      set({ status: "bootstrapping" });
    }
    for (let i = 0; i < BOOTSTRAP_MAX_ATTEMPTS; i += 1) {
      const result = await attempt();
      if (result === "ok" || result === "blocked") return;
      if (i === BOOTSTRAP_MAX_ATTEMPTS - 1) {
        set({
          status: "error",
          userType: null,
          expiresAt: null,
          bootstrapErrorCode: "NETWORK_ERROR",
        });
        return;
      }
    }
  }

  function sharedBootstrap(): Promise<void> {
    bootstrapInFlight ??= runBootstrap().finally(() => {
      bootstrapInFlight = null;
    });
    return bootstrapInFlight;
  }

  function clearIdentity() {
    closeAllStreams();
    set({
      status: "unknown",
      userType: null,
      expiresAt: null,
      identityEpoch: get().identityEpoch + 1,
      adminLoginError: null,
      logoutError: null,
    });
  }

  return {
    status: "unknown",
    userType: null,
    expiresAt: null,
    identityEpoch: 0,
    bootstrapErrorCode: null,
    adminLoginError: null,
    logoutError: null,

    async bootstrap() {
      // authenticated 无需重复;blocked / error 是确定性终态,只由手动 Retry 离开(§10/§11)
      if (get().status === "authenticated") return;
      if (get().status === "blocked" || get().status === "error") return;
      await sharedBootstrap();
    },

    retryBootstrap() {
      if (get().status === "bootstrapping") return;
      bootstrapInFlight = null;
      set({ bootstrapErrorCode: null });
      void sharedBootstrap();
    },

    refreshIdentity() {
      const { status } = get();
      if (
        status === "bootstrapping" ||
        status === "blocked" ||
        status === "error"
      ) {
        return;
      }
      void sharedBootstrap();
    },

    async adminLogin(password) {
      try {
        const session = await apiLogin(password);
        // §19:200 不等于成功,必须 authenticated === true 且 userType === ADMIN
        if (!session.authenticated || session.userType !== "ADMIN") {
          set({
            adminLoginError: { code: "ADMIN_UNAVAILABLE" },
            status: "authenticated",
            userType: session.userType ?? "ANONYMOUS",
            expiresAt: session.expiresAt,
          });
          return false;
        }
        set({
          status: "authenticated",
          userType: "ADMIN",
          expiresAt: session.expiresAt,
          adminLoginError: null,
          bootstrapErrorCode: null,
        });
        return true;
      } catch (error) {
        set({
          adminLoginError:
            error instanceof BackendApiError
              ? {
                  code: error.code,
                  retryAfterSeconds: error.retryAfterSeconds,
                }
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
              ? {
                  code: error.code,
                  retryAfterSeconds: error.retryAfterSeconds,
                }
              : { code: "NETWORK_ERROR" },
        });
        return false;
      }
      clearIdentity();
      return true;
    },

    markIdentityStale() {
      if (get().status !== "authenticated") return;
      clearIdentity();
      // §14:重新进入 bootstrap(按需建新匿名身份),不重放失败的业务请求
      get().refreshIdentity();
    },

    clearIdentity,
  };
});

// 全局 401 → 标记身份失效并重新引导;回调在模块加载时注册
setUnauthorizedHandler(() => useAuthStore.getState().markIdentityStale());

/** 测试用:清空跨用例共享的 in-flight bootstrap */
export function resetAuthBootstrapState(): void {
  bootstrapInFlight = null;
}
