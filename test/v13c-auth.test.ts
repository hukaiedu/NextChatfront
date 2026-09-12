import { jest } from "@jest/globals";
import { createElement } from "react";

// store 必须先于组件导入:组件经 store/index 形成循环依赖,
// 先完成 store 求值可避免 Locale 未初始化(同 backend-model-selector.test.tsx)
import { useChatStore } from "../app/store/chat";
import { resetAuthBootstrapState, useAuthStore } from "../app/store/auth";
import {
  activeStreamCount,
  closeAllStreams,
  trackStream,
} from "../app/store/active-streams";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { AuthGate } from "../app/components/auth-gate";
import Locale from "../app/locales";
import {
  listConversations,
  setUnauthorizedHandler,
} from "../app/client/backend-api";

/**
 * V1.3-C §48 匿名自动进入矩阵 C-AUTH-01..07。
 *
 * 套路与 backend-chat-store.test.ts 相同:不 mock API Client,从最外层伪造 HTTP(fetch);
 * 关流断言经 active-streams 登记假订阅完成。
 * 组件断言经 createElement(文件为 .ts,不写 JSX)。
 */

const STAMP = "2026-09-12T00:00:00.000Z";
const SESSION = "/backend-api/auth/session";
const ANONYMOUS = "/backend-api/auth/anonymous";
const LOGIN = "/backend-api/auth/login";
const LOGOUT = "/backend-api/auth/logout";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  await tick();
  await tick();
};

interface RecordedCall {
  url: string;
  method: string;
  body?: any;
}

const calls: RecordedCall[] = [];

function reply(status: number, data?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data ?? null,
  };
}

function fail(status: number, code: string, message: string) {
  return reply(status, { error: { code, message, requestId: "r" } });
}

type MockRoute = (url: string, method: string, body: any) => any;
let route: MockRoute = () => fail(404, "NOT_FOUND", "未路由");

function sessionData(authenticated: boolean, userType: string | null = "ANONYMOUS") {
  return authenticated
    ? { authenticated: true, expiresAt: STAMP, userType }
    : { authenticated: false, expiresAt: null };
}

function callsTo(url: string, method: string) {
  return calls.filter((c) => c.url === url && c.method === method);
}

function resetStores() {
  useAuthStore.setState({
    status: "unknown",
    userType: null,
    expiresAt: null,
    bootstrapErrorCode: null,
    adminLoginError: null,
    logoutError: null,
  });
  useChatStore.setState({
    sessions: [],
    currentSessionIndex: 0,
    lastInput: "",
    ready: false,
    loadingList: false,
    listStatus: "ACTIVE",
  });
}

beforeEach(() => {
  calls.length = 0;
  resetStores();
  resetAuthBootstrapState();
  localStorage.clear();
  (globalThis as any).fetch = jest.fn(
    async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      const method = String(init.method ?? "GET").toUpperCase();
      const parsed =
        typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body: parsed });
      return route(url, method, parsed) ?? fail(404, "NOT_FOUND", "未路由");
    },
  );
  // 恢复真实 handler:spy 测试会把它换成计数版
  setUnauthorizedHandler(() => useAuthStore.getState().markIdentityStale());
});

describe("C-AUTH 匿名自动进入", () => {
  test("C-AUTH-01 已有有效 session → authenticated,不再建匿名身份", async () => {
    route = (url) =>
      url === SESSION ? reply(200, { data: sessionData(true) }) : undefined;

    await useAuthStore.getState().bootstrap();

    const state = useAuthStore.getState();
    expect(state.status).toBe("authenticated");
    expect(state.userType).toBe("ANONYMOUS");
    expect(state.expiresAt).toBe(STAMP);
    expect(callsTo(SESSION, "GET")).toHaveLength(1);
    expect(callsTo(ANONYMOUS, "POST")).toHaveLength(0);
  });

  test("C-AUTH-02 无有效 session → 自动 POST /auth/anonymous 并进入聊天态", async () => {
    route = (url, method) => {
      if (url === SESSION) return reply(200, { data: sessionData(false) });
      if (url === ANONYMOUS && method === "POST") {
        return reply(200, { data: sessionData(true) });
      }
      return undefined;
    };

    await useAuthStore.getState().bootstrap();

    const state = useAuthStore.getState();
    expect(state.status).toBe("authenticated");
    expect(state.userType).toBe("ANONYMOUS");
    expect(callsTo(ANONYMOUS, "POST")).toHaveLength(1);
  });

  test("C-AUTH-03 并发 bootstrap single-flight:探测与建身份各一次(§12/§13)", async () => {
    route = (url, method) => {
      if (url === SESSION) return reply(200, { data: sessionData(false) });
      if (url === ANONYMOUS && method === "POST") {
        return reply(200, { data: sessionData(true) });
      }
      return undefined;
    };

    await Promise.all([
      useAuthStore.getState().bootstrap(),
      useAuthStore.getState().bootstrap(),
    ]);

    expect(callsTo(SESSION, "GET")).toHaveLength(1);
    expect(callsTo(ANONYMOUS, "POST")).toHaveLength(1);
    expect(useAuthStore.getState().status).toBe("authenticated");
  });

  test("C-AUTH-04 网络失败自动重试 1 次后进 error,手动 Retry 才再试(§11)", async () => {
    let probeFails = 0;
    route = (url) => {
      if (url === SESSION) {
        probeFails += 1;
        return fail(503, "INTERNAL_ERROR", "down");
      }
      return undefined;
    };

    await useAuthStore.getState().bootstrap();

    expect(probeFails).toBe(2);
    const state = useAuthStore.getState();
    expect(state.status).toBe("error");
    expect(state.bootstrapErrorCode).toBe("NETWORK_ERROR");

    // error 态不自动继续循环:再调 bootstrap 不发请求
    await useAuthStore.getState().bootstrap();
    expect(callsTo(SESSION, "GET")).toHaveLength(2);

    // 服务恢复后由用户手动 Retry 回到 authenticated
    route = (url) => (url === SESSION ? reply(200, { data: sessionData(true) }) : undefined);
    act(() => useAuthStore.getState().retryBootstrap());
    await act(settle);

    expect(useAuthStore.getState().status).toBe("authenticated");
    expect(useAuthStore.getState().bootstrapErrorCode).toBeNull();
  });
});

describe("C-AUTH 身份失效与禁用", () => {
  test("C-AUTH-05 DISABLED Cookie:anonymous 返回 401 → blocked 且不循环(§10)", async () => {
    route = (url, method) => {
      if (url === SESSION) return reply(200, { data: sessionData(false) });
      if (url === ANONYMOUS && method === "POST") {
        return fail(401, "AUTH_REQUIRED", "Session belongs to a disabled user");
      }
      return undefined;
    };

    await useAuthStore.getState().bootstrap();

    const state = useAuthStore.getState();
    expect(state.status).toBe("blocked");
    expect(state.bootstrapErrorCode).toBe("AUTH_REQUIRED");
    expect(callsTo(ANONYMOUS, "POST")).toHaveLength(1);

    // blocked 不会被自动引导或可见性刷新解除:再调 bootstrap / refreshIdentity 都不发请求
    await useAuthStore.getState().bootstrap();
    useAuthStore.getState().refreshIdentity();
    await settle();
    expect(callsTo(ANONYMOUS, "POST")).toHaveLength(1);
    expect(callsTo(SESSION, "GET")).toHaveLength(1);
  });

  test("C-AUTH-06 业务 API 401 → 关流 + 重新引导,但不重放失败的请求(§14)", async () => {
    let listCalls = 0;
    route = (url, method) => {
      if (url.startsWith("/backend-api/conversations")) {
        listCalls += 1;
        // 第一次:身份已失效;重新引导之后:正常返回
        return listCalls === 1
          ? fail(401, "AUTH_REQUIRED", "Session required")
          : reply(200, { data: [], meta: {} });
      }
      if (url === SESSION) return reply(200, { data: sessionData(false) });
      if (url === ANONYMOUS && method === "POST") {
        return reply(200, { data: sessionData(true) });
      }
      return undefined;
    };

    // 前置:浏览器已有一个可用的匿名身份(§5 自动进入之后)
    useAuthStore.setState({
      status: "authenticated",
      userType: "ANONYMOUS",
      expiresAt: STAMP,
    });
    const closed: string[] = [];
    trackStream("c-1", { close: () => closed.push("c-1") });
    expect(activeStreamCount()).toBe(1);

    await expect(listConversations()).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    await settle();

    // 关流 + 建新匿名身份
    expect(closed).toEqual(["c-1"]);
    expect(activeStreamCount()).toBe(0);
    expect(callsTo(ANONYMOUS, "POST")).toHaveLength(1);
    expect(useAuthStore.getState().status).toBe("authenticated");
    // §14:失败的列表请求没有被自动重放
    expect(listCalls).toBe(1);
  });
});

describe("C-AUTH 管理员登录判定", () => {
  test("C-AUTH-07 只有 authenticated + userType=ADMIN 才算登录成功(§19)", async () => {
    route = (url, method, body) => {
      if (url === LOGIN && method === "POST") {
        if (body?.password === "right") {
          return reply(200, { data: sessionData(true, "ADMIN") });
        }
        if (body?.password === "compat") {
          // COMPAT 模式:HTTP 200 但拿到的是匿名身份
          return reply(200, { data: sessionData(true, "ANONYMOUS") });
        }
        if (body?.password === "limited") {
          return fail(429, "AUTH_RATE_LIMITED", "Too many failed login attempts");
        }
        return fail(401, "AUTH_INVALID_CREDENTIALS", "Invalid password");
      }
      return undefined;
    };

    expect(await useAuthStore.getState().adminLogin("right")).toBe(true);
    expect(useAuthStore.getState().userType).toBe("ADMIN");
    expect(useAuthStore.getState().adminLoginError).toBeNull();

    expect(await useAuthStore.getState().adminLogin("compat")).toBe(false);
    expect(useAuthStore.getState().adminLoginError?.code).toBe("ADMIN_UNAVAILABLE");

    expect(await useAuthStore.getState().adminLogin("bad")).toBe(false);
    expect(useAuthStore.getState().adminLoginError?.code).toBe(
      "AUTH_INVALID_CREDENTIALS",
    );

    expect(await useAuthStore.getState().adminLogin("limited")).toBe(false);
    expect(useAuthStore.getState().adminLoginError?.code).toBe(
      "AUTH_RATE_LIMITED",
    );

    // §69:密码只出现在这一次请求体里,store 不保留任何密码字段
    expect(Object.keys(useAuthStore.getState())).not.toContain("password");
  });
});

describe("C-AUTH 引导门渲染", () => {
  const gate = () =>
    render(createElement(AuthGate, null, createElement("div", {}, "HOME-MARK")));

  test("C-AUTH-UI-01 引导中显示占位、不渲染 children;成功后透传", async () => {
    route = (url) => (url === SESSION ? reply(200, { data: sessionData(true) }) : undefined);

    gate();
    expect(screen.getByText(Locale.Bootstrap.Loading)).toBeTruthy();
    expect(screen.queryByText("HOME-MARK")).toBeNull();

    await act(settle);
    expect(screen.getByText("HOME-MARK")).toBeTruthy();
    expect(screen.queryByText(Locale.Bootstrap.Loading)).toBeNull();
  });

  test("C-AUTH-UI-02 blocked / error 各给中性提示与可用 Retry 按钮(§10/§11)", async () => {
    act(() =>
      useAuthStore.setState({
        status: "blocked",
        bootstrapErrorCode: "AUTH_REQUIRED",
      }),
    );
    gate();
    expect(screen.getByText(Locale.Bootstrap.Blocked)).toBeTruthy();
    expect(screen.queryByText("HOME-MARK")).toBeNull();

    act(() =>
      useAuthStore.setState({
        status: "error",
        bootstrapErrorCode: "NETWORK_ERROR",
      }),
    );
    await act(settle);
    expect(screen.getByText(Locale.Bootstrap.Error)).toBeTruthy();

    // Retry 走手动重试路径:服务恢复后回到 authenticated
    route = (url) => (url === SESSION ? reply(200, { data: sessionData(true) }) : undefined);
    fireEvent.click(screen.getByText(Locale.Bootstrap.Retry));
    await act(settle);
    expect(screen.getByText("HOME-MARK")).toBeTruthy();
  });
});

describe("登出语义与身份真相(迁移自 SEC-1 FE-AUTH-09/10)", () => {
  function noReply(status: number) {
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => null };
  }

  test("FE-AUTH-09A logout 204 → 关全部流并清空本地身份,但不 cancelRequest", async () => {
    useAuthStore.setState({ status: "authenticated", userType: "ANONYMOUS", expiresAt: STAMP });
    route = (url, method) =>
      url === LOGOUT && method === "POST" ? noReply(204) : undefined;
    const closed: string[] = [];
    trackStream("c-1", { close: () => closed.push("c-1") });
    trackStream("c-2", { close: () => closed.push("c-2") });

    await expect(useAuthStore.getState().logout()).resolves.toBe(true);

    expect(closed.sort()).toEqual(["c-1", "c-2"]);
    expect(activeStreamCount()).toBe(0);
    const state = useAuthStore.getState();
    expect(state.status).toBe("unknown");
    expect(state.userType).toBeNull();
    expect(state.expiresAt).toBeNull();
    expect(state.logoutError).toBeNull();
    expect(
      calls.some((c) => c.url.includes("/requests/") && c.url.includes("/cancel")),
    ).toBe(false);
  });

  test("FE-AUTH-09B/09C logout 网络失败或 5xx → 保持 authenticated,流不动", async () => {
    const cases: Array<[() => any, string]> = [
      [() => { throw new TypeError("network down"); }, "NETWORK_ERROR"],
      [() => fail(500, "INTERNAL_ERROR", "boom"), "INTERNAL_ERROR"],
    ];

    for (const [makeResponse, expectedCode] of cases) {
      calls.length = 0;
      resetStores();
      useAuthStore.setState({ status: "authenticated", expiresAt: STAMP });
      route = (url, method) => {
        if (url === LOGOUT && method === "POST") return makeResponse();
        return undefined;
      };
      const closed: string[] = [];
      trackStream("c-1", { close: () => closed.push("c-1") });

      await expect(useAuthStore.getState().logout()).resolves.toBe(false);

      const state = useAuthStore.getState();
      expect(state.status).toBe("authenticated");
      expect(state.expiresAt).toBe(STAMP);
      expect(state.logoutError).toEqual({ code: expectedCode });
      expect(closed).toEqual([]);
      expect(activeStreamCount()).toBe(1);
      useAuthStore.getState().clearIdentity();
    }
  });

  test("FE-AUTH-10 身份真相只来自后端:本地没有任何可恢复的登录态(§46/§47)", async () => {
    useAuthStore.setState({ status: "authenticated", expiresAt: STAMP });
    // 相当于刷新页面:内存身份清空,真相只能由后端重新判定
    useAuthStore.getState().clearIdentity();
    resetAuthBootstrapState();
    route = (url, method) => {
      if (url === SESSION) return reply(200, { data: sessionData(false) });
      if (url === ANONYMOUS && method === "POST") {
        return reply(200, { data: sessionData(true) });
      }
      return undefined;
    };

    await useAuthStore.getState().bootstrap();

    expect(useAuthStore.getState().status).toBe("authenticated");
    // 旧身份没有让前端跳过探测
    expect(callsTo(SESSION, "GET")).toHaveLength(1);
    expect(localStorage.length).toBe(0);
  });
});

/** SSE 传输层错误 → 重连前只做一次共享 session 探测(迁移自 SEC-1 FE-AUTH-08) */
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.OPEN;
  closed = false;
  private handlers = new Map<string, ((event: any) => void)[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: any) => void) {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type: string, data?: unknown) {
    const event: any = { type };
    if (data !== undefined) event.data = JSON.stringify(data);
    (this.handlers.get(type) ?? []).forEach((handler) => handler(event));
  }
}

describe("SSE 断线重连探测", () => {
  test("FE-AUTH-08 两条流同时断开 → 只探测一次 session", async () => {
    FakeEventSource.instances = [];
    (globalThis as any).EventSource = FakeEventSource;
    useAuthStore.setState({ status: "authenticated", expiresAt: STAMP });
    route = (url) => (url === SESSION ? reply(200, { data: sessionData(true) }) : undefined);

    useChatStore.getState().followRequest("c-1", "req-1", "m-1");
    useChatStore.getState().followRequest("c-2", "req-2", "m-2");
    const [first, second] = FakeEventSource.instances;
    expect([first, second].every(Boolean)).toBe(true);

    calls.length = 0;
    // 传输层错误 + 服务端已结束响应:走「关流后重连」分支(§8.3)
    first.readyState = FakeEventSource.CLOSED;
    second.readyState = FakeEventSource.CLOSED;
    first.emit("error");
    second.emit("error");
    await settle();

    expect(callsTo(SESSION, "GET")).toHaveLength(1);
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(true);
    expect(useAuthStore.getState().status).toBe("authenticated");
    closeAllStreams();
    expect(activeStreamCount()).toBe(0);
  });
});
