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
import { setUnauthorizedHandler } from "../app/client/backend-api";

/**
 * V1.4 U4 §73/§74/§75/§76/§77:注册用户身份层的 store 与 AuthGate 矩阵。
 *
 * 与 V1.3 FIX-02 同一套路:不 mock 任何 production 模块,从最外层伪造 HTTP,
 * 渲染真实 AuthGate,判据落在**真实 chat store 状态**上(§94/§95 明确不接受只看 mock)。
 *
 * 页面级矩阵(PAGE-*、UI-*、AUTH-LOGIN-03..06、AUTH-PWD-05、AUTH-REV-04/05)
 * 在 v14u4-pages.test.tsx;输入框隐私(INPUT-*)在 v14u4-input.test.tsx。
 */

const STAMP = "2026-09-13T00:00:00.000Z";
const PREFIX = "/backend-api";
const SESSION = `${PREFIX}/auth/session`;
const ANONYMOUS = `${PREFIX}/auth/anonymous`;
const ADMIN_LOGIN = `${PREFIX}/auth/login`;
const USER_LOGIN = `${PREFIX}/auth/user/login`;
const REGISTER = `${PREFIX}/auth/register`;
const PASSWORD_CHANGE = `${PREFIX}/auth/password/change`;
const REVOKE_ALL = `${PREFIX}/auth/sessions/revoke-all`;
const ADMIN_REVOKE_ALL = `${PREFIX}/admin/sessions/revoke-all`;
const LOGOUT = `${PREFIX}/auth/logout`;
const LIST = `${PREFIX}/conversations?`;
const MARKER = "ANON_CHAT_MUST_SURVIVE_REGISTER";

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

function reply(status: number, data?: unknown, meta?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => ({ data: data ?? null, ...(meta ? { meta } : {}) }),
  };
}

function fail(status: number, code: string, message = "boom") {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({ error: { code, message, requestId: "r" } }),
  };
}

function conversation(id: string, title: string) {
  return {
    id,
    title,
    status: "ACTIVE",
    preferredModelKey: null,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function callsTo(url: string, method = "POST") {
  return calls.filter((c) => c.method === method && c.url === url);
}

/** 列表 URL 带 query,只能按前缀数 */
function listCalls() {
  return calls.filter((c) => c.method === "GET" && c.url.startsWith(LIST));
}

type MockRoute = (url: string, method: string, body: any) => any;
let route: MockRoute = () => undefined;

/** 后端侧「此刻 Cookie 属于谁」;注册 / 登录 / 退出会改写它 */
let backendType: "ANONYMOUS" | "REGISTERED" | "ADMIN" = "ANONYMOUS";
let backendName: string | null = null;
/** 浏览器还带着 Session Cookie 吗 —— logout / revoke-all 之后就是 false */
let cookie = true;
/** 注册响应里刻意放一个假名字,用来证明 store 的身份只来自 GET /auth/session */
const REGISTER_BODY_TRAP = "FROM_REGISTER_BODY";

function sessionDto(userType: string, username: string | null) {
  return { authenticated: true, expiresAt: STAMP, userType, username };
}

function baseRoutes(): MockRoute {
  return (url, method, body) => {
    if (url === SESSION) {
      return cookie
        ? reply(200, sessionDto(backendType, backendName))
        : reply(200, { authenticated: false, expiresAt: null });
    }
    if (url === ANONYMOUS && method === "POST") {
      cookie = true;
      backendType = "ANONYMOUS";
      backendName = null;
      return reply(200, sessionDto("ANONYMOUS", null));
    }
    if (url === REGISTER && method === "POST") {
      if (!cookie || backendType !== "ANONYMOUS") {
        return fail(401, "AUTH_REQUIRED");
      }
      backendType = "REGISTERED";
      backendName = body.username;
      return reply(200, sessionDto("REGISTERED", REGISTER_BODY_TRAP));
    }
    if (url === USER_LOGIN && method === "POST") {
      cookie = true;
      backendType = "REGISTERED";
      backendName = body.username;
      return reply(200, sessionDto("REGISTERED", body.username));
    }
    if (url === PASSWORD_CHANGE && method === "POST") {
      // 轮换当前 Session:Cookie 仍然有效
      return reply(200, sessionDto("REGISTERED", backendName));
    }
    if (url === REVOKE_ALL && method === "POST") {
      cookie = false;
      backendType = "ANONYMOUS";
      backendName = null;
      return reply(200, { revoked: 2 });
    }
    if (url === LOGOUT && method === "POST") {
      cookie = false;
      backendType = "ANONYMOUS";
      backendName = null;
      return reply(204);
    }
    if (url.startsWith(LIST) && method === "GET") {
      if (!cookie) return fail(401, "AUTH_REQUIRED");
      return reply(
        200,
        backendType === "ANONYMOUS"
          ? [conversation("c-anon", MARKER)]
          : [
              conversation(
                `c-${backendName ?? "x"}`,
                `属于 ${backendName} 的会话`,
              ),
            ],
        { nextCursor: null },
      );
    }
    if (url.endsWith("/messages")) {
      return reply(200, [], { nextCursor: null, totalCount: 0 });
    }
    return undefined;
  };
}

/** 在默认路由之上覆盖几条端点;未命中的仍走默认 */
function override(overrides: MockRoute) {
  const base = route;
  route = (url, method, body) =>
    overrides(url, method, body) ?? base(url, method, body);
}

/** 冒充 Home 的 useLoadData:挂载时按当前身份拉一次会话列表 */
function Child() {
  useEffect(() => {
    void useChatStore.getState().bootstrap();
  }, []);
  return createElement("div", { "data-testid": "child" });
}

function renderGate() {
  return render(createElement(AuthGate, null, createElement(Child)));
}

function topics() {
  return useChatStore.getState().sessions.map((s) => s.topic);
}

/** 把「本 Tab 已是注册用户」同时写进 store 与假后端,避免两边口径不一致 */
function asRegistered(name: string) {
  cookie = true;
  backendType = "REGISTERED";
  backendName = name;
  useAuthStore.setState({
    status: "authenticated",
    userType: "REGISTERED",
    username: name,
    expiresAt: STAMP,
  });
}

/** 把真实 resetForIdentity 换成「会调原实现的计数版」,既能断言调用又不伪造行为 */
function spyResetForIdentity() {
  const original = useChatStore.getState().resetForIdentity;
  const spy = jest.fn(original.bind(useChatStore.getState()));
  useChatStore.setState({ resetForIdentity: spy });
  return () => {
    useChatStore.setState({ resetForIdentity: original });
    return spy;
  };
}

beforeEach(() => {
  calls.length = 0;
  cookie = true;
  backendType = "ANONYMOUS";
  backendName = null;
  route = baseRoutes();
  useAuthStore.setState({
    status: "unknown",
    userType: null,
    username: null,
    sameSubjectTransition: false,
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
      const body =
        typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      return route(url, method, body) ?? fail(404, "NOT_FOUND");
    },
  );
  setUnauthorizedHandler(() => useAuthStore.getState().markIdentityStale());
});

describe("AUTH-REG 注册原地升级(V1.4 U4 §73)", () => {
  test("AUTH-REG-01 匿名注册成功 → sameSubjectTransition 置 true(§16)", async () => {
    useAuthStore.setState({
      status: "authenticated",
      userType: "ANONYMOUS",
      expiresAt: STAMP,
    });

    const result = await useAuthStore
      .getState()
      .registerUser("alice", "Passw0rd!");

    expect(result.ok).toBe(true);
    expect(callsTo(REGISTER)).toHaveLength(1);
    expect(useAuthStore.getState().sameSubjectTransition).toBe(true);
    // 没有换主体:身份实例代数一步都不该动(§49)
    expect(useAuthStore.getState().identityEpoch).toBe(0);
  });

  test("AUTH-REG-02 新身份只来自 GET /auth/session,不抄注册响应(§17)", async () => {
    useAuthStore.setState({
      status: "authenticated",
      userType: "ANONYMOUS",
      expiresAt: STAMP,
    });

    await useAuthStore.getState().registerUser("alice", "Passw0rd!");

    const state = useAuthStore.getState();
    expect(state.userType).toBe("REGISTERED");
    expect(state.username).toBe("alice");
    expect(state.username).not.toBe(REGISTER_BODY_TRAP);
    expect(callsTo(SESSION, "GET")).toHaveLength(1);
  });

  test("AUTH-REG-03 AuthGate 观测到 ANONYMOUS→REGISTERED 后标记归 false(§18)", async () => {
    renderGate();
    await act(settle);
    expect(useAuthStore.getState().userType).toBe("ANONYMOUS");

    await act(async () => {
      await useAuthStore.getState().registerUser("alice", "Passw0rd!");
      await settle();
    });

    const state = useAuthStore.getState();
    expect(state.userType).toBe("REGISTERED");
    expect(state.sameSubjectTransition).toBe(false);
  });

  test("AUTH-REG-04 同主体升级不调用 resetForIdentity(§47)", async () => {
    renderGate();
    await act(settle);
    useChatStore.getState().setLastInput("未发送的草稿");
    const restore = spyResetForIdentity();

    await act(async () => {
      await useAuthStore.getState().registerUser("alice", "Passw0rd!");
      await settle();
    });

    const spy = restore();
    expect(spy).not.toHaveBeenCalled();
  });

  test("AUTH-REG-05 当前会话、列表与草稿整体保留(§94 真状态判据)", async () => {
    renderGate();
    await act(settle);
    useChatStore.getState().setLastInput("未发送的草稿");
    expect(topics()).toEqual([MARKER]);

    await act(async () => {
      await useAuthStore.getState().registerUser("alice", "Passw0rd!");
      await settle();
    });

    const chat = useChatStore.getState();
    expect(chat.sessions.map((s) => s.id)).toEqual(["c-anon"]);
    expect(chat.sessions[0]!.topic).toBe(MARKER);
    expect(chat.lastInput).toBe("未发送的草稿");
    expect(chat.currentSessionIndex).toBe(0);
    // children 一直挂着 = 正在看的视图没被卸载
    expect(screen.getByTestId("child")).toBeTruthy();
    // 也没顺手为新身份重拉列表(那是换主体才做的事)
    expect(listCalls()).toHaveLength(1);
  });

  test("AUTH-REG-06 username 进 store 并停在 REGISTERED(§68)", async () => {
    renderGate();
    await act(settle);

    await act(async () => {
      await useAuthStore.getState().registerUser("Alice_9", "Passw0rd!");
      await settle();
    });

    expect(useAuthStore.getState().username).toBe("Alice_9");
    expect(useAuthStore.getState().userType).toBe("REGISTERED");
  });

  test("AUTH-REG-07 注册失败:不置标记、不清聊天、不动 epoch(§19)", async () => {
    renderGate();
    await act(settle);
    useChatStore.getState().setLastInput("还没发出去的话");
    override((url, method) =>
      url === REGISTER && method === "POST"
        ? fail(409, "AUTH_USERNAME_ALREADY_TAKEN")
        : undefined,
    );

    const result = await useAuthStore.getState().registerUser("bob", "Passw0rd!");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AUTH_USERNAME_ALREADY_TAKEN");
    }
    const state = useAuthStore.getState();
    expect(state.sameSubjectTransition).toBe(false);
    expect(state.userType).toBe("ANONYMOUS");
    expect(state.username).toBeNull();
    expect(state.identityEpoch).toBe(0);
    expect(useChatStore.getState().lastInput).toBe("还没发出去的话");
    expect(topics()).toEqual([MARKER]);
  });

  test("AUTH-REG-08 标记不串味:REGISTERED→REGISTERED 换主体仍重置(§47)", async () => {
    useAuthStore.setState({
      status: "authenticated",
      userType: "ANONYMOUS",
      expiresAt: STAMP,
    });
    await useChatStore.getState().bootstrap();
    expect(topics()).toEqual([MARKER]);

    // 本 Tab 没有挂 AuthGate,注册成功留下的标记无人消费
    await useAuthStore.getState().registerUser("alice", "Passw0rd!");
    expect(useAuthStore.getState().sameSubjectTransition).toBe(true);

    renderGate();
    await act(settle);

    // 另一个 Tab 登录了 carol:本 Tab 换了人,即使标记还是 true 也必须重置
    await act(async () => {
      useAuthStore.getState().clearIdentity();
      backendName = "carol";
      await useAuthStore.getState().probeIdentity();
      await settle();
    });

    expect(useAuthStore.getState().username).toBe("carol");
    expect(useAuthStore.getState().sameSubjectTransition).toBe(false);
    expect(topics()).not.toContain(MARKER);
  });
});

describe("AUTH-LOGIN 普通登录端点(V1.4 U4 §74)", () => {
  test("AUTH-LOGIN-01 userLogin 打 /auth/user/login,body 只有 username+password", async () => {
    const result = await useAuthStore
      .getState()
      .userLogin("alice", "Passw0rd!");

    expect(result.ok).toBe(true);
    const sent = callsTo(USER_LOGIN);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!.body).sort()).toEqual(["password", "username"]);
    expect(callsTo(ADMIN_LOGIN)).toHaveLength(0);
  });

  test("AUTH-LOGIN-02 口令错:错误交给页面,本地身份与聊天一点都不动", async () => {
    renderGate();
    await act(settle);
    useChatStore.getState().setLastInput("匿名草稿");
    override((url, method) =>
      url === USER_LOGIN && method === "POST"
        ? fail(401, "AUTH_INVALID_CREDENTIALS")
        : undefined,
    );

    const result = await useAuthStore.getState().userLogin("alice", "wrong-pass");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AUTH_INVALID_CREDENTIALS");
    }
    const state = useAuthStore.getState();
    expect(state.userType).toBe("ANONYMOUS");
    expect(state.username).toBeNull();
    expect(state.sameSubjectTransition).toBe(false);
    expect(state.identityEpoch).toBe(0);
    expect(useChatStore.getState().lastInput).toBe("匿名草稿");
    expect(topics()).toEqual([MARKER]);
  });
});

describe("AUTH-LOGOUT 退出(V1.4 U4 §75)", () => {
  test("AUTH-LOGOUT-01 后端 204 才算成功,请求只发一次", async () => {
    asRegistered("alice");

    await expect(useAuthStore.getState().logout()).resolves.toBe(true);

    expect(callsTo(LOGOUT)).toHaveLength(1);
  });

  test("AUTH-LOGOUT-02 成功后本地身份清空,username 不残留", async () => {
    asRegistered("alice");

    await useAuthStore.getState().logout();

    const state = useAuthStore.getState();
    expect(state.status).toBe("unknown");
    expect(state.userType).toBeNull();
    expect(state.username).toBeNull();
    expect(state.expiresAt).toBeNull();
    expect(state.identityEpoch).toBe(1);
    expect(state.sameSubjectTransition).toBe(false);
  });

  test("AUTH-LOGOUT-04 退出后回首页:AuthGate 探测失败 → 建新访客身份", async () => {
    asRegistered("alice");
    await useAuthStore.getState().logout();
    resetAuthBootstrapState();

    renderGate();
    await act(settle);

    const state = useAuthStore.getState();
    expect(callsTo(SESSION, "GET")).toHaveLength(1);
    expect(callsTo(ANONYMOUS)).toHaveLength(1);
    expect(state.status).toBe("authenticated");
    expect(state.userType).toBe("ANONYMOUS");
    expect(state.username).toBeNull();
    // 访客看到的是访客列表,carol/alice 的会话都不该出现
    expect(topics()).toEqual([MARKER]);
  });
});

describe("AUTH-PWD 改密(V1.4 U4 §76)", () => {
  test("AUTH-PWD-01 只发一次 /auth/password/change 且 body 精确", async () => {
    asRegistered("alice");

    const result = await useAuthStore
      .getState()
      .changePassword("Passw0rd!", "Rotated123!");

    expect(result.ok).toBe(true);
    const sent = callsTo(PASSWORD_CHANGE);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!.body).sort()).toEqual([
      "currentPassword",
      "newPassword",
    ]);
    expect(sent[0]!.body).toEqual({
      currentPassword: "Passw0rd!",
      newPassword: "Rotated123!",
    });
    expect(callsTo(LOGOUT)).toHaveLength(0);
    expect(callsTo(REVOKE_ALL)).toHaveLength(0);
  });

  test("AUTH-PWD-02 成功保持当前 REGISTERED 身份,epoch 不自增(§42)", async () => {
    asRegistered("alice");

    await useAuthStore.getState().changePassword("Passw0rd!", "Rotated123!");

    const state = useAuthStore.getState();
    expect(state.status).toBe("authenticated");
    expect(state.userType).toBe("REGISTERED");
    expect(state.identityEpoch).toBe(0);
    expect(state.sameSubjectTransition).toBe(false);
  });

  test("AUTH-PWD-03 username 保持,后端改名则跟随(§68)", async () => {
    asRegistered("alice");

    await useAuthStore.getState().changePassword("Passw0rd!", "Rotated123!");
    expect(useAuthStore.getState().username).toBe("alice");

    backendName = "renamed";
    await useAuthStore.getState().changePassword("Rotated123!", "Another456!");
    expect(useAuthStore.getState().username).toBe("renamed");
  });

  test("AUTH-PWD-04 聊天视图与草稿不动,resetForIdentity 不被调用", async () => {
    renderGate();
    await act(settle);
    await act(async () => {
      await useAuthStore.getState().registerUser("alice", "Passw0rd!");
      await settle();
    });
    useChatStore.getState().setLastInput("改密时正在写的草稿");
    const before = useChatStore.getState().sessions.map((s) => s.id);
    const restore = spyResetForIdentity();

    await act(async () => {
      await useAuthStore
        .getState()
        .changePassword("Passw0rd!", "Rotated123!");
      await settle();
    });

    const spy = restore();
    const chat = useChatStore.getState();
    expect(spy).not.toHaveBeenCalled();
    expect(chat.sessions.map((s) => s.id)).toEqual(before);
    expect(chat.lastInput).toBe("改密时正在写的草稿");
    expect(chat.ready).toBe(true);
  });
});

describe("AUTH-REV 全设备退出(V1.4 U4 §77)", () => {
  test("AUTH-REV-01 只打普通 /auth/sessions/revoke-all", async () => {
    asRegistered("alice");

    const result = await useAuthStore.getState().revokeAllSessions();

    expect(result.ok).toBe(true);
    expect(callsTo(REVOKE_ALL)).toHaveLength(1);
  });

  test("AUTH-REV-02 绝不误打 Admin 的吊销端点", async () => {
    asRegistered("alice");

    await useAuthStore.getState().revokeAllSessions();

    expect(callsTo(ADMIN_REVOKE_ALL)).toHaveLength(0);
    expect(
      calls.some((c) => c.url.startsWith(`${PREFIX}/admin/`)),
    ).toBe(false);
  });

  test("AUTH-REV-03 成功后清身份、关在途流,但不当场建匿名(§42/§43)", async () => {
    asRegistered("alice");
    const closed: string[] = [];
    trackStream("c-anon", { close: () => closed.push("c-anon") });
    expect(activeStreamCount()).toBe(1);

    await useAuthStore.getState().revokeAllSessions();

    const state = useAuthStore.getState();
    expect(state.status).toBe("unknown");
    expect(state.userType).toBeNull();
    expect(state.username).toBeNull();
    expect(state.identityEpoch).toBe(1);
    expect(closed).toEqual(["c-anon"]);
    expect(activeStreamCount()).toBe(0);
    expect(callsTo(ANONYMOUS)).toHaveLength(0);
  });
});
