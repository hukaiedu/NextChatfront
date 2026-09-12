import { jest } from "@jest/globals";
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

// 先导入 store:组件经 store/index 形成循环依赖,先完成 store 求值可避免 Locale 未初始化
import { resetAuthBootstrapState, useAuthStore } from "../app/store/auth";
import { stopBrowserStatusPolling } from "../app/store/browser";
import Locale from "../app/locales";

/**
 * V1.3-C §49:Admin 控制台矩阵 C-ADMIN-01..08;FIX-01 补 Provider 运维 09..11。
 *
 * 从最外层伪造 HTTP,断言「路由可达性 + canonical URL + 身份守卫」:
 * /admin 与 /admin/login 都只做 session 探测,绝不顺带创建匿名身份(§17),
 * 运维请求只走 canonical /backend-api/admin/*(§22)。
 */

const push = jest.fn();
const replace = jest.fn();
/** 引用必须稳定:页面把 router 放进 useEffect 依赖 */
const routerMock = { push, replace, back: jest.fn(), prefetch: jest.fn() };

// ESM 下 jest.mock 不生效,必须 unstable_mockModule(同 attachment-tray.test.tsx)
jest.unstable_mockModule("next/navigation", () => ({
  __esModule: true,
  useRouter: () => routerMock,
}));

let AdminConsolePage: React.ComponentType;
let AdminLoginPage: React.ComponentType;

const STAMP = "2026-09-12T00:00:00.000Z";
const SESSION = "/backend-api/auth/session";
const ANONYMOUS = "/backend-api/auth/anonymous";
const LOGIN = "/backend-api/auth/login";
const LOGOUT = "/backend-api/auth/logout";
const BROWSER_STATUS = "/backend-api/admin/browser/status";
const PROVIDER_STATUS = "/backend-api/admin/provider/status";
const PROVIDER_OPEN = "/backend-api/admin/provider/open";
const PROVIDER_RESTART = "/backend-api/admin/provider/restart";
const REVOKE_ALL = "/backend-api/admin/sessions/revoke-all";

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

function sessionData(authenticated: boolean, userType: string | null = null) {
  return authenticated
    ? { authenticated: true, expiresAt: STAMP, userType }
    : { authenticated: false, expiresAt: null };
}

function browserSnapshot() {
  return {
    state: "RUNNING",
    browserType: "chromium",
    headless: true,
    profileDir: "data/browser-profile",
    startedAt: STAMP,
    uptimeMs: 60_000,
    providerLoggedIn: true,
    activeRequests: 0,
    lastError: null,
    observedAt: STAMP,
  };
}

function callsTo(url: string, method = "GET") {
  return calls.filter((c) => c.url === url && c.method === method);
}

/** 点击 ui-lib 确认弹窗里的「确认」或「取消」 */
async function answerConfirm(accept: boolean) {
  await act(settle);
  const mask = document.querySelector(".modal-mask");
  expect(mask).toBeTruthy();
  const label = accept ? Locale.UI.Confirm : Locale.UI.Cancel;
  const button = Array.from(mask!.querySelectorAll("button")).find((el) =>
    (el.textContent ?? "").includes(label),
  );
  fireEvent.click(button!);
  await act(settle);
}

beforeAll(async () => {
  AdminConsolePage = (await import("../app/admin/page")).default;
  AdminLoginPage = (await import("../app/admin/login/page")).default;
});

beforeEach(() => {
  calls.length = 0;
  push.mockClear();
  replace.mockClear();
  hardNav.mockClear();
  installLocationStub();
  useAuthStore.setState({
    status: "unknown",
    userType: null,
    expiresAt: null,
    identityEpoch: 0,
    bootstrapErrorCode: null,
    adminLoginError: null,
    logoutError: null,
  });
  resetAuthBootstrapState();
  stopBrowserStatusPolling();
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
});

afterEach(() => {
  uninstallLocationStub();
  stopBrowserStatusPolling();
});

function providerSnapshot(status = "READY") {
  return { provider: "GEMINI_WEB", status };
}

/**
 * 整页硬导航替身:jsdom 的 Location.replace 不可配置(`Object.defineProperty` 直接抛
 * TypeError),所以只能换掉整个 window.location 对象。FIX-02A 的判据就是「换文档」,
 * 用 router.replace 断言会漏掉这个区别。
 */
const hardNav = jest.fn();
let realLocation: Location | undefined;

function installLocationStub() {
  realLocation = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...realLocation, replace: hardNav },
  });
}

function uninstallLocationStub() {
  if (!realLocation) return;
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: realLocation,
  });
  realLocation = undefined;
}

/** 后端只承认 ADMIN 身份;运维端点返回固定快照 */
function asAdmin() {
  route = (url) => {
    if (url === SESSION) return reply(200, { data: sessionData(true, "ADMIN") });
    if (url === BROWSER_STATUS) return reply(200, { data: browserSnapshot() });
    if (url === PROVIDER_STATUS) return reply(200, { data: providerSnapshot() });
    return undefined;
  };
}

describe("C-ADMIN /admin 身份守卫", () => {
  test("C-ADMIN-01 未登录访问 /admin → 回 /admin/login,不创建匿名身份", async () => {
    route = (url) =>
      url === SESSION ? reply(200, { data: sessionData(false) }) : undefined;

    render(React.createElement(AdminConsolePage));
    await act(settle);

    expect(replace).toHaveBeenCalledWith("/admin/login");
    expect(callsTo(ANONYMOUS, "POST")).toHaveLength(0);
    expect(callsTo(BROWSER_STATUS)).toHaveLength(0);
    expect(screen.queryByText(Locale.Browser.Title)).toBeNull();
  });

  test("C-ADMIN-02 匿名身份访问 /admin → 同样回登录页,且完全不碰运维端点", async () => {
    route = (url) =>
      url === SESSION ? reply(200, { data: sessionData(true, "ANONYMOUS") }) : undefined;

    render(React.createElement(AdminConsolePage));
    await act(settle);

    expect(replace).toHaveBeenCalledWith("/admin/login");
    expect(callsTo(ANONYMOUS, "POST")).toHaveLength(0);
    expect(callsTo(BROWSER_STATUS)).toHaveLength(0);
    expect(callsTo(PROVIDER_STATUS)).toHaveLength(0);
  });

  test("C-ADMIN-03 ADMIN 访问 /admin → 渲染控制台,运维请求只用 canonical 路径(§22/§50)", async () => {
    asAdmin();

    render(React.createElement(AdminConsolePage));
    await act(settle);

    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText(Locale.AdminConsole.Title)).toBeTruthy();
    expect(screen.getByText(Locale.Browser.Title)).toBeTruthy();
    // 运维字段只出现在 Admin 面
    expect(screen.getByText("data/browser-profile")).toBeTruthy();
    expect(callsTo(BROWSER_STATUS)).toHaveLength(1);
    // V1.3-C FIX-01:Provider 状态面板同样只用 canonical 路径
    expect(screen.getByText(Locale.AdminConsole.Provider.Title)).toBeTruthy();
    expect(screen.getByText(Locale.AdminConsole.Provider.State.READY)).toBeTruthy();
    expect(callsTo(PROVIDER_STATUS)).toHaveLength(1);
    expect(
      calls.some((c) => c.url === "/backend-api/provider/status"),
    ).toBe(false);
    expect(
      calls.some((c) => c.url.startsWith("/backend-api/browser/")),
    ).toBe(false);
  });

  test("C-ADMIN-04 已 ADMIN 打开 /admin/login → 直接进控制台,不渲染表单", async () => {
    route = (url) =>
      url === SESSION ? reply(200, { data: sessionData(true, "ADMIN") }) : undefined;

    render(React.createElement(AdminLoginPage));
    await act(settle);

    expect(replace).toHaveBeenCalledWith("/admin");
    expect(screen.queryByPlaceholderText(Locale.AdminConsole.PasswordPlaceholder)).toBeNull();
  });
});

describe("C-ADMIN 登录页", () => {
  test("C-ADMIN-05 已有匿名身份时给出切换提示,密码只进请求体(§18/§69)", async () => {
    route = (url, method, body) => {
      if (url === SESSION) {
        return reply(200, { data: sessionData(true, "ANONYMOUS") });
      }
      if (url === LOGIN && method === "POST") {
        expect(body.password).toBe("secret");
        return reply(200, { data: sessionData(true, "ADMIN") });
      }
      return undefined;
    };

    render(React.createElement(AdminLoginPage));
    await act(settle);

    expect(screen.getByText(Locale.AdminConsole.SwitchWarning)).toBeTruthy();

    fireEvent.change(
      screen.getByPlaceholderText(Locale.AdminConsole.PasswordPlaceholder),
      { target: { value: "secret" } },
    );
    await act(async () => {
      fireEvent.click(screen.getByText(Locale.AdminConsole.Submit));
      await settle();
    });

    // FIX-02A:登录成功 = 换文档,不是 client 路由(后者会把旧匿名 chat store 留在内存里)
    expect(hardNav).toHaveBeenCalledWith("/admin");
    expect(replace).not.toHaveBeenCalled();
    expect(callsTo(LOGIN, "POST")).toHaveLength(1);
    // §69:密码不落任何存储,且提交后输入框已清空
    expect(localStorage.length).toBe(0);
    expect(document.body.innerHTML).not.toContain("secret");
  });

  test("C-ADMIN-06 COMPAT 模式 200 + ANONYMOUS 判为管理员不可用(§19)", async () => {
    route = (url) => {
      if (url === SESSION) return reply(200, { data: sessionData(false) });
      if (url === LOGIN) {
        return reply(200, { data: sessionData(true, "ANONYMOUS") });
      }
      return undefined;
    };

    render(React.createElement(AdminLoginPage));
    await act(settle);

    fireEvent.change(
      screen.getByPlaceholderText(Locale.AdminConsole.PasswordPlaceholder),
      { target: { value: "secret" } },
    );
    await act(async () => {
      fireEvent.click(screen.getByText(Locale.AdminConsole.Submit));
      await settle();
    });

    expect(replace).not.toHaveBeenCalled();
    expect(useAuthStore.getState().adminLoginError?.code).toBe(
      "ADMIN_UNAVAILABLE",
    );
    expect(
      screen.getByText(Locale.AdminConsole.Error.ADMIN_UNAVAILABLE),
    ).toBeTruthy();
  });
});

/** 在 ADMIN 守卫路由之上叠加额外的端点 */
function adminSurface(extra: MockRoute = () => undefined) {
  route = (url, method, body) => {
    if (url === SESSION) return reply(200, { data: sessionData(true, "ADMIN") });
    if (url === BROWSER_STATUS) return reply(200, { data: browserSnapshot() });
    if (url === PROVIDER_STATUS) return reply(200, { data: providerSnapshot() });
    return extra(url, method, body);
  };
}

describe("C-ADMIN 登录状态收口", () => {
  test("C-ADMIN-07 吊销全部登录状态:确认后才发 canonical 写请求,且不建新匿名身份(§42)", async () => {
    adminSurface((url, method) =>
      url === REVOKE_ALL && method === "POST"
        ? reply(200, { data: { revoked: 3 } })
        : undefined,
    );

    render(React.createElement(AdminConsolePage));
    await act(settle);

    const revokeButton = () =>
      screen.getAllByText(Locale.AdminConsole.Sessions.RevokeAll).at(-1)!;

    fireEvent.click(revokeButton());
    await answerConfirm(false);
    expect(callsTo(REVOKE_ALL, "POST")).toHaveLength(0);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText(Locale.AdminConsole.Title)).toBeTruthy();

    fireEvent.click(revokeButton());
    await answerConfirm(true);

    expect(callsTo(REVOKE_ALL, "POST")).toHaveLength(1);
    expect(replace).toHaveBeenCalledWith("/admin/login");
    // 本地身份被清空,但没有被自动换成一个新的匿名访客身份
    expect(callsTo(ANONYMOUS, "POST")).toHaveLength(0);
  });

  test("C-ADMIN-08 退出登录:后端 204 才下线,失败保持登录态(§43)", async () => {
    adminSurface((url, method) =>
      url === LOGOUT && method === "POST"
        ? fail(500, "INTERNAL_ERROR", "boom")
        : undefined,
    );

    render(React.createElement(AdminConsolePage));
    await act(settle);

    const logoutButton = () =>
      screen.getAllByText(Locale.AdminConsole.Logout.Title).at(-1)!;

    fireEvent.click(logoutButton());
    await answerConfirm(true);
    // 后端没有确认清除:不跳转、控制台仍在、错误已记录
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText(Locale.AdminConsole.Title)).toBeTruthy();
    expect(useAuthStore.getState().logoutError?.code).toBe("INTERNAL_ERROR");

    adminSurface((url, method) =>
      url === LOGOUT && method === "POST"
        ? { ok: true, status: 204, headers: { get: () => null }, json: async () => null }
        : undefined,
    );
    fireEvent.click(logoutButton());
    await answerConfirm(true);

    expect(replace).toHaveBeenCalledWith("/admin/login");
    expect(useAuthStore.getState().logoutError).toBeNull();
  });
});

describe("C-ADMIN Provider 运维(FIX-01 补齐)", () => {
  test("C-ADMIN-09 打开 Provider:无二次确认,只发 canonical POST /admin/provider/open", async () => {
    adminSurface((url, method) =>
      url === PROVIDER_OPEN && method === "POST"
        ? reply(200, { data: providerSnapshot("READY") })
        : undefined,
    );

    render(React.createElement(AdminConsolePage));
    await act(settle);

    fireEvent.click(screen.getByText(Locale.AdminConsole.Provider.Open));
    await act(settle);

    expect(callsTo(PROVIDER_OPEN, "POST")).toHaveLength(1);
    // 旧 alias 已退役,不得再出现在前端调用面
    expect(
      calls.some((c) => c.url === "/backend-api/provider/open"),
    ).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });

  test("C-ADMIN-10 重启 Provider:确认弹窗取消 → 0 次写请求;确认 → 1 次 canonical POST", async () => {
    adminSurface((url, method) =>
      url === PROVIDER_RESTART && method === "POST"
        ? reply(200, { data: providerSnapshot("STARTING") })
        : undefined,
    );

    render(React.createElement(AdminConsolePage));
    await act(settle);

    const restartButton = () =>
      screen.getAllByText(Locale.AdminConsole.Provider.Restart).at(-1)!;

    fireEvent.click(restartButton());
    await answerConfirm(false);
    expect(callsTo(PROVIDER_RESTART, "POST")).toHaveLength(0);
    expect(screen.getByText(Locale.AdminConsole.Title)).toBeTruthy();

    fireEvent.click(restartButton());
    await answerConfirm(true);

    expect(callsTo(PROVIDER_RESTART, "POST")).toHaveLength(1);
    expect(
      calls.some((c) => c.url === "/backend-api/provider/restart"),
    ).toBe(false);
    // 重启结果直接采用后端返回值:状态从就绪切到「启动中」
    expect(
      screen.getByText(Locale.AdminConsole.Provider.State.STARTING),
    ).toBeTruthy();
  });

  test("C-ADMIN-11 有在飞 Request 时后端拒绝重启:Admin 面显示原始错误码且不跳转(§36)", async () => {
    adminSurface((url, method) =>
      url === PROVIDER_RESTART && method === "POST"
        ? fail(503, "PROVIDER_NOT_READY", "Cannot restart while processing")
        : undefined,
    );

    render(React.createElement(AdminConsolePage));
    await act(settle);

    fireEvent.click(
      screen.getAllByText(Locale.AdminConsole.Provider.Restart).at(-1)!,
    );
    await answerConfirm(true);

    expect(callsTo(PROVIDER_RESTART, "POST")).toHaveLength(1);
    expect(document.body.textContent ?? "").toContain("PROVIDER_NOT_READY");
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText(Locale.AdminConsole.Title)).toBeTruthy();
  });
});

/**
 * V1.3-C FIX-02 身份边界(Admin surface)。
 *
 * C-IDSW-01「登录成功必须换文档」的判据在 C-ADMIN-05(同一条契约,不重复实现);
 * 这里补另外两个方向:失败与 COMPAT 都不得动身份,以及 Cookie 被别的 Tab 改掉之后
 * 本 Tab 重新活跃时必须复核。
 */
async function submitPassword(password: string) {
  fireEvent.change(
    screen.getByPlaceholderText(Locale.AdminConsole.PasswordPlaceholder),
    { target: { value: password } },
  );
  await act(async () => {
    fireEvent.click(screen.getByText(Locale.AdminConsole.Submit));
    await settle();
  });
}

describe("FIX-02 身份切换与多 Tab(Admin surface)", () => {
  test("C-IDSW-02 登录 401:匿名身份与聊天数据原样保留,不换文档", async () => {
    route = (url, method) => {
      if (url === SESSION) {
        return reply(200, { data: sessionData(true, "ANONYMOUS") });
      }
      if (url === LOGIN && method === "POST") {
        return fail(401, "AUTH_INVALID_CREDENTIALS", "密码不对");
      }
      return undefined;
    };
    // 本 Tab 已按匿名身份进入应用:聊天态必须在失败后原样留着
    useAuthStore.setState({
      status: "authenticated",
      userType: "ANONYMOUS",
      expiresAt: STAMP,
    });

    render(React.createElement(AdminLoginPage));
    await act(settle);
    await submitPassword("wrong");

    expect(hardNav).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(useAuthStore.getState().status).toBe("authenticated");
    expect(useAuthStore.getState().userType).toBe("ANONYMOUS");
    expect(useAuthStore.getState().adminLoginError?.code).toBe(
      "AUTH_INVALID_CREDENTIALS",
    );
    // 失败登录不牵连身份链:既没被当成 401 业务失效,也没顺手建匿名身份
    expect(callsTo(ANONYMOUS, "POST")).toHaveLength(0);
    expect(callsTo(SESSION, "GET")).toHaveLength(1);
  });

  test("C-IDSW-03 COMPAT 200 + ANONYMOUS:不触发 ADMIN 身份切换与换文档", async () => {
    route = (url) => {
      if (url === SESSION) return reply(200, { data: sessionData(false) });
      if (url === LOGIN) {
        return reply(200, { data: sessionData(true, "ANONYMOUS") });
      }
      return undefined;
    };

    render(React.createElement(AdminLoginPage));
    await act(settle);
    await submitPassword("secret");

    expect(hardNav).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(useAuthStore.getState().userType).toBe("ANONYMOUS");
    expect(
      screen.getByText(Locale.AdminConsole.Error.ADMIN_UNAVAILABLE),
    ).toBeTruthy();
  });

  test("C-TAB-03 另一 Tab 吊销后本 Admin Tab 重新活跃:回登录页且绝不建匿名身份(§9)", async () => {
    let probe = sessionData(true, "ADMIN");
    route = (url) => {
      if (url === SESSION) return reply(200, { data: probe });
      if (url === BROWSER_STATUS) return reply(200, { data: browserSnapshot() });
      if (url === PROVIDER_STATUS) return reply(200, { data: providerSnapshot() });
      return undefined;
    };

    render(React.createElement(AdminConsolePage));
    await act(settle);
    expect(replace).not.toHaveBeenCalled();

    // 另一个 Tab revoke-all / logout:共享 Cookie 已不再是 ADMIN
    probe = sessionData(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
    });

    expect(replace).toHaveBeenCalledWith("/admin/login");
    expect(callsTo(ANONYMOUS, "POST")).toHaveLength(0);
    expect(useAuthStore.getState().status).toBe("unknown");
    expect(useAuthStore.getState().userType).toBeNull();
  });

  test("C-TAB-03A focus 与 visibilitychange 紧邻:session 只复核一次(§7)", async () => {
    adminSurface();
    render(React.createElement(AdminConsolePage));
    await act(settle);
    const before = callsTo(SESSION, "GET").length;

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      await settle();
    });

    expect(callsTo(SESSION, "GET").length - before).toBe(1);
    expect(replace).not.toHaveBeenCalled();
  });

  test("C-TAB-03B 复核遇到 5xx:不把管理员踢出", async () => {
    let probe = reply(200, { data: sessionData(true, "ADMIN") });
    route = (url) => {
      if (url === SESSION) return probe;
      if (url === BROWSER_STATUS) return reply(200, { data: browserSnapshot() });
      if (url === PROVIDER_STATUS) return reply(200, { data: providerSnapshot() });
      return undefined;
    };

    render(React.createElement(AdminConsolePage));
    await act(settle);

    probe = fail(500, "INTERNAL_ERROR", "boom");
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await settle();
    });

    // 确实复核过(页面自己只把探测结果留在组件 state,不写 auth store)
    expect(callsTo(SESSION, "GET")).toHaveLength(2);
    expect(replace).not.toHaveBeenCalled();
    expect(
      screen.getByText(Locale.AdminConsole.Session.Title),
    ).toBeTruthy();
  });
});
