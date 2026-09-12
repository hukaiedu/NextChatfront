import { jest } from "@jest/globals";
import { createElement, useEffect } from "react";
import { act, render, screen } from "@testing-library/react";

// 先导入 store:组件经 store/index 形成循环依赖,先完成 store 求值可避免 Locale 未初始化
import { useChatStore } from "../app/store/chat";
import { resetAuthBootstrapState, useAuthStore } from "../app/store/auth";
import {
  activeStreamCount,
  trackStream,
} from "../app/store/active-streams";
import { AuthGate } from "../app/components/auth-gate";
import Locale from "../app/locales";
import { setUnauthorizedHandler } from "../app/client/backend-api";

/**
 * V1.3-C Review FIX-02:身份边界(Public surface)。
 *
 * Cookie `personchat_session` 在全 Tab 间共享,所以「本 Tab 内存里的身份」必须与
 * 「后端此刻承认的身份」同步:
 * - C-IDSW-01:身份被就地换掉(另一 Tab 登录了 ADMIN)→ 旧匿名聊天态整体消失并重拉
 * - C-TAB-01:同一判据的 Tab B 视角(旧匿名会话消失、在途流关闭)
 * - C-TAB-02:focus + visibilitychange 紧邻 → session 探测只发一次(single-flight)
 * - C-401-01/02/03:业务 401 → identity stale → 重新 bootstrap;原 mutation 绝不重放
 *
 * 登录页自身的「换文档」判据在 v13c-admin.test.tsx(C-ADMIN-05 / C-IDSW-02 / 03 /
 * C-TAB-03 系列);真浏览器双 Tab 的 DOM 证据见 back 仓
 * `scripts/acceptance/v13c-fix02-real.mjs`。
 */

const STAMP = "2026-09-12T00:00:00.000Z";
const LATER = "2026-09-12T01:00:00.000Z";
const SESSION = "/backend-api/auth/session";
const ANONYMOUS = "/backend-api/auth/anonymous";
const LIST = "/backend-api/conversations?";
const MARKER = "ANON_ONLY_STATE_SHOULD_DISAPPEAR";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  await tick();
  await tick();
};

interface RecordedCall {
  url: string;
  method: string;
}

const calls: RecordedCall[] = [];

function reply(status: number, data?: unknown, meta?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => ({ data: data ?? null, ...(meta ? { meta } : {}) }),
  };
}

function fail(status: number, code: string, message: string) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({ error: { code, message, requestId: "r" } }),
  };
}

function sessionData(authenticated: boolean, userType: string | null = "ANONYMOUS") {
  return authenticated
    ? { authenticated: true, expiresAt: STAMP, userType }
    : { authenticated: false, expiresAt: null };
}

function conversation(id: string, title: string) {
  return {
    id,
    title,
    status: "ACTIVE",
    preferredModelKey: null,
    createdAt: STAMP,
    updatedAt: id === "c-anon" ? STAMP : LATER,
  };
}

function callsTo(urlPrefix: string, method = "GET") {
  return calls.filter(
    (c) => c.method === method && c.url.startsWith(urlPrefix),
  );
}

type MockRoute = (url: string, method: string) => any;
let route: MockRoute = () => undefined;

/** 冒充 Home 的 useLoadData:每次挂载按当前身份拉一次会话列表 */
function Child() {
  useEffect(() => {
    void useChatStore.getState().bootstrap();
  }, []);
  return createElement("div", { "data-testid": "child" });
}

function renderGate() {
  return render(createElement(AuthGate, null, createElement(Child)));
}

function childMounted() {
  return screen.queryByTestId("child") !== null;
}

beforeEach(() => {
  calls.length = 0;
  useAuthStore.setState({
    status: "unknown",
    userType: null,
    expiresAt: null,
    identityEpoch: 0,
    bootstrapErrorCode: null,
    adminLoginError: null,
    logoutError: null,
  });
  useChatStore.getState().resetForIdentity();
  resetAuthBootstrapState();
  localStorage.clear();
  (globalThis as any).fetch = jest.fn(
    async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      const method = String(init.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      return route(url, method) ?? fail(404, "NOT_FOUND", "未路由");
    },
  );
  setUnauthorizedHandler(() => useAuthStore.getState().markIdentityStale());
});

describe("FIX-02 身份边界(Public surface)", () => {
  test("C-IDSW-01 身份被就地换掉:旧匿名聊天态整体消失并按新身份重拉", async () => {
    let identity = "ANONYMOUS";
    route = (url, method) => {
      if (url === SESSION) return reply(200, sessionData(true, identity));
      if (url.startsWith(LIST) && method === "GET") {
        return reply(
          200,
          identity === "ANONYMOUS"
            ? [conversation("c-anon", MARKER)]
            : [conversation("c-admin", "ADMIN 的会话")],
          { nextCursor: null },
        );
      }
      if (url.endsWith("/messages")) {
        return reply(200, [], { nextCursor: null, totalCount: 0 });
      }
      return undefined;
    };

    renderGate();
    await act(settle);

    // 前置:本 Tab 以匿名身份进入,列表里带着只属于该匿名身份的标记
    expect(useAuthStore.getState().userType).toBe("ANONYMOUS");
    expect(useChatStore.getState().sessions.map((s) => s.topic)).toEqual([
      MARKER,
    ]);
    expect(childMounted()).toBe(true);
    const listCallsBefore = callsTo(LIST, "GET").length;

    // 另一个 Tab 完成 ADMIN 登录:同名 Cookie 现在是 ADMIN
    identity = "ADMIN";
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await settle();
    });

    expect(useAuthStore.getState().userType).toBe("ADMIN");
    const chat = useChatStore.getState();
    // 边界重置:旧 Conversation / Message 缓存整体消失,不是只改 userType
    expect(chat.sessions.map((s) => s.id)).toEqual(["c-admin"]);
    expect(JSON.stringify(chat.sessions)).not.toContain(MARKER);
    expect(chat.ready).toBe(true);
    // 新身份的数据确实重拉过(且只多一次)
    expect(callsTo(LIST, "GET")).toHaveLength(listCallsBefore + 1);
  });

  test("C-TAB-01 Tab B 视角:Tab A 登录后旧匿名会话不可见,在途回答流被关闭", async () => {
    let identity = "ANONYMOUS";
    route = (url, method) => {
      if (url === SESSION) return reply(200, sessionData(true, identity));
      if (url.startsWith(LIST) && method === "GET") {
        return reply(
          200,
          identity === "ANONYMOUS" ? [conversation("c-anon", MARKER)] : [],
          { nextCursor: null },
        );
      }
      if (url.endsWith("/messages")) {
        return reply(200, [], { nextCursor: null, totalCount: 0 });
      }
      return undefined;
    };

    renderGate();
    await act(settle);

    // 本 Tab 正在看匿名会话,并挂着一条 SSE
    const closed: string[] = [];
    trackStream("c-anon", { close: () => closed.push("c-anon") });
    expect(activeStreamCount()).toBe(1);

    identity = "ADMIN";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
    });

    expect(useAuthStore.getState().userType).toBe("ADMIN");
    // 旧身份的在途订阅被关掉;缓存里也没有旧会话残留 → UI 无从显示标记
    expect(closed).toEqual(["c-anon"]);
    expect(activeStreamCount()).toBe(0);
    const chat = useChatStore.getState();
    expect(chat.sessions.some((s) => s.id === "c-anon")).toBe(false);
    expect(JSON.stringify(chat)).not.toContain(MARKER);
  });

  test("C-TAB-02 focus 与 visibilitychange 紧邻:session 只探测一次", async () => {
    route = (url, method) => {
      if (url === SESSION) return reply(200, sessionData(true, "ANONYMOUS"));
      if (url.startsWith(LIST) && method === "GET") {
        return reply(200, [], { nextCursor: null });
      }
      return undefined;
    };

    renderGate();
    await act(settle);
    calls.length = 0;

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      await settle();
    });

    // single-flight:两个事件共用同一次探测,也不产生无意义的列表重拉
    expect(callsTo(SESSION, "GET")).toHaveLength(1);
    expect(callsTo(ANONYMOUS, "POST")).toHaveLength(0);
    expect(callsTo(LIST, "GET")).toHaveLength(0);
  });

  test("C-401-01 发消息 401:原 POST 恰 1 次,并进入身份恢复链", async () => {
    route = (url, method) => {
      if (url === SESSION) {
        // 挂载时不探测(本地已是 authenticated);这一次是 401 之后的复核 → 已无身份
        return reply(200, sessionData(false));
      }
      if (url === ANONYMOUS && method === "POST") {
        return reply(200, sessionData(true, "ANONYMOUS"));
      }
      if (url.startsWith(LIST) && method === "GET") {
        return reply(200, [conversation("c-1", "旧匿名会话")], {
          nextCursor: null,
        });
      }
      if (url.endsWith("/messages")) {
        return method === "POST"
          ? fail(401, "AUTH_REQUIRED", "Session required")
          : reply(200, [], { nextCursor: null, totalCount: 1 });
      }
      return undefined;
    };

    // 前置:本 Tab 已有一个可用匿名身份(§5 自动进入之后)
    useAuthStore.setState({
      status: "authenticated",
      userType: "ANONYMOUS",
      expiresAt: STAMP,
    });
    renderGate();
    await act(settle);

    await act(async () => {
      await useChatStore.getState().onUserInput("这条不该被重发");
      await settle();
    });

    // §12:失败的 mutation 没有被自动重放
    expect(
      callsTo("/backend-api/conversations/c-1/messages", "POST"),
    ).toHaveLength(1);
    // §13:身份确实进入 stale → probe → 重新建匿名
    expect(callsTo(SESSION, "GET")).toHaveLength(1);
    expect(callsTo(ANONYMOUS, "POST")).toHaveLength(1);
    expect(useAuthStore.getState().status).toBe("authenticated");
    expect(useAuthStore.getState().userType).toBe("ANONYMOUS");
    // 本地原以为有效的身份其实已没了 → 代数前进,消费方据此丢掉旧数据
    expect(useAuthStore.getState().identityEpoch).toBeGreaterThan(0);
  });

  test("C-401-02 边界之后旧身份迟到的列表响应必须作废,新身份列表可用", async () => {
    let releaseOldList: ((value: unknown) => void) | null = null;
    let listCalls = 0;
    route = (url, method) => {
      if (url === SESSION) return reply(200, sessionData(true, "ANONYMOUS"));
      if (url.startsWith(LIST) && method === "GET") {
        listCalls += 1;
        if (listCalls === 1) {
          // 旧身份的首屏响应故意悬着:它必须在新身份边界之后失效
          return new Promise((resolve) => {
            releaseOldList = resolve;
          });
        }
        return reply(200, [conversation("c-new", "新身份会话")], {
          nextCursor: null,
        });
      }
      if (url.endsWith("/messages")) {
        return reply(200, [], { nextCursor: null, totalCount: 0 });
      }
      return undefined;
    };

    renderGate();
    await act(settle);
    expect(useChatStore.getState().ready).toBe(false);

    useChatStore.getState().resetForIdentity();
    await act(async () => {
      await useChatStore.getState().bootstrap();
      await settle();
    });
    expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual(["c-new"]);

    // 旧身份那条迟到的响应回来:整体作废,既不写 UI 也不污染分页
    await act(async () => {
      releaseOldList?.(
        reply(200, [conversation("c-anon", MARKER)], { nextCursor: null }),
      );
      await settle();
    });

    const chat = useChatStore.getState();
    expect(chat.sessions.map((s) => s.id)).toEqual(["c-new"]);
    expect(JSON.stringify(chat.sessions)).not.toContain(MARKER);
    expect(chat.listReloadError).toBe(false);
  });

  test("C-401-03 恢复链里 anonymous 被拒:blocked 终态且 anonymous 只发一次", async () => {
    route = (url, method) => {
      if (url === SESSION) return reply(200, sessionData(false));
      if (url === ANONYMOUS && method === "POST") {
        return fail(401, "AUTH_FORBIDDEN", "该身份已被拒绝");
      }
      if (url.startsWith(LIST) && method === "GET") {
        return reply(200, [conversation("c-1", "旧匿名会话")], {
          nextCursor: null,
        });
      }
      if (url.endsWith("/messages")) {
        return method === "POST"
          ? fail(401, "AUTH_REQUIRED", "Session required")
          : reply(200, [], { nextCursor: null, totalCount: 1 });
      }
      return undefined;
    };

    useAuthStore.setState({
      status: "authenticated",
      userType: "ANONYMOUS",
      expiresAt: STAMP,
    });
    renderGate();
    await act(settle);

    await act(async () => {
      await useChatStore.getState().onUserInput("发不出去了");
      await settle();
    });

    expect(useAuthStore.getState().status).toBe("blocked");
    expect(callsTo(ANONYMOUS, "POST")).toHaveLength(1);
    expect(
      callsTo("/backend-api/conversations/c-1/messages", "POST"),
    ).toHaveLength(1);
    // blocked 是确定性终态:聊天界面被中性提示替换,不给「再试一次」留自动循环
    expect(childMounted()).toBe(false);
    expect(screen.getByText(Locale.Bootstrap.Blocked)).toBeTruthy();
  });
});
