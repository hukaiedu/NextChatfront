import { readFileSync } from "node:fs";

import { jest } from "@jest/globals";

import {
  bootstrapAnonymous,
  changePassword,
  getAuthSession,
  login,
  registerUser,
  revokeAllSessions,
  userLogin,
} from "../app/client/backend-api";

/**
 * V1.4 U4 §72:Auth API Client 矩阵 API-AUTH-01..07 + §93 的端点静态守卫。
 *
 * 与 C-AUTH 系列同一套路:不 mock API client 本身,从最外层伪造 fetch,
 * 断言「真实 path + 真实 body 键 + 真实返回形状」。
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

interface RecordedCall {
  url: string;
  method: string;
  rawBody?: string;
  body?: any;
}

const calls: RecordedCall[] = [];

function reply(status: number, data?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => (data === undefined ? null : { data }),
  };
}

type MockRoute = (url: string, method: string) => any;
let route: MockRoute = () => undefined;

function callsTo(url: string, method = "POST") {
  return calls.filter((c) => c.method === method && c.url === url);
}

function registeredDto(username: string | null) {
  return {
    authenticated: true,
    expiresAt: STAMP,
    userType: "REGISTERED",
    ...(username === null ? {} : { username }),
  };
}

beforeEach(() => {
  calls.length = 0;
  route = () => undefined;
  (globalThis as any).fetch = jest.fn(
    async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      const method = String(init.method ?? "GET").toUpperCase();
      const rawBody = typeof init.body === "string" ? init.body : undefined;
      calls.push({
        url,
        method,
        rawBody,
        body: rawBody === undefined ? undefined : JSON.parse(rawBody),
      });
      return route(url, method) ?? reply(404);
    },
  );
});

describe("U4 Auth API Client", () => {
  test("API-AUTH-01 Registered 认证面精确四键,client 不自造字段", async () => {
    route = (url) =>
      url === SESSION ? reply(200, registeredDto("alice")) : undefined;

    const session = await getAuthSession();

    expect(Object.keys(session).sort()).toEqual([
      "authenticated",
      "expiresAt",
      "userType",
      "username",
    ]);
    expect(session).toEqual({
      authenticated: true,
      expiresAt: STAMP,
      userType: "REGISTERED",
      username: "alice",
    });
  });

  test("API-AUTH-02 旧后端不返回 username → 归一成 null,不抛不崩(§7)", async () => {
    const legacy = registeredDto("bob");
    delete (legacy as { username?: string }).username;
    route = (url) => (url === SESSION ? reply(200, legacy) : undefined);

    const session = await getAuthSession();

    expect(session.authenticated).toBe(true);
    expect("username" in session).toBe(true);
    expect(session.username).toBeNull();
    // 匿名 / 管理员同样走同一条归一路径
    route = (url) =>
      url === ANONYMOUS
        ? reply(200, { authenticated: true, expiresAt: STAMP, userType: "ANONYMOUS" })
        : undefined;
    expect((await bootstrapAnonymous()).username).toBeNull();
  });

  test("API-AUTH-03 注册:POST /auth/register,body 恰好 username + password(§9)", async () => {
    route = (url) =>
      url === REGISTER ? reply(200, registeredDto("alice")) : undefined;

    await registerUser("alice", "Passw0rd!");

    const sent = callsTo(REGISTER);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(REGISTER);
    expect(Object.keys(sent[0]!.body).sort()).toEqual(["password", "username"]);
    expect(sent[0]!.body).toEqual({ username: "alice", password: "Passw0rd!" });
  });

  test("API-AUTH-04 普通登录只打 /auth/user/login,绝不打 Admin 的 /auth/login(§10)", async () => {
    route = (url) =>
      url === USER_LOGIN ? reply(200, registeredDto("alice")) : undefined;

    await userLogin("alice", "Passw0rd!");

    expect(callsTo(USER_LOGIN)).toHaveLength(1);
    expect(callsTo(ADMIN_LOGIN)).toHaveLength(0);
    // Admin 侧反向:login() 只会打 Admin 端点,且 body 没有 username
    route = (url) =>
      url === ADMIN_LOGIN ? reply(200, { authenticated: true, expiresAt: STAMP, userType: "ADMIN" }) : undefined;
    await login("admin-secret");
    expect(callsTo(ADMIN_LOGIN)).toHaveLength(1);
    expect(callsTo(USER_LOGIN)).toHaveLength(1);
    expect(callsTo(ADMIN_LOGIN)[0]!.body).toEqual({ password: "admin-secret" });
  });

  test("API-AUTH-05 改密:POST /auth/password/change,body 恰好 currentPassword + newPassword(§11)", async () => {
    route = (url) =>
      url === PASSWORD_CHANGE ? reply(200, registeredDto("alice")) : undefined;

    await changePassword("Passw0rd!", "Rotated123!");

    const sent = callsTo(PASSWORD_CHANGE);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!.body).sort()).toEqual([
      "currentPassword",
      "newPassword",
    ]);
  });

  test("API-AUTH-06 全设备退出:只打普通 /auth/sessions/revoke-all,复用 callBackend 解包(§12)", async () => {
    route = (url) =>
      url === REVOKE_ALL ? reply(200, { revoked: 3 }) : undefined;

    await expect(revokeAllSessions()).resolves.toEqual({ revoked: 3 });

    expect(callsTo(REVOKE_ALL)).toHaveLength(1);
    expect(callsTo(ADMIN_REVOKE_ALL)).toHaveLength(0);
    // 不自己解 envelope:请求体不存在,返回值已是 data 层
    expect(callsTo(REVOKE_ALL)[0]!.rawBody).toBeUndefined();
  });

  test("API-AUTH-07 confirmPassword 永远不进请求体(§33)", async () => {
    route = (url) =>
      url === REGISTER ? reply(200, registeredDto("alice")) : undefined;

    await registerUser("alice", "Passw0rd!");

    const raw = callsTo(REGISTER)[0]!.rawBody!;
    expect(raw).not.toContain("confirm");
    expect(raw).not.toContain("Confirm");
    expect(raw).not.toContain("userId");
  });

  test("API-GUARD-01 端点字符串静态守卫:普通登录与 Admin 登录永不混用(§93)", () => {
    const source = readFileSync("app/client/backend-api.ts", "utf8");
    const bodyOf = (name: string) => {
      const marker = `export function ${name}(`;
      const start = source.indexOf(marker);
      expect(start).toBeGreaterThanOrEqual(0);
      const rest = source.slice(start + marker.length);
      const end = rest.indexOf("\nexport ");
      return end === -1 ? rest : rest.slice(0, end);
    };

    expect(bodyOf("userLogin")).toContain('"/auth/user/login"');
    expect(bodyOf("userLogin")).not.toContain('callBackend<AuthSessionInfo>("/auth/login"');
    expect(bodyOf("login")).toContain('"/auth/login"');
    expect(bodyOf("login")).not.toContain("/auth/user/login");
    expect(bodyOf("registerUser")).toContain('"/auth/register"');
    expect(bodyOf("changePassword")).toContain('"/auth/password/change"');
    expect(bodyOf("revokeAllSessions")).toContain('"/auth/sessions/revoke-all"');
    expect(bodyOf("revokeAllSessions")).not.toContain("/admin/");
  });
});
