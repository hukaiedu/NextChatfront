import { readFileSync } from "node:fs";
import { describe, expect, test } from "@jest/globals";

/**
 * V1.3-C Review FIX-01C(原任务 UI-07):运维信息只允许存在于 /admin 控制台,
 * 普通用户的设置页与聊天 UI 一律不得引用。
 *
 * 本轮后端已移除浏览器运行时:判据改为 Provider / Python Worker 运维面板,
 * 并额外断言退役端点(`/admin/browser/*`、`/admin/provider/open`)在前端零引用。
 */

const OPS_TOKENS = [
  "Locale.AdminConsole.Provider",
  "AdminProviderSection",
  "../client/admin-api",
  "./admin-api",
];

/** 后端运维字段名:普通 UI 连字符串都不该出现 */
const RAW_FIELDS = [
  "Provider Status",
  "Open Provider",
  "Restart Provider",
  "profileDir",
  "providerLoggedIn",
  "browserType",
  "browser-profile",
  "GEMINI_WEB",
  "admin/browser",
  "provider/open",
];

const PUBLIC_SOURCES = [
  "app/components/settings.tsx",
  "app/components/chat.tsx",
  "app/components/chat-list.tsx",
  "app/components/model-selector.tsx",
  "app/components/new-chat.tsx",
  "app/store/chat.ts",
];

function read(file: string): string {
  return readFileSync(file, "utf8");
}

describe("FIX-01C:运维信息只在 Admin 面", () => {
  test("SETTINGS-01 普通 UI 源码不引用运维词条、运维模块与后端字段名", () => {
    for (const file of PUBLIC_SOURCES) {
      const source = read(file);
      for (const token of OPS_TOKENS) {
        expect([file, token, source.includes(token)]).toEqual([
          file,
          token,
          false,
        ]);
      }
      for (const field of RAW_FIELDS) {
        expect([file, field, source.includes(field)]).toEqual([
          file,
          field,
          false,
        ]);
      }
    }
  });

  test("SETTINGS-02 运维请求只从 admin 客户端发出,普通链路只碰 Public 面", () => {
    const publicClient = read("app/client/backend-api.ts");
    const chatStore = read("app/store/chat.ts");
    const adminClient = read("app/client/admin-api.ts");

    for (const source of [publicClient, chatStore]) {
      expect(source.includes("/admin/browser/")).toBe(false);
      expect(source.includes("/admin/provider/")).toBe(false);
      expect(source.includes("/admin/sessions/")).toBe(false);
    }
    // 锚定:Provider / Python Worker 运维请求确实存在,但只集中在 admin 客户端
    expect(adminClient).toContain("/admin/provider/status");
    expect(adminClient).toContain("/admin/provider/check");
    expect(adminClient).toContain("/admin/provider/restart");
    expect(adminClient).toContain("/admin/sessions/revoke-all");
    // 退役端点必须彻底消失
    expect(adminClient.includes("/admin/browser/")).toBe(false);
    expect(adminClient.includes("/admin/provider/open")).toBe(false);
  });

  test("SETTINGS-03 运维面板只被 /admin 页面挂载,浏览器面板已删除", () => {
    const adminPage = read("app/admin/page.tsx");
    expect(adminPage).toContain("<AdminProviderSection");
    expect(adminPage.includes("components/browser-status")).toBe(false);

    for (const file of PUBLIC_SOURCES) {
      expect([
        file,
        /from "\.\.\/components\/browser-status"/.test(read(file)),
      ]).toEqual([file, false]);
    }
  });

  test("SETTINGS-04 /admin 不引用任何退役的浏览器运行时端点", () => {
    const adminPage = read("app/admin/page.tsx");
    const adminClient = read("app/client/admin-api.ts");

    for (const source of [adminPage, adminClient]) {
      expect(source.includes("/admin/browser/")).toBe(false);
      expect(source.includes("/admin/provider/open")).toBe(false);
      expect(source.includes("AdminBrowserPanel")).toBe(false);
      expect(source.includes("useBrowserStore")).toBe(false);
    }
  });
});
