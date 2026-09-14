import { create } from "zustand";

import {
  AuthSessionInfo,
  BackendApiError,
  BackendUserType,
  bootstrapAnonymous,
  changePassword as apiChangePassword,
  getAuthSession,
  login as apiLogin,
  logout as apiLogout,
  registerUser as apiRegisterUser,
  revokeAllSessions as apiRevokeAllSessions,
  setUnauthorizedHandler,
  userLogin as apiUserLogin,
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

/**
 * V1.4 U4 §54/§61/§85:注册 / 登录 / 改密 / 全设备退出的统一结果。
 * 错误只作为返回值交给页面的临时 state,不进 store —— 表单报错既不该跨身份留存,
 * 也不该在换文档后还能被读到。
 */
export type AuthAttemptResult =
  | { ok: true; session?: AuthSessionInfo }
  | { ok: false; error: LoginError };

function toLoginError(error: unknown): LoginError {
  return error instanceof BackendApiError
    ? { code: error.code, retryAfterSeconds: error.retryAfterSeconds }
    : { code: "NETWORK_ERROR" };
}

interface AuthState {
  status: AuthStatus;
  userType: AuthUserType | null;
  expiresAt: string | null;
  /**
   * V1.4 U4 §13/§68:REGISTERED 的展示登录名;ANONYMOUS / ADMIN / 未认证一律 null,
   * 换身份与清身份时都会归零,绝不让上一个账号的名字留在界面上。
   */
  username: string | null;
  /**
   * V1.4 U4 §16/§18:「本 Tab 自己刚刚注册成功」的一次性标记。
   * 只在 registerUser 成功时置 true,AuthGate 观测到身份变化时消费一次即归 false;
   * 不写 localStorage / sessionStorage / Cookie,换文档自然消失。
   */
  sameSubjectTransition: boolean;
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
   * U4 §17:可等待版的同一件事。注册 / 改密后要先确认后端的权威身份再动 UI,
   * 所以需要一个能 await 的探测口,而不是 fire-and-forget 的 refreshIdentity。
   */
  probeIdentity(): Promise<void>;
  /**
   * U4 §16/§17:把当前匿名身份原地注册为 REGISTERED。
   * 成功 → 先置一次性 sameSubjectTransition,再由 probeIdentity 落成 REGISTERED 身份,
   * 于是当前文档里的 AuthGate 会看到 ANONYMOUS → REGISTERED 但不重置聊天视图。
   * 任何失败都不得置标记、不得清 chat、不得动 identityEpoch(§19)。
   */
  registerUser(username: string, password: string): Promise<AuthAttemptResult>;
  /**
   * U4 §10/§20:Registered 账号登录 = **换主体**。
   * 这里只负责拿 Cookie;清身份 / 清聊天 / 整页换文档由调用方编排
   * (store 不得依赖 chat store,见 AUTH-GUARD-01)。
   */
  userLogin(username: string, password: string): Promise<AuthAttemptResult>;
  /**
   * U4 §11/§42:改密成功 = 后端已轮换当前 Session、撤销其它设备。
   * userId 没变 ⇒ 只更新身份负载,绝不 resetForIdentity、绝不 epoch++。
   */
  changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<AuthAttemptResult>;
  /**
   * U4 §12/§43:撤销自己的全部 Session(含当前)。成功后按 §42 纪律
   * 清本地身份但**不**自动 bootstrap,新的匿名身份留给回首页时再建。
   */
  revokeAllSessions(): Promise<AuthAttemptResult>;
  /**
   * U4 §18:读一次即清零。只有 AuthGate 亲眼看到身份变化时才调用,
   * 保证「刚注册」这个信息不会被下一个真正的换主体复用。
   */
  consumeSameSubjectTransition(): boolean;
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
          username: session.username ?? null,
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
        username: created.username ?? null,
        expiresAt: created.expiresAt,
        // 能走到这里说明本 Tab 当前这个身份是刚建出来的匿名,与「刚注册」无关(§16)
        sameSubjectTransition: false,
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
          username: null,
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
          username: null,
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
      username: null,
      expiresAt: null,
      // §18/§45:换主体即作废「刚注册」这件事,不留到下一个身份
      sameSubjectTransition: false,
      identityEpoch: get().identityEpoch + 1,
      adminLoginError: null,
      logoutError: null,
    });
  }

  return {
    status: "unknown",
    userType: null,
    username: null,
    sameSubjectTransition: false,
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
      void get().probeIdentity();
    },

    async probeIdentity() {
      const { status } = get();
      if (
        status === "bootstrapping" ||
        status === "blocked" ||
        status === "error"
      ) {
        return;
      }
      await sharedBootstrap();
    },

    consumeSameSubjectTransition() {
      if (!get().sameSubjectTransition) return false;
      set({ sameSubjectTransition: false });
      return true;
    },

    async registerUser(username, password) {
      try {
        // §17:200 之后先立「同一主体」这件事,再让 probe 把 REGISTERED 落进 store;
        // 身份字段的唯一出处是 attempt() 里的 GET /auth/session,不在这里另写一套。
        await apiRegisterUser(username, password);
        set({ sameSubjectTransition: true });
        await get().probeIdentity();
        return { ok: true };
      } catch (error) {
        // §19:失败一律不留痕 —— 不置标记、不清聊天、不动 identityEpoch
        return { ok: false, error: toLoginError(error) };
      }
    },

    async userLogin(username, password) {
      try {
        await apiUserLogin(username, password);
        // §20:登录是全换主体,Cookie 已经换人;本地清空 + 关流 + 换文档由调用方编排
        return { ok: true };
      } catch (error) {
        return { ok: false, error: toLoginError(error) };
      }
    },

    async changePassword(currentPassword, newPassword) {
      try {
        const session = await apiChangePassword(currentPassword, newPassword);
        // §42:后端已轮换当前 Session 并撤销其它设备,但 userId 没变 ——
        // 只更新身份负载,不 epoch++、不 clearIdentity,聊天视图与输入草稿都不该动。
        set({
          status: "authenticated",
          userType: session.userType ?? "REGISTERED",
          username: session.username ?? null,
          expiresAt: session.expiresAt,
          bootstrapErrorCode: null,
        });
        return { ok: true, session };
      } catch (error) {
        return { ok: false, error: toLoginError(error) };
      }
    },

    async revokeAllSessions() {
      try {
        await apiRevokeAllSessions();
      } catch (error) {
        return { ok: false, error: toLoginError(error) };
      }
      // §43:后端删库成功即已清 Cookie。只清本地身份,不当场建匿名 ——
      // 立刻 bootstrap 会用「新访客身份」掩盖「你刚在所有设备退出」这件事。
      clearIdentity();
      return { ok: true };
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
            username: session.username ?? null,
            expiresAt: session.expiresAt,
          });
          return false;
        }
        set({
          status: "authenticated",
          userType: "ADMIN",
          username: session.username ?? null,
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
