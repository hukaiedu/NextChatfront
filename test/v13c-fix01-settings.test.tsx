import { readFileSync } from "node:fs";
import { describe, expect, test } from "@jest/globals";

/**
 * V1.3-C Review FIX-01C(原任务 UI-07):运维信息只允许存在于 /admin 控制台,
 * 普通用户的设置页与聊天 UI 一律不得引用。
 *
 * 判据取真实词条与真实模块引用,而不是手写中文串:Locale.Browser.*(浏览器运维面板)、
 * Locale.AdminConsole.Provider.*(Provider 运维面板)、admin-api / store/browser 这两个
 * 只装运维字段的模块。同时在 /admin 侧做锚定断言,证明这是「挪进 Admin」而不是「删功能」。
 *
 * 说明:Settings 组件本身在本仓从未有过 jsdom 渲染先例(上游 persist store 在测试环境
 * 里水合时序不定),真机 DOM 扫描见 docs/V13C_REVIEW_FIX01_REPORT.md 的 FIX-01C 一节。
 */

const OPS_TOKENS = [
  "Locale.Browser",
  "Locale.AdminConsole.Provider",
  "AdminBrowserPanel",
  "AdminProviderSection",
  "../client/admin-api",
  "../store/browser",
  "./admin-api",
  "./store/browser",
];

/** 后端运维字段名:普通 UI 连字符串都不该出现 */
const RAW_FIELDS = [
  "Browser Status",
  "Restart Browser",
  "Provider Status",
  "Open Provider",
  "Restart Provider",
  "profileDir",
  "providerLoggedIn",
  "browserType",
  "headless",
  "browser-profile",
  "GEMINI_WEB",
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
    // 锚定:运维请求确实存在,但只集中在 admin 客户端
    expect(adminClient).toContain("/admin/browser/status");
    expect(adminClient).toContain("/admin/provider/status");
    expect(adminClient).toContain("/admin/provider/open");
    expect(adminClient).toContain("/admin/provider/restart");
    expect(adminClient).toContain("/admin/sessions/revoke-all");
  });

  test("SETTINGS-03 运维面板只被 /admin 页面挂载", () => {
    const adminPage = read("app/admin/page.tsx");
    expect(adminPage).toContain('from "../components/browser-status"');
    expect(adminPage).toContain("<AdminProviderSection");

    for (const file of PUBLIC_SOURCES) {
      expect([file, /from "\.\.\/components\/browser-status"/.test(read(file))]).toEqual([
        file,
        false,
      ]);
    }
  });
});
