import { jest } from "@jest/globals";
import React from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * V1.4 U4 §51/§52/§80/§96:输入框身份隐私(INPUT-ID-01..05)。
 *
 * 渲染真实 <Chat>,断言的是**看得见的 textarea 的值** —— 这是 §51 指出的真实缺陷:
 * resetForIdentity() 只清 store 的 lastInput,组件本地的 userInput 草稿在同文档换主体
 * (401 掉身份、旁观 Tab 被顶号)时并不会被清,上一身份没发出去的字会留在框里。
 *
 * 判据方向:真正换主体必须清空;注册原地升级(同一 userId、epoch 不动)不得被强清。
 */

const STAMP = "2026-09-13T00:00:00.000Z";
const PREFIX = "/backend-api";
const SESSION = `${PREFIX}/auth/session`;
const LIST = `${PREFIX}/conversations?`;
const DRAFT = "上一身份没发出去的话";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  await tick();
  await tick();
};

class FakeIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

let useChatStore: (typeof import("../app/store/chat"))["useChatStore"];
let useAuthStore: (typeof import("../app/store/auth"))["useAuthStore"];
let resetAuthBootstrapState: (typeof import("../app/store/auth"))["resetAuthBootstrapState"];
let Chat: (typeof import("../app/components/chat"))["Chat"];

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

let cookie = true;
let backendType = "ANONYMOUS";
let backendName: string | null = null;

function sessionDto(userType: string, username: string | null) {
  return { authenticated: true, expiresAt: STAMP, userType, username };
}

function routes(url: string, method: string, body?: any): any {
  if (url === SESSION) {
    return cookie
      ? reply(200, sessionDto(backendType, backendName))
      : reply(200, { authenticated: false, expiresAt: null });
  }
  if (url === `${PREFIX}/auth/anonymous` && method === "POST") {
    cookie = true;
    backendType = "ANONYMOUS";
    backendName = null;
    return reply(200, sessionDto("ANONYMOUS", null));
  }
  if (url === `${PREFIX}/auth/register` && method === "POST") {
    if (!cookie || backendType !== "ANONYMOUS") {
      return reply(401, { authenticated: false, expiresAt: null });
    }
    backendType = "REGISTERED";
    backendName = body.username;
    return reply(200, sessionDto("REGISTERED", body.username));
  }
  if (url.startsWith(LIST) && method === "GET") {
    return reply(
      200,
      backendType === "ANONYMOUS"
        ? [
            {
              id: "c-anon",
              title: "访客会话",
              status: "ACTIVE",
              preferredModelKey: null,
              createdAt: STAMP,
              updatedAt: STAMP,
            },
          ]
        : [
            {
              id: "c-reg",
              title: "注册账号会话",
              status: "ACTIVE",
              preferredModelKey: null,
              createdAt: STAMP,
              updatedAt: STAMP,
            },
          ],
      { nextCursor: null },
    );
  }
  if (url.endsWith("/messages")) {
    return reply(200, [], { nextCursor: null, totalCount: 0 });
  }
  return undefined;
}

function inputBox(): HTMLTextAreaElement {
  const el = document.getElementById("chat-input");
  expect(el).toBeTruthy();
  return el as HTMLTextAreaElement;
}

function typeDraft(text = DRAFT) {
  act(() => {
    fireEvent.input(inputBox(), { target: { value: text } });
  });
  expect(inputBox().value).toBe(text);
}

beforeAll(async () => {
  (globalThis as any).IntersectionObserver = FakeIntersectionObserver;
  Element.prototype.scrollIntoView = () => {};
  (Element.prototype as any).scrollTo = () => {};
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get: () => 6000,
  });
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get: () => 600,
  });
  (Element.prototype as any).getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 600,
    width: 0,
    height: 600,
    toJSON: () => ({}),
  });

  const prevFetch = globalThis.fetch.bind(globalThis);
  (globalThis as any).fetch = async (input: any, init: any = {}) => {
    const url = String(input);
    if (url.includes("prompts.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ en: [], tw: [], cn: [] }),
      };
    }
    const method = String(init.method ?? "GET").toUpperCase();
    const body =
      typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method });
    return routes(url, method, body) ?? prevFetch(input, init);
  };

  // chat store 必须先于组件求值(组件经 store/index 形成循环依赖)
  ({ useChatStore } = await import("../app/store/chat"));
  ({ useAuthStore, resetAuthBootstrapState } = await import("../app/store/auth"));
  ({ Chat } = await import("../app/components/chat"));
});

beforeEach(async () => {
  calls.length = 0;
  cookie = true;
  backendType = "ANONYMOUS";
  backendName = null;
  useAuthStore.setState({
    status: "authenticated",
    userType: "ANONYMOUS",
    username: null,
    sameSubjectTransition: false,
    expiresAt: STAMP,
    identityEpoch: 0,
    bootstrapErrorCode: null,
    adminLoginError: null,
    logoutError: null,
  });
  useChatStore.getState().resetForIdentity();
  resetAuthBootstrapState();
  localStorage.clear();
  await act(async () => {
    await useChatStore.getState().bootstrap();
    await settle();
  });
});

function renderChat() {
  return render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(Chat),
    ),
  );
}

describe("INPUT 换主体清空输入框(V1.4 U4 §51/§52)", () => {
  test("INPUT-ID-01 访客 → 登录已有账号:可见输入框被清空", async () => {
    renderChat();
    await act(settle);
    typeDraft();

    await act(async () => {
      useAuthStore.getState().clearIdentity();
      backendType = "REGISTERED";
      backendName = "alice";
      await useAuthStore.getState().probeIdentity();
      await settle();
    });

    expect(inputBox().value).toBe("");
    expect(useAuthStore.getState().identityEpoch).toBe(1);
  });

  test("INPUT-ID-02 注册用户退出:可见输入框被清空", async () => {
    cookie = true;
    backendType = "REGISTERED";
    backendName = "alice";
    useAuthStore.setState({
      status: "authenticated",
      userType: "REGISTERED",
      username: "alice",
      expiresAt: STAMP,
    });
    await act(async () => {
      await useChatStore.getState().bootstrap();
      await settle();
    });
    renderChat();
    await act(settle);
    typeDraft();

    await act(async () => {
      await useAuthStore.getState().logout();
      await settle();
    });

    expect(inputBox().value).toBe("");
    expect(useAuthStore.getState().username).toBeNull();
  });

  test("INPUT-ID-03 退出所有设备:可见输入框被清空", async () => {
    cookie = true;
    backendType = "REGISTERED";
    backendName = "alice";
    useAuthStore.setState({
      status: "authenticated",
      userType: "REGISTERED",
      username: "alice",
      expiresAt: STAMP,
    });
    renderChat();
    await act(settle);
    typeDraft();

    await act(async () => {
      await useAuthStore.getState().revokeAllSessions();
      await settle();
    });

    expect(inputBox().value).toBe("");
    expect(useAuthStore.getState().status).toBe("unknown");
  });

  test("INPUT-ID-04 注册原地升级(同主体):输入框不被强清(§52)", async () => {
    renderChat();
    await act(settle);
    typeDraft();

    await act(async () => {
      await useAuthStore.getState().registerUser("alice", "Passw0rd!");
      await settle();
    });

    expect(inputBox().value).toBe(DRAFT);
    expect(useAuthStore.getState().userType).toBe("REGISTERED");
    expect(useAuthStore.getState().identityEpoch).toBe(0);
  });

  test("INPUT-ID-05 聊天中途 401 换到新访客:旧草稿不得留下(§51 真实路径)", async () => {
    renderChat();
    await act(settle);
    typeDraft();

    // 另一个 Tab 换了身份:本 Tab 的下一条业务请求拿到 401
    cookie = false;
    await act(async () => {
      useAuthStore.getState().markIdentityStale();
      await settle();
    });

    expect(inputBox().value).toBe("");
    // 本地先自认有效 → 后端说没有 → epoch 只自增一次,然后重建访客身份
    expect(useAuthStore.getState().identityEpoch).toBe(1);
    expect(useAuthStore.getState().status).toBe("authenticated");
    expect(useAuthStore.getState().userType).toBe("ANONYMOUS");
    expect(calls.some((c) => c.url === SESSION)).toBe(true);
  });
});
