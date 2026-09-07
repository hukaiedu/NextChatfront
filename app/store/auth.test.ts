import { jest } from "@jest/globals";
import { createElement } from "react";

// store 必须先于组件导入:组件经 store/index 形成循环依赖,
// 先完成 store 求值可避免 Locale 未初始化(同 backend-model-selector.test.tsx)
import { useChatStore } from "./chat";
import { LoginError, useAuthStore } from "./auth";
import { activeStreamCount } from "./active-streams";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { AuthGate } from "../components/auth-gate";
import Locale from "../locales";
import {
  createConversation,
  listConversations,
  setUnauthorizedHandler,
  subscribeRequestEvents,
} from "../client/backend-api";

/**
 * SEC-1 FE-AUTH-01..10(§十五)。
 * 套路与 backend-chat-store.test.ts 相同:不 mock API Client,
 * 从最外层伪造 HTTP(fetch)与 SSE(FakeEventSource)。
 * 组件断言经 createElement(文件为 .ts,不写 JSX)。
 */

const STAMP = "2026-09-07T00:00:00.000Z";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  await tick();
  await tick();
};

interface RecordedCall {
  url: string;
  method: string;
  body?: any;
  headers: Record<string, string>;
}

const calls: RecordedCall[] = [];

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

  /** data 为 undefined 时模拟传输层错误(原生 Event,没有 data 字段) */
  emit(type: string, data?: unknown) {
    const event: any = { type };
    if (data !== undefined) event.data = JSON.stringify(data);
    (this.handlers.get(type) ?? []).forEach((handler) => handler(event));
  }
}

function lastSource(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("没有建立 SSE 订阅");
  return source;
}

function reply(
  status: number,
  data?: unknown,
  headers?: Record<string, string>,
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers?.[name.toLowerCase()] ?? null,
    },
    json: async () => data ?? null,
  };
}

function fail(status: number, code: string, errorMessage: string) {
  return reply(status, {
    error: { code, message: errorMessage, requestId: "r" },
  });
}

type MockRoute = (url: string, method: string, body: any) => any;
let route: MockRoute = () => fail(404, "NOT_FOUND", "未预期的请求");

const sessionRoute =
  (authenticated: boolean, expiresAt: string | null = STAMP) =>
  (url: string) => {
    if (url === "/backend-api/auth/session") {
      return reply(200, { data: { authenticated, expiresAt } });
    }
    return undefined;
  };

function resetStores() {
  useAuthStore.setState({
    status: "checking",
    expiresAt: null,
    loginError: null,
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

/** 认证状态从非 unauthenticated → unauthenticated 的迁移次数(UI 跳转次数) */
function countLogoutTransitions(): () => number {
  let transitions = 0;
  const unsubscribe = useAuthStore.subscribe((state, prev) => {
    if (
      prev.status !== "unauthenticated" &&
      state.status === "unauthenticated"
    ) {
      transitions += 1;
    }
  });
  return () => {
    unsubscribe();
    return transitions;
  };
}

beforeEach(() => {
  calls.length = 0;
  FakeEventSource.instances = [];
  resetStores();
  localStorage.clear();
  (globalThis as any).EventSource = FakeEventSource;
  (globalThis as any).fetch = jest.fn(
    async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      const method = String(init.method ?? "GET").toUpperCase();
      const parsed =
        typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({
        url,
        method,
        body: parsed,
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      return route(url, method, parsed) ?? fail(404, "NOT_FOUND", "未路由");
    },
  );
  // 恢复真实 handler(spy 测试可能覆盖它)
  setUnauthorizedHandler(() => useAuthStore.getState().markUnauthorized());
});

describe("SEC-1 FE-AUTH:启动探测与登录表单", () => {
  test("FE-AUTH-01 首次加载:probe false → unauthenticated,渲染登录页", async () => {
    route = sessionRoute(false);

    await useAuthStore.getState().probe();
    expect(useAuthStore.getState().status).toBe("unauthenticated");

    const getTransitions = countLogoutTransitions();
    render(
      createElement(AuthGate, null, createElement("div", {}, "HOME-MARK")),
    );
    await act(settle);

    expect(
      screen.getByPlaceholderText(Locale.Auth.PasswordPlaceholder),
    ).toBeTruthy();
    expect(screen.queryByText("HOME-MARK")).toBeNull();
    expect(getTransitions()).toBe(0);
  });

  test("FE-AUTH-02 probe true → authenticated,直接渲染 Home 不闪登录页", async () => {
    route = sessionRoute(true);

    await useAuthStore.getState().probe();
    expect(useAuthStore.getState().status).toBe("authenticated");
    expect(useAuthStore.getState().expiresAt).toBe(STAMP);

    render(
      createElement(AuthGate, null, createElement("div", {}, "HOME-MARK")),
    );
    await act(settle);

    expect(screen.getByText("HOME-MARK")).toBeTruthy();
    expect(screen.queryByPlaceholderText("请输入访问密码")).toBeNull();
  });

  test("FE-AUTH-03 登录成功 → authenticated,进入聊天 UI", async () => {
    route = (url, method, body) => {
      if (url === "/backend-api/auth/login" && method === "POST") {
        return reply(200, {
          data: { authenticated: true, expiresAt: STAMP },
        });
      }
      return undefined;
    };

    const ok = await useAuthStore.getState().login("right-password");
    expect(ok).toBe(true);
    expect(useAuthStore.getState().status).toBe("authenticated");
    expect(useAuthStore.getState().loginError).toBeNull();
    const loginCall = calls.find((c) => c.url === "/backend-api/auth/login");
    expect(loginCall?.method).toBe("POST");
    expect(loginCall?.body).toEqual({ password: "right-password" });
  });

  test("FE-AUTH-04 登录 401 → 表单错误文案,不触发全局登出", async () => {
    useAuthStore.setState({ status: "unauthenticated" });
    route = (url) => {
      if (url === "/backend-api/auth/login") {
        return fail(401, "AUTH_INVALID_CREDENTIALS", "wrong password");
      }
      return undefined;
    };
    const unauthorized = jest.fn();
    setUnauthorizedHandler(unauthorized);

    const ok = await useAuthStore.getState().login("wrong-password");
    expect(ok).toBe(false);
    expect(useAuthStore.getState().status).toBe("unauthenticated");
    expect(useAuthStore.getState().loginError?.code).toBe(
      "AUTH_INVALID_CREDENTIALS",
    );
    expect(unauthorized).not.toHaveBeenCalled();

    // 错误文案渲染(AUTH_INVALID_CREDENTIALS 映射;断言用 Locale 本身,与测试环境语言无关)
    useAuthStore.setState({ loginError: { code: "AUTH_INVALID_CREDENTIALS" } });
    render(createElement(AuthGate));
    await act(settle);
    expect(
      screen.getByText(Locale.Auth.Error.AUTH_INVALID_CREDENTIALS),
    ).toBeTruthy();
  });

  test("FE-AUTH-05 登录 429 → 限流文案,含 Retry-After 秒数", async () => {
    route = (url) => {
      if (url === "/backend-api/auth/login") {
        return fail(429, "AUTH_RATE_LIMITED", "Too many failed login attempts");
      }
      return undefined;
    };

    // 直接伪造 429 无法携带 header(经 fail helper),用自定义响应带 Retry-After
    (globalThis as any).fetch = jest.fn(async (input: string) => {
      calls.push({
        url: String(input),
        method: "POST",
        headers: {},
      });
      return reply(
        429,
        {
          error: {
            code: "AUTH_RATE_LIMITED",
            message: "limited",
            requestId: "r",
          },
        },
        { "retry-after": "30" },
      );
    });

    await useAuthStore.getState().login("whatever");
    const error = useAuthStore.getState().loginError;
    expect(error?.code).toBe("AUTH_RATE_LIMITED");
    expect(error?.retryAfterSeconds).toBe(30);

    // 登录失败不改 status(仍为 checking):渲染错误文案需显式置于 unauthenticated
    useAuthStore.setState({
      status: "unauthenticated",
      loginError: error as LoginError,
    });
    render(createElement(AuthGate));
    await act(settle);
    expect(
      screen.getByText(Locale.Auth.Error.AUTH_RATE_LIMITED(30)),
    ).toBeTruthy();
  });
});

describe("SEC-1 FE-AUTH:全局 401(两条 fetch 路径)", () => {
  test("FE-AUTH-06 已认证态 call() 路径 401 → markUnauthorized 登出,并发 401 单次跳转", async () => {
    useAuthStore.setState({ status: "authenticated", expiresAt: STAMP });
    useChatStore.getState().followRequest("c-1", "req-1", "m-1");
    expect(lastSource().closed).toBe(false);

    route = (url) => {
      if (url.startsWith("/backend-api/conversations")) {
        return fail(401, "AUTH_REQUIRED", "unauthorized");
      }
      return undefined;
    };

    const getTransitions = countLogoutTransitions();
    await Promise.all([
      createConversation("并发 401 会话").catch(() => undefined),
      createConversation("并发 401 会话 2").catch(() => undefined),
    ]);

    expect(useAuthStore.getState().status).toBe("unauthenticated");
    expect(getTransitions()).toBe(1);
    // 全局登出关闭活跃 SSE(§8.1-B)
    expect(lastSource().closed).toBe(true);
  });

  test("FE-AUTH-07 listConversations 独立 fetch 路径 401 → 同样触发全局登出", async () => {
    useAuthStore.setState({ status: "authenticated", expiresAt: STAMP });
    route = (url) => {
      if (url.startsWith("/backend-api/conversations")) {
        return fail(401, "AUTH_REQUIRED", "unauthorized");
      }
      return undefined;
    };

    const getTransitions = countLogoutTransitions();
    await expect(listConversations()).rejects.toThrow();
    await settle();

    expect(useAuthStore.getState().status).toBe("unauthenticated");
    expect(getTransitions()).toBe(1);
  });
});

describe("SEC-1 FE-AUTH-06B/06C:全局 401 关闭全部活跃订阅(closeAllStreams 链路)", () => {
  /** 包装每个 FakeEventSource.close,记录各自被调用的次数 */
  function trackCloseOnce(): Map<FakeEventSource, number> {
    const counts = new Map<FakeEventSource, number>();
    for (const source of FakeEventSource.instances) {
      const original = source.close.bind(source);
      source.close = () => {
        counts.set(source, (counts.get(source) ?? 0) + 1);
        original();
      };
    }
    return counts;
  }

  function followTwoStreams() {
    useAuthStore.setState({ status: "authenticated", expiresAt: STAMP });
    useChatStore.getState().followRequest("c-1", "req-1", "m-1");
    useChatStore.getState().followRequest("c-2", "req-2", "m-2");
    expect(FakeEventSource.instances.length).toBe(2);
  }

  test("FE-AUTH-06B 并发业务 REST 401:两订阅各 close 恰一次,registry 清空,不 cancel", async () => {
    followTwoStreams();
    const closeCounts = trackCloseOnce();

    route = (url) => {
      if (url.startsWith("/backend-api/conversations")) {
        return fail(401, "AUTH_REQUIRED", "unauthorized");
      }
      return undefined;
    };

    const getTransitions = countLogoutTransitions();
    await Promise.all([
      createConversation("06B 并发 401").catch(() => undefined),
      createConversation("06B 并发 401 2").catch(() => undefined),
    ]);

    expect(useAuthStore.getState().status).toBe("unauthenticated");
    expect([...closeCounts.values()]).toEqual([1, 1]);
    expect(activeStreamCount()).toBe(0);
    expect(getTransitions()).toBe(1);
    expect(
      calls.some(
        (c) => c.url.includes("/requests/") && c.url.includes("/cancel"),
      ),
    ).toBe(false);
  });

  test("FE-AUTH-06C listConversations 401:同一链路关闭全部活跃订阅", async () => {
    followTwoStreams();
    const closeCounts = trackCloseOnce();

    route = (url) => {
      if (url.startsWith("/backend-api/conversations")) {
        return fail(401, "AUTH_REQUIRED", "unauthorized");
      }
      return undefined;
    };

    const getTransitions = countLogoutTransitions();
    await expect(listConversations()).rejects.toThrow();

    expect(useAuthStore.getState().status).toBe("unauthenticated");
    expect([...closeCounts.values()]).toEqual([1, 1]);
    expect(activeStreamCount()).toBe(0);
    expect(getTransitions()).toBe(1);
    expect(
      calls.some(
        (c) => c.url.includes("/requests/") && c.url.includes("/cancel"),
      ),
    ).toBe(false);
  });
});

describe("SEC-1 FIX-03:store/auth 模块加载回归(不再依赖 store/chat)", () => {
  test("单独动态加载 store/auth:登出关流不依赖 chat,全局 401 钩子可用", async () => {
    jest.resetModules();
    const authModule = await import("./auth");

    authModule.useAuthStore.setState({
      status: "authenticated",
      expiresAt: STAMP,
    });
    expect(() =>
      authModule.useAuthStore.getState().markUnauthorized(),
    ).not.toThrow();
    expect(authModule.useAuthStore.getState().status).toBe("unauthenticated");
  });

  // 行为测试无法可靠捕捉重新引入的 auth→chat 依赖(全新 chat 图的异步副作用会泄漏到
  // 后续用例而非当前用例),所以对这条边加一个静态源码守卫。
  test("静态守卫:store/auth 源码不得 import store/chat", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./auth.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/from ["']\.\/chat["']/);
  });
});

describe("SEC-1 FE-AUTH-08:SSE transport error 后的 session probe(三态)", () => {
  test("FE-AUTH-08A probe false → markUnauthorized,关 SSE,登录页", async () => {
    useAuthStore.setState({ status: "authenticated", expiresAt: STAMP });
    route = sessionRoute(false);

    const handlers = {
      onContent: jest.fn(),
    };
    subscribeRequestEvents("req-1", handlers as any);
    const first = lastSource();
    expect(first.closed).toBe(false);

    first.readyState = FakeEventSource.CLOSED;
    first.emit("error");
    await settle();

    expect(useAuthStore.getState().status).toBe("unauthenticated");
    expect(first.closed).toBe(true);
    // 停止重连:不出现第二个 EventSource
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(FakeEventSource.instances.length).toBe(1);
  });

  test("FE-AUTH-08B probe true → 恢复既有 reconnect/backoff", async () => {
    useAuthStore.setState({ status: "authenticated", expiresAt: STAMP });
    route = sessionRoute(true);

    subscribeRequestEvents("req-1", { onContent: jest.fn() } as any);
    const first = lastSource();
    first.readyState = FakeEventSource.CLOSED;
    first.emit("error");

    await settle();
    expect(useAuthStore.getState().status).toBe("authenticated");
    expect(FakeEventSource.instances.length).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(FakeEventSource.instances.length).toBe(2);
    expect(lastSource().url).toContain("/backend-api/requests/req-1/events");
  });

  test("FE-AUTH-08C probe 自身网络失败 → 保持 authenticated + 恢复重连", async () => {
    useAuthStore.setState({ status: "authenticated", expiresAt: STAMP });
    route = (url) => {
      if (url === "/backend-api/auth/session") {
        throw new Error("backend unreachable");
      }
      return undefined;
    };

    subscribeRequestEvents("req-1", { onContent: jest.fn() } as any);
    const first = lastSource();
    first.readyState = FakeEventSource.CLOSED;
    first.emit("error");

    await settle();
    // 不把后端暂时断网误判为 Session 失效(§8.3 第三态)
    expect(useAuthStore.getState().status).toBe("authenticated");

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(FakeEventSource.instances.length).toBe(2);
  });

  test("FE-AUTH-08D 多个 SSE 同时 transport error → probe 合并为单次", async () => {
    useAuthStore.setState({ status: "authenticated", expiresAt: STAMP });
    route = sessionRoute(false);

    subscribeRequestEvents("req-1", { onContent: jest.fn() } as any);
    subscribeRequestEvents("req-2", { onContent: jest.fn() } as any);
    const [first, second] = FakeEventSource.instances;

    first.readyState = FakeEventSource.CLOSED;
    second.readyState = FakeEventSource.CLOSED;
    first.emit("error");
    second.emit("error");
    await settle();

    expect(useAuthStore.getState().status).toBe("unauthenticated");
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(true);
    const sessionCalls = calls.filter(
      (c) => c.url === "/backend-api/auth/session",
    );
    expect(sessionCalls.length).toBe(1);
  });
});

describe("SEC-1 FE-AUTH-09A/09B/09C:登出语义(仅服务端确认清除 Cookie 才下线)", () => {
  test("FE-AUTH-09A logout API 204 → 两个活跃 SSE 全部关闭 + registry 清空 + unauthenticated,不 cancelRequest", async () => {
    useAuthStore.setState({ status: "authenticated", expiresAt: STAMP });
    route = (url, method) => {
      if (url === "/backend-api/auth/logout" && method === "POST") {
        return { ok: true, status: 204, json: async () => null };
      }
      return undefined;
    };
    useChatStore.getState().followRequest("c-1", "req-1", "m-1");
    useChatStore.getState().followRequest("c-2", "req-2", "m-2");
    expect(activeStreamCount()).toBe(2);

    await expect(useAuthStore.getState().logout()).resolves.toBe(true);

    expect(useAuthStore.getState().status).toBe("unauthenticated");
    expect(useAuthStore.getState().expiresAt).toBeNull();
    expect(useAuthStore.getState().logoutError).toBeNull();
    expect(FakeEventSource.instances.every((s) => s.closed)).toBe(true);
    expect(activeStreamCount()).toBe(0);
    const logoutCall = calls.find((c) => c.url === "/backend-api/auth/logout");
    expect(logoutCall?.method).toBe("POST");
    // §8.1-B:后端 Request 绝不取消
    expect(
      calls.some(
        (c) => c.url.includes("/requests/") && c.url.includes("/cancel"),
      ),
    ).toBe(false);
  });

  test("FE-AUTH-09B logout 网络失败 → 保持 authenticated,SSE 不动,logoutError=NETWORK_ERROR", async () => {
    useAuthStore.setState({ status: "authenticated", expiresAt: STAMP });
    route = (url, method) => {
      if (url === "/backend-api/auth/logout" && method === "POST") {
        throw new TypeError("network down");
      }
      return undefined;
    };
    useChatStore.getState().followRequest("c-1", "req-1", "m-1");
    useChatStore.getState().followRequest("c-2", "req-2", "m-2");
    expect(activeStreamCount()).toBe(2);
    const getTransitions = countLogoutTransitions();

    await expect(useAuthStore.getState().logout()).resolves.toBe(false);

    expect(useAuthStore.getState().status).toBe("authenticated");
    expect(useAuthStore.getState().expiresAt).toBe(STAMP);
    expect(useAuthStore.getState().logoutError).toEqual({
      code: "NETWORK_ERROR",
    });
    expect(useAuthStore.getState().loginError).toBeNull();
    expect(activeStreamCount()).toBe(2);
    expect(FakeEventSource.instances.every((s) => !s.closed)).toBe(true);
    expect(getTransitions()).toBe(0);
    expect(
      calls.some(
        (c) => c.url.includes("/requests/") && c.url.includes("/cancel"),
      ),
    ).toBe(false);
  });

  test("FE-AUTH-09C logout 5xx → 与 09B 同语义,logoutError 透传信封 code", async () => {
    useAuthStore.setState({ status: "authenticated", expiresAt: STAMP });
    route = (url, method) => {
      if (url === "/backend-api/auth/logout" && method === "POST") {
        return fail(500, "INTERNAL_ERROR", "boom");
      }
      return undefined;
    };
    useChatStore.getState().followRequest("c-1", "req-1", "m-1");
    useChatStore.getState().followRequest("c-2", "req-2", "m-2");
    expect(activeStreamCount()).toBe(2);
    const getTransitions = countLogoutTransitions();

    await expect(useAuthStore.getState().logout()).resolves.toBe(false);

    expect(useAuthStore.getState().status).toBe("authenticated");
    expect(useAuthStore.getState().expiresAt).toBe(STAMP);
    expect(useAuthStore.getState().logoutError).toEqual({
      code: "INTERNAL_ERROR",
    });
    expect(activeStreamCount()).toBe(2);
    expect(FakeEventSource.instances.every((s) => !s.closed)).toBe(true);
    expect(getTransitions()).toBe(0);
    expect(
      calls.some(
        (c) => c.url.includes("/requests/") && c.url.includes("/cancel"),
      ),
    ).toBe(false);
  });

  test("FE-AUTH-10 刷新页面:无 localStorage 残留,状态由 probe 重新判定", async () => {
    // 模拟上一轮会话残留的内存态
    useAuthStore.setState({ status: "authenticated", expiresAt: STAMP });

    route = sessionRoute(false);
    await useAuthStore.getState().probe();

    expect(useAuthStore.getState().status).toBe("unauthenticated");
    expect(localStorage.length).toBe(0);
    expect(localStorage.getItem("chat")).toBeNull();
  });
});
