import { jest } from "@jest/globals";
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

// 先导入 store:组件经 store/index 形成循环依赖,先完成 store 求值可避免 Locale 未初始化
import { useChatStore } from "../app/store/chat";
import { resetAuthBootstrapState, useAuthStore } from "../app/store/auth";
import {
  activeStreamCount,
  trackStream,
} from "../app/store/active-streams";
import Locale from "../app/locales";
import { setUnauthorizedHandler } from "../app/client/backend-api";

/**
 * V1.4 U4 §78/§79 与页面侧的换主体编排:PAGE-*、UI-*、AUTH-LOGIN-03..06、
 * AUTH-PWD-05、AUTH-LOGOUT-03、AUTH-REV-04/05。
 *
 * 渲染真实的 `/login`、`/register` 页面与 Settings 里的账号区,从最外层伪造 HTTP。
 * 「整页换文档」靠替换 window.location 断言(与 v13c-admin 同一手法) ——
 * 只看 router 会漏掉「换文档 vs 客户端跳转」这条本质区别。
 */

const push = jest.fn();
const replace = jest.fn();
const routerMock = { push, replace, back: jest.fn(), prefetch: jest.fn() };

// ESM 下 jest.mock 不生效,必须 unstable_mockModule(同 v13c-admin.test.tsx)
jest.unstable_mockModule("next/navigation", () => ({
  __esModule: true,
  useRouter: () => routerMock,
}));

let LoginPage: React.ComponentType;
let RegisterPage: React.ComponentType;
let AccountSection: React.ComponentType;

beforeAll(async () => {
  LoginPage = (await import("../app/login/page")).default;
  RegisterPage = (await import("../app/register/page")).default;
  ({ AccountSection } = await import("../app/components/account"));
});

const t = Locale.Account;
const STAMP = "2026-09-13T00:00:00.000Z";
const PREFIX = "/backend-api";
const SESSION = `${PREFIX}/auth/session`;
const ANONYMOUS = `${PREFIX}/auth/anonymous`;
const ADMIN_LOGIN = `${PREFIX}/auth/login`;
const USER_LOGIN = `${PREFIX}/auth/user/login`;
const REGISTER = `${PREFIX}/auth/register`;
const PASSWORD_CHANGE = `${PREFIX}/auth/password/change`;
const REVOKE_ALL = `${PREFIX}/auth/sessions/revoke-all`;
const LOGOUT = `${PREFIX}/auth/logout`;
const LIST = `${PREFIX}/conversations?`;
const ANON_MARKER = "ANON_PAGE_CHAT";
const REG_MARKER = "REGISTERED_PAGE_CHAT";

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

/** 带 Retry-After 的限流响应:client 必须把秒数解析成 retryAfterSeconds(§57) */
function failWithRetryAfter(status: number, code: string, seconds: string) {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => (name === "Retry-After" ? seconds : null) },
    json: async () => ({ error: { code, message: "slow down", requestId: "r" } }),
  };
}

function callsTo(url: string, method = "POST") {
  return calls.filter((c) => c.method === method && c.url === url);
}

type MockRoute = (url: string, method: string, body: any) => any;
let route: MockRoute = () => undefined;

let cookie = true;
let backendType: "ANONYMOUS" | "REGISTERED" | "ADMIN" = "ANONYMOUS";
let backendName: string | null = null;
/** 下一次凭据类请求的响应;默认成功,失败用例改成 fail(...) */
let credentialFailure: ((body: any) => any) | null = null;

function sessionDto(userType: string, username: string | null) {
  return { authenticated: true, expiresAt: STAMP, userType, username };
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
      // 与后端同一纪律:注册只升级一个已存在的匿名身份
      if (!cookie || backendType !== "ANONYMOUS") {
        return fail(401, "AUTH_REQUIRED");
      }
      if (credentialFailure) return credentialFailure(body);
      backendType = "REGISTERED";
      backendName = body.username;
      return reply(200, sessionDto("REGISTERED", body.username));
    }
    if (url === USER_LOGIN && method === "POST") {
      if (credentialFailure) return credentialFailure(body);
      cookie = true;
      backendType = "REGISTERED";
      backendName = body.username;
      return reply(200, sessionDto("REGISTERED", body.username));
    }
    if (url === PASSWORD_CHANGE && method === "POST") {
      if (credentialFailure) return credentialFailure(body);
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
          ? [conversation("c-anon", ANON_MARKER)]
          : [conversation("c-reg", REG_MARKER)],
        { nextCursor: null },
      );
    }
    if (url.endsWith("/messages")) {
      return reply(200, [], { nextCursor: null, totalCount: 0 });
    }
    return undefined;
  };
}

/**
 * 整页硬导航替身:jsdom 的 Location.replace 不可配置,只能换掉整个 window.location。
 * §20/§43/§44 的判据就是「换文档」,客户端跳转走 router.push,两者必须分得开。
 */
const hardNav = jest.fn();
const hardAssign = jest.fn();
let realLocation: Location | undefined;

beforeEach(() => {
  calls.length = 0;
  push.mockClear();
  replace.mockClear();
  hardNav.mockClear();
  hardAssign.mockClear();
  cookie = true;
  backendType = "ANONYMOUS";
  backendName = null;
  credentialFailure = null;
  route = baseRoutes();
  realLocation = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...realLocation, replace: hardNav, assign: hardAssign },
  });
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

afterEach(() => {
  if (!realLocation) return;
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: realLocation,
  });
  realLocation = undefined;
});

function topics() {
  return useChatStore.getState().sessions.map((s) => s.topic);
}

/** 把「本 Tab 已是注册用户」同时写进 store 与假后端 */
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

/** 访客身份 + 一份真实从后端加载出来的匿名聊天 */
async function asVisitorWithChat() {
  useAuthStore.setState({
    status: "authenticated",
    userType: "ANONYMOUS",
    expiresAt: STAMP,
  });
  await act(async () => {
    await useChatStore.getState().bootstrap();
    await settle();
  });
  expect(topics()).toEqual([ANON_MARKER]);
}

function fill(values: Record<string, string>) {
  for (const label of Object.keys(values)) {
    fireEvent.change(screen.getByLabelText(label), {
      target: { value: values[label] },
    });
  }
}

/** 点表单里唯一的 type=submit 按钮(导航按钮都是 type=button) */
function clickSubmit() {
  const button = screen
    .getAllByRole("button")
    .find((item) => item.getAttribute("type") === "submit");
  expect(button).toBeTruthy();
  act(() => {
    fireEvent.click(button as HTMLElement);
  });
}

async function submitLogin(username: string, password: string) {
  fill({ [t.Username]: username, [t.Password]: password });
  await act(async () => {
    clickSubmit();
    await settle();
  });
}

async function submitRegister(
  username: string,
  password: string,
  confirmPassword: string,
) {
  fill({
    [t.Username]: username,
    [t.Password]: password,
    [t.ConfirmPassword]: confirmPassword,
  });
  await act(async () => {
    clickSubmit();
    await settle();
  });
}

/**
 * showConfirm 的动作文本会被 IconButton 内层 aria-label 拼进可访问名,
 * 按 textContent 精确取才稳；标题与按钮在「确认」上还可能重名,所以不查文本节点。
 */
function clickDialogButton(label: string) {
  const target = screen
    .getAllByRole("button")
    .find((item) => (item.textContent ?? "").trim() === label);
  expect(target).toBeTruthy();
  act(() => {
    fireEvent.click(target as HTMLElement);
  });
}

describe("/login 页面(V1.4 U4 §78)", () => {
  test("AUTH-UI-01 使用 personChat auth layout,并保留三条导航意图", async () => {
    render(React.createElement(LoginPage));
    await act(settle);

    expect(screen.getByText("personChat")).toBeTruthy();
    expect(screen.getByRole("heading", { name: t.LoginTitle })).toBeTruthy();
    expect(screen.getByText(t.LoginSubtitle)).toBeTruthy();
    expect(screen.getByRole("button", { name: t.SubmitLogin })).toBeTruthy();
    expect(screen.getByRole("button", { name: t.ToRegister })).toBeTruthy();
    expect(screen.getByRole("button", { name: t.BackToChat })).toBeTruthy();
  });

  test("PAGE-LOGIN-01 只探测身份,绝不顺手建匿名 Session(§22)", async () => {
    render(React.createElement(LoginPage));
    await act(settle);

    expect(callsTo(SESSION, "GET")).toHaveLength(1);
    expect(callsTo(ANONYMOUS)).toHaveLength(0);
    expect(screen.getByLabelText(t.Username)).toBeTruthy();
  });

  test("PAGE-LOGIN-02 字段带正确的 name/type/autocomplete(§23/§34/§65)", async () => {
    render(React.createElement(LoginPage));
    await act(settle);

    const username = screen.getByLabelText(t.Username) as HTMLInputElement;
    const password = screen.getByLabelText(t.Password) as HTMLInputElement;
    expect(username.name).toBe("username");
    expect(username.getAttribute("autocomplete")).toBe("username");
    expect(password.type).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    expect(username.getAttribute("autocomplete")).not.toBe("off");
  });

  test("PAGE-LOGIN-03 用户名不存在 / 密码错 → 同一句文案且留在原页(§56)", async () => {
    useAuthStore.setState({
      status: "authenticated",
      userType: "ANONYMOUS",
      expiresAt: STAMP,
    });
    render(React.createElement(LoginPage));
    await act(settle);
    credentialFailure = () => fail(401, "AUTH_INVALID_CREDENTIALS");

    await submitLogin("alice", "Passw0rd!");

    expect(screen.getByRole("alert").textContent).toBe(
      t.Error.AUTH_INVALID_CREDENTIALS,
    );
    expect(useAuthStore.getState().userType).toBe("ANONYMOUS");
    expect(hardNav).not.toHaveBeenCalled();
  });

  test("PAGE-LOGIN-04 已是注册用户:显示当前账号并允许换号(§25)", async () => {
    asRegistered("alice");
    render(React.createElement(LoginPage));
    await act(settle);

    expect(screen.getByText(t.CurrentAccount("alice"))).toBeTruthy();
    expect(screen.getByText(t.SwitchAccountWarning)).toBeTruthy();
    expect(screen.getByLabelText(t.Username)).toBeTruthy();
    expect(callsTo(ANONYMOUS)).toHaveLength(0);
  });

  test("PAGE-LOGIN-05 管理员打开普通登录页:只提示,不碰 Admin 端点(§26)", async () => {
    backendType = "ADMIN";
    render(React.createElement(LoginPage));
    await act(settle);

    expect(screen.getByText(t.Admin)).toBeTruthy();
    expect(callsTo(ADMIN_LOGIN)).toHaveLength(0);
    // 管理员也不该被顺手塞一个匿名身份
    expect(callsTo(ANONYMOUS)).toHaveLength(0);
  });

  test("AUTH-LOGIN-03 登录成功先清掉旧身份(clearIdentity)", async () => {
    await asVisitorWithChat();
    render(React.createElement(LoginPage));
    await act(settle);

    await submitLogin("alice", "Passw0rd!");

    const state = useAuthStore.getState();
    expect(callsTo(USER_LOGIN)).toHaveLength(1);
    expect(state.status).toBe("unknown");
    expect(state.userType).toBeNull();
    expect(state.username).toBeNull();
    expect(state.identityEpoch).toBe(1);
  });

  test("AUTH-LOGIN-04 登录成功触发 resetForIdentity 且旧会话真消失(§95)", async () => {
    await asVisitorWithChat();
    const original = useChatStore.getState().resetForIdentity;
    const spy = jest.fn(original);
    useChatStore.setState({ resetForIdentity: spy });
    render(React.createElement(LoginPage));
    await act(settle);

    await submitLogin("alice", "Passw0rd!");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(topics()).toEqual([]);
    useChatStore.setState({ resetForIdentity: original });
  });

  test("AUTH-LOGIN-05 在途 SSE 随换主体一起关闭", async () => {
    await asVisitorWithChat();
    const closed: string[] = [];
    trackStream("c-anon", { close: () => closed.push("c-anon") });
    expect(activeStreamCount()).toBe(1);
    render(React.createElement(LoginPage));
    await act(settle);

    await submitLogin("alice", "Passw0rd!");

    expect(closed).toEqual(["c-anon"]);
    expect(activeStreamCount()).toBe(0);
  });

  test("AUTH-LOGIN-06 成功走整页换文档,而不是客户端跳转(§20)", async () => {
    await asVisitorWithChat();
    render(React.createElement(LoginPage));
    await act(settle);

    await submitLogin("alice", "Passw0rd!");

    expect(hardNav).toHaveBeenCalledWith("/");
    expect(push).not.toHaveBeenCalled();
  });

  test("PAGE-LOGIN-06 429 复用 Retry-After 秒数,不自动重试(§57)", async () => {
    render(React.createElement(LoginPage));
    await act(settle);
    credentialFailure = () => failWithRetryAfter(429, "AUTH_RATE_LIMITED", "37");

    await submitLogin("alice", "Passw0rd!");

    expect(screen.getByRole("alert").textContent).toBe(
      t.Error.AUTH_RATE_LIMITED(37),
    );
    // 一次就停:前端绝不自己循环重试口令
    expect(callsTo(USER_LOGIN)).toHaveLength(1);
  });

  test("PAGE-LOGIN-07 503 渲染成服务繁忙,绝不当成密码错误(§58)", async () => {
    render(React.createElement(LoginPage));
    await act(settle);
    credentialFailure = () => fail(503, "SERVICE_BUSY");

    await submitLogin("alice", "Passw0rd!");

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(t.Error.SERVICE_BUSY);
    expect(alert.textContent).not.toBe(t.Error.AUTH_INVALID_CREDENTIALS);
    expect(hardNav).not.toHaveBeenCalled();
  });
});

describe("/register 页面(V1.4 U4 §78)", () => {
  test("AUTH-UI-02 使用 personChat auth layout,并保留注册提示与导航", async () => {
    render(React.createElement(RegisterPage));
    await act(settle);

    expect(screen.getByText("personChat")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: t.RegisterTitle }),
    ).toBeTruthy();
    expect(screen.getByText(t.RegisterSubtitle)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: t.SubmitRegister }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: t.ToLogin })).toBeTruthy();
    expect(screen.getByRole("button", { name: t.BackToChat })).toBeTruthy();
  });

  test("PAGE-REGISTER-01 未认证打开 → 先建匿名身份再允许注册(§28)", async () => {
    cookie = false;
    render(React.createElement(RegisterPage));
    await act(settle);

    expect(callsTo(ANONYMOUS)).toHaveLength(1);
    expect(useAuthStore.getState().userType).toBe("ANONYMOUS");
    expect(screen.getByLabelText(t.ConfirmPassword)).toBeTruthy();
  });

  test("PAGE-REGISTER-02 确认密码只在前端,不进请求体(§33)", async () => {
    render(React.createElement(RegisterPage));
    await act(settle);

    await submitRegister("alice", "Passw0rd!", "Passw0rd!");

    const sent = callsTo(REGISTER);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!.body).sort()).toEqual(["password", "username"]);
    expect(sent[0]!.body).toEqual({ username: "alice", password: "Passw0rd!" });
  });

  test("PAGE-REGISTER-03 保留提示可见,且不放找回密码入口(§35/§36)", async () => {
    render(React.createElement(RegisterPage));
    await act(settle);

    expect(screen.getByText(t.RegisterPreserveTip)).toBeTruthy();
    expect(screen.getByText(t.NoRecoveryTip)).toBeTruthy();
    expect(screen.queryByText(/^忘记密码/)).toBeNull();
    expect(screen.queryByRole("link", { name: /忘记密码/ })).toBeNull();
  });

  test("PAGE-REGISTER-04 用户名规则在客户端就挡住,不发请求(§31)", async () => {
    render(React.createElement(RegisterPage));
    await act(settle);

    await submitRegister("ab", "Passw0rd!", "Passw0rd!");
    expect(screen.getByRole("alert").textContent).toBe(t.UsernameInvalid);
    expect(callsTo(REGISTER)).toHaveLength(0);

    // 中文与空格同样在本地被拒(后端只认 ASCII 三类字符)
    await submitRegister("张三 名字", "Passw0rd!", "Passw0rd!");
    expect(callsTo(REGISTER)).toHaveLength(0);
  });

  test("PAGE-REGISTER-05 口令只校验长度,不强制复杂度(§32)", async () => {
    render(React.createElement(RegisterPage));
    await act(settle);

    await submitRegister("alice", "short", "short");
    expect(screen.getByRole("alert").textContent).toBe(t.PasswordTooShort);
    expect(callsTo(REGISTER)).toHaveLength(0);

    // 120 位纯小写字母合法:不该被本地复杂度规则拦下
    const long = "a".repeat(120);
    await submitRegister("alice", long, long);
    expect(callsTo(REGISTER)).toHaveLength(1);
  });

  test("PAGE-REGISTER-06 两次密码不一致 → 本地报错,不发请求(§33)", async () => {
    render(React.createElement(RegisterPage));
    await act(settle);

    await submitRegister("alice", "Passw0rd!", "Passw0rd?");

    expect(screen.getByRole("alert").textContent).toBe(t.PasswordMismatch);
    expect(callsTo(REGISTER)).toHaveLength(0);
  });

  test("PAGE-REGISTER-07 已是注册用户:不再建匿名、不给提交口(§29)", async () => {
    asRegistered("alice");
    render(React.createElement(RegisterPage));
    await act(settle);

    expect(callsTo(ANONYMOUS)).toHaveLength(0);
    expect(screen.getByText(t.AlreadyRegistered("alice"))).toBeTruthy();
    expect(screen.queryByLabelText(t.ConfirmPassword)).toBeNull();
    expect(screen.getByRole("button", { name: t.BackToChat })).toBeTruthy();
    expect(screen.getByRole("button", { name: t.LoginOther })).toBeTruthy();
  });

  test("PAGE-REGISTER-08 注册成功后客户端回聊天,不换文档(§17)", async () => {
    await asVisitorWithChat();
    render(React.createElement(RegisterPage));
    await act(settle);

    await submitRegister("alice", "Passw0rd!", "Passw0rd!");

    expect(callsTo(REGISTER)).toHaveLength(1);
    expect(push).toHaveBeenCalledWith("/");
    expect(hardNav).not.toHaveBeenCalled();
    // 同主体原地升级:正在看的聊天没被抹掉
    expect(topics()).toEqual([ANON_MARKER]);
    expect(useAuthStore.getState().username).toBe("alice");
  });

  test("PAGE-SUBMIT-01 提交中按钮 disabled,连点只发一次请求(§60/§61)", async () => {
    render(React.createElement(RegisterPage));
    await act(settle);
    // 把注册请求挂起:否则一完成就切到「已注册」分支,拿不到 pending 态
    let release: (() => void) | null = null;
    const base = route;
    route = (url, method, body) => {
      if (url === REGISTER && method === "POST") {
        return new Promise((resolve) => {
          release = () =>
            resolve(
              base(url, method, body) ?? fail(404, "NOT_FOUND"),
            );
        });
      }
      return base(url, method, body);
    };
    fill({
      [t.Username]: "alice",
      [t.Password]: "Passw0rd!",
      [t.ConfirmPassword]: "Passw0rd!",
    });
    const submitButton = () =>
      screen
        .getAllByRole("button")
        .find(
          (item) => item.getAttribute("type") === "submit",
        ) as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(submitButton());
      await tick();
    });

    expect(callsTo(REGISTER)).toHaveLength(1);
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().textContent).toBe(t.Submitting);

    await act(async () => {
      fireEvent.click(submitButton());
      await tick();
    });
    expect(callsTo(REGISTER)).toHaveLength(1);

    await act(async () => {
      (release as unknown as () => void)();
      await settle();
    });

    expect(callsTo(REGISTER)).toHaveLength(1);
    expect(useAuthStore.getState().username).toBe("alice");
  });
});

describe("Settings 账号区(V1.4 U4 §79)", () => {
  test("UI-ANON-01 访客看到登录与注册两个入口(§38)", async () => {
    useAuthStore.setState({
      status: "authenticated",
      userType: "ANONYMOUS",
      expiresAt: STAMP,
    });
    render(React.createElement(AccountSection));
    await act(settle);

    expect(screen.getByText(t.Visitor)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.Login }));
    expect(push).toHaveBeenLastCalledWith("/login");
    fireEvent.click(screen.getByRole("button", { name: t.Register }));
    expect(push).toHaveBeenLastCalledWith("/register");
    expect(hardNav).not.toHaveBeenCalled();
  });

  test("UI-REG-01/02 注册用户看到 @username 与退出(§39)", async () => {
    asRegistered("alice");
    render(React.createElement(AccountSection));
    await act(settle);

    expect(screen.getByText(t.CurrentAccount("alice"))).toBeTruthy();
    expect(screen.getByRole("button", { name: t.Logout })).toBeTruthy();
  });

  test("UI-REG-03 修改密码在次级面板,默认不展开(§39/§41)", async () => {
    asRegistered("alice");
    render(React.createElement(AccountSection));
    await act(settle);

    expect(screen.queryByLabelText(t.NewPassword)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t.ChangePassword }));
    await act(settle);

    expect(screen.getByLabelText(t.CurrentPassword)).toBeTruthy();
    const next = screen.getByLabelText(t.NewPassword) as HTMLInputElement;
    expect(next.getAttribute("name")).toBe("new-password");
    expect(next.getAttribute("autocomplete")).toBe("new-password");
    expect(next.type).toBe("password");
  });

  test("UI-REG-04 退出所有设备在次级账号区,不混进访客入口(§39)", async () => {
    asRegistered("alice");
    render(React.createElement(AccountSection));
    await act(settle);

    expect(screen.getByRole("button", { name: t.ChangePassword })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: t.RevokeAllDevices }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.Login })).toBeNull();
  });

  test("UI-ADMIN-01 管理员账号区不伪装成注册用户(§40)", async () => {
    backendType = "ADMIN";
    useAuthStore.setState({
      status: "authenticated",
      userType: "ADMIN",
      username: null,
      expiresAt: STAMP,
    });
    render(React.createElement(AccountSection));
    await act(settle);

    expect(screen.getByText(t.Admin)).toBeTruthy();
    expect(screen.queryByText(/^当前已登录为/)).toBeNull();
    expect(screen.queryByRole("button", { name: t.Logout })).toBeNull();
    expect(screen.queryByRole("button", { name: t.Login })).toBeNull();
    expect(screen.queryByRole("button", { name: t.Register })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: t.AdminConsole }));
    expect(hardAssign).toHaveBeenCalledWith("/admin");
  });

  test("AUTH-PWD-05 改密失败:错误留在表单,不跳转也不关面板(§76)", async () => {
    asRegistered("alice");
    render(React.createElement(AccountSection));
    await act(settle);
    fireEvent.click(screen.getByRole("button", { name: t.ChangePassword }));
    await act(settle);
    credentialFailure = () => fail(401, "AUTH_INVALID_CREDENTIALS");

    fireEvent.change(screen.getByLabelText(t.CurrentPassword), {
      target: { value: "Passw0rd!" },
    });
    fireEvent.change(screen.getByLabelText(t.NewPassword), {
      target: { value: "Rotated123!" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: t.SubmitChange }),
      );
      await settle();
    });

    expect(screen.getByRole("alert").textContent).toBe(
      t.Error.AUTH_INVALID_CREDENTIALS,
    );
    expect(screen.getByLabelText(t.NewPassword)).toBeTruthy();
    expect(hardNav).not.toHaveBeenCalled();
    expect(callsTo(LOGOUT)).toHaveLength(0);
    expect(topics()).toEqual([]);
  });

  test("AUTH-LOGOUT-03 退出后聊天整体清空并换文档(§44/§45)", async () => {
    asRegistered("alice");
    await act(async () => {
      await useChatStore.getState().bootstrap();
      await settle();
    });
    useChatStore.getState().setLastInput("退出前正在写的字");
    expect(topics()).toEqual([REG_MARKER]);
    render(React.createElement(AccountSection));
    await act(settle);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.Logout }));
      await settle();
    });

    expect(callsTo(LOGOUT)).toHaveLength(1);
    expect(topics()).toEqual([]);
    expect(useChatStore.getState().lastInput).toBe("");
    expect(useAuthStore.getState().username).toBeNull();
    expect(hardNav).toHaveBeenCalledWith("/");
  });

  test("AUTH-REV-04/05 全设备退出:确认框可取消,确认后清聊天并换文档(§43)", async () => {
    asRegistered("alice");
    await act(async () => {
      await useChatStore.getState().bootstrap();
      await settle();
    });
    useChatStore.getState().setLastInput("退出所有设备前写的字");
    render(React.createElement(AccountSection));
    await act(settle);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: t.RevokeAllDevices }),
      );
      await settle();
    });
    // 取消:一个撤销请求都不该发,也不换文档
    clickDialogButton(Locale.UI.Cancel);
    await act(settle);
    expect(callsTo(REVOKE_ALL)).toHaveLength(0);
    expect(hardNav).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: t.RevokeAllDevices }),
      );
      await settle();
    });
    clickDialogButton(Locale.UI.Confirm);
    await act(settle);

    expect(callsTo(REVOKE_ALL)).toHaveLength(1);
    expect(topics()).toEqual([]);
    expect(useChatStore.getState().lastInput).toBe("");
    expect(useAuthStore.getState().status).toBe("unknown");
    expect(hardNav).toHaveBeenCalledWith("/");
  });
});
