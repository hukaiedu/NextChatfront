import { jest } from "@jest/globals";
// 先导入 browser store:组件经 store/index 形成循环依赖,先完成 store 求值可避免 Locale 未初始化
import {
  retainBrowserStatusPolling,
  stopBrowserStatusPolling,
  useBrowserStore,
} from "../app/store/browser";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  BrowserStatusButton,
  BrowserStatusSection,
  browserErrorText,
  browserStateView,
  browserStatusRows,
  formatUptime,
} from "../app/components/browser-status";
import { errorTextForCode } from "../app/store/chat";
import Locale from "../app/locales";
import type { BackendBrowserStatus } from "../app/client/backend-api";

/**
 * 浏览器状态面板验收:状态只来自后端 GET /browser/status,重启走
 * POST /browser/restart,多个展示位(设置页 + 聊天头部)共享一个轮询定时器。
 * 套路与其它 backend-* 测试相同:不 mock API Client,从最外层伪造 HTTP。
 */

const STARTED_AT = "2026-09-06T06:20:00.000Z";
const EMPTY = Locale.Browser.Empty;

function status(
  overrides: Partial<BackendBrowserStatus> = {},
): BackendBrowserStatus {
  return {
    state: "RUNNING",
    browserType: "chromium",
    headless: true,
    profileDir: "data/browser-profile",
    startedAt: STARTED_AT,
    uptimeMs: 3 * 3600_000 + 12 * 60_000,
    providerLoggedIn: true,
    activeRequests: 0,
    lastError: null,
    observedAt: STARTED_AT,
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  method: string;
}

const calls: RecordedCall[] = [];
const server = {
  status: status(),
  failStatus: false,
  failRestart: false as false | string,
  restartResult: status(),
  /** true = 后端还没实现这两个路由(Express 返回无 JSON 体的 404) */
  notImplemented: false,
};

function reply(httpStatus: number, data?: unknown) {
  return {
    ok: httpStatus >= 200 && httpStatus < 300,
    status: httpStatus,
    json: async () => data ?? null,
  };
}

function fail(httpStatus: number, code: string, message: string) {
  return reply(httpStatus, { error: { code, message, requestId: "r" } });
}

function route(url: string, method: string): any {
  if (url === "/backend-api/browser/status" && method === "GET") {
    if (server.notImplemented) return reply(404);
    if (server.failStatus) {
      return fail(503, "BROWSER_NOT_RUNNING", "browser is not running");
    }
    return reply(200, { data: server.status });
  }
  if (url === "/backend-api/browser/restart" && method === "POST") {
    if (server.notImplemented) return reply(404);
    if (server.failRestart) {
      return fail(409, server.failRestart, "restart rejected");
    }
    server.status = server.restartResult;
    return reply(200, { data: server.status });
  }
  return fail(404, "NOT_FOUND", `未预期的请求 ${method} ${url}`);
}

function statusCalls(): RecordedCall[] {
  return calls.filter((c) => c.url === "/backend-api/browser/status");
}

function restartCalls(): RecordedCall[] {
  return calls.filter((c) => c.url === "/backend-api/browser/restart");
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  server.status = status();
  server.failStatus = false;
  server.failRestart = false;
  server.restartResult = status();
  server.notImplemented = false;
  calls.length = 0;
  stopBrowserStatusPolling();
  (globalThis as any).fetch = jest.fn(
    async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      const method = String(init.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      return route(url, method);
    },
  );
});

afterEach(() => {
  stopBrowserStatusPolling();
  jest.useRealTimers();
});

describe("浏览器状态拉取", () => {
  test("B-01 refresh 拉取 GET /browser/status 并写入 store", async () => {
    await useBrowserStore.getState().refresh();

    expect(statusCalls()).toHaveLength(1);
    const state = useBrowserStore.getState();
    expect(state.fetchState).toBe("ready");
    expect(state.fetchErrorCode).toBeNull();
    expect(state.status?.state).toBe("RUNNING");
    expect(state.status?.profileDir).toBe("data/browser-profile");
  });

  test("B-02 ready 后非 force 不重复请求;并发请求合并成一次", async () => {
    await useBrowserStore.getState().refresh();
    await useBrowserStore.getState().refresh();
    expect(statusCalls()).toHaveLength(1);

    await Promise.all([
      useBrowserStore.getState().refresh(true),
      useBrowserStore.getState().refresh(true),
    ]);
    expect(statusCalls()).toHaveLength(2);
  });

  test("B-03 拉取失败进入 error 态但保留上次快照,便于按 stale 展示", async () => {
    await useBrowserStore.getState().refresh();
    server.failStatus = true;
    await useBrowserStore.getState().refresh(true);

    const state = useBrowserStore.getState();
    expect(state.fetchState).toBe("error");
    expect(state.fetchErrorCode).toBe("BROWSER_NOT_RUNNING");
    expect(state.status).not.toBeNull();
  });

  test("B-04 后端字段缺失时逐行降级为占位符而不是整块报错", async () => {
    server.status = { state: "STARTING" } as BackendBrowserStatus;
    await useBrowserStore.getState().refresh();

    const rows = browserStatusRows(useBrowserStore.getState().status, null);
    expect(rows.map((row) => row.value)).toEqual([
      EMPTY,
      EMPTY,
      EMPTY,
      EMPTY,
      Locale.Browser.LoggedIn.Unknown,
      EMPTY,
      EMPTY,
      EMPTY,
    ]);
    expect(browserStateView(status({ state: "STARTING" })).label).toBe(
      Locale.Browser.State.STARTING,
    );
  });

  test("B-05 未拉到快照前按 UNKNOWN 渲染", () => {
    const view = browserStateView(null);
    expect(view.label).toBe(Locale.Browser.State.UNKNOWN);
    expect(view.hint).toBe(Locale.Browser.Hint.UNKNOWN);
  });

  test("B-05a 后端未实现该接口时记录 NETWORK_ERROR + HTTP 404", async () => {
    server.notImplemented = true;
    await useBrowserStore.getState().refresh();

    const state = useBrowserStore.getState();
    expect(state.fetchState).toBe("error");
    expect(state.fetchErrorCode).toBe("NETWORK_ERROR");
    expect(state.fetchErrorStatus).toBe(404);
  });

  test("B-05b 提示区分「后端未提供接口」「连不上后端」「后端报错」", () => {
    expect(browserErrorText(null, null)).toBeNull();
    expect(browserErrorText("NETWORK_ERROR", 404)).toBe(
      Locale.Browser.Unsupported,
    );
    expect(browserErrorText("NETWORK_ERROR", null)).toBe(
      `${Locale.Browser.FetchFailed} · ${errorTextForCode("NETWORK_ERROR")}`,
    );
    expect(browserErrorText("BROWSER_NOT_RUNNING", 503)).toContain(
      errorTextForCode("BROWSER_NOT_RUNNING"),
    );
  });
});

describe("浏览器重启", () => {
  test("B-06 restart 走 POST /browser/restart 并以后端返回的快照为准", async () => {
    server.restartResult = status({ uptimeMs: 2000 });
    await useBrowserStore.getState().refresh();

    const result = await useBrowserStore.getState().restart();

    expect(restartCalls()).toHaveLength(1);
    expect(result.ok).toBe(true);
    expect(result.errorText).toBeNull();
    expect(useBrowserStore.getState().status?.uptimeMs).toBe(2000);
    expect(useBrowserStore.getState().restarting).toBe(false);
  });

  test("B-07 后端拒绝重启时返回中文错误并回读真实状态", async () => {
    server.failRestart = "BROWSER_RESTART_CONFLICT";
    const result = await useBrowserStore.getState().restart();
    await tick();

    expect(result.ok).toBe(false);
    expect(result.errorText).toBe(errorTextForCode("BROWSER_RESTART_CONFLICT"));
    // 失败后立刻回读一次:回读成功即清除错误码,面板回到真实状态
    expect(statusCalls()).toHaveLength(1);
    const state = useBrowserStore.getState();
    expect(state.fetchState).toBe("ready");
    expect(state.fetchErrorCode).toBeNull();
    expect(state.restarting).toBe(false);
  });

  test("B-07a 后端未实现重启接口时提示升级后端,而不是「连不上后端」", async () => {
    server.notImplemented = true;
    const result = await useBrowserStore.getState().restart();
    await tick();

    expect(result.ok).toBe(false);
    expect(result.errorText).toBe(Locale.Browser.Unsupported);
    expect(result.errorText).not.toBe(errorTextForCode("NETWORK_ERROR"));
    expect(statusCalls()).toHaveLength(1);
  });

  test("B-08 重启在途时重复触发只发一次请求", async () => {
    const first = useBrowserStore.getState().restart();
    const second = useBrowserStore.getState().restart();
    const results = await Promise.all([first, second]);

    expect(restartCalls()).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
  });

  test("B-09 浏览器错误码有中文映射,未知错误码回退原文", () => {
    expect(errorTextForCode("BROWSER_RESTART_CONFLICT")).toContain("重启");
    expect(errorTextForCode("BROWSER_NOT_RUNNING")).toContain("浏览器");
    expect(errorTextForCode("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});

describe("轮询共享", () => {
  test("B-10 多个展示位共享一个定时器,全部释放后停止", async () => {
    jest.useFakeTimers();
    const first = retainBrowserStatusPolling();
    const second = retainBrowserStatusPolling();

    await jest.advanceTimersByTimeAsync(15000);
    expect(statusCalls()).toHaveLength(1);

    first();
    await jest.advanceTimersByTimeAsync(15000);
    expect(statusCalls()).toHaveLength(2);

    second();
    await jest.advanceTimersByTimeAsync(45000);
    expect(statusCalls()).toHaveLength(2);
  });

  test("B-11 页面隐藏时跳过轮询但不停表", async () => {
    jest.useFakeTimers();
    const release = retainBrowserStatusPolling();
    const hidden = jest.spyOn(document, "hidden", "get").mockReturnValue(true);

    await jest.advanceTimersByTimeAsync(15000);
    expect(statusCalls()).toHaveLength(0);

    hidden.mockRestore();
    await jest.advanceTimersByTimeAsync(15000);
    expect(statusCalls()).toHaveLength(1);
    release();
  });
});

describe("展示位渲染", () => {
  test("B-12 设置页面板展示状态、关键字段与重启入口", async () => {
    render(<BrowserStatusSection />);
    await act(async () => {
      await tick();
    });

    expect(screen.getByText(Locale.Browser.Title)).toBeTruthy();
    expect(screen.getByText(Locale.Browser.State.RUNNING)).toBeTruthy();
    expect(screen.getByText(Locale.Browser.Fields.Profile)).toBeTruthy();
    expect(screen.getByText("data/browser-profile")).toBeTruthy();
    expect(screen.getByText(Locale.Browser.LoggedIn.Yes)).toBeTruthy();
    // 行标题 + 按钮文案各一处
    expect(screen.getAllByText(Locale.Browser.Actions.Restart)).toHaveLength(2);
  });

  test("B-12a 后端未实现接口时面板给出升级指引而非网络错误", async () => {
    server.notImplemented = true;
    render(<BrowserStatusSection />);
    await act(async () => {
      await tick();
    });

    expect(screen.getByText(Locale.Browser.Unsupported)).toBeTruthy();
    // 字段级降级:面板照常渲染,缺数据的行给占位符而不是崩掉
    expect(screen.getAllByText(EMPTY).length).toBeGreaterThanOrEqual(6);
  });

  test("B-13 聊天头部胶囊展示状态标签,点击展开详情", async () => {
    render(<BrowserStatusButton />);
    await act(async () => {
      await tick();
    });

    expect(screen.getByText(Locale.Browser.State.RUNNING)).toBeTruthy();
    expect(screen.queryByText(Locale.Browser.Fields.StartedAt)).toBeNull();

    fireEvent.click(screen.getByText(Locale.Browser.State.RUNNING));
    expect(screen.getByText(Locale.Browser.Fields.StartedAt)).toBeTruthy();
    expect(screen.getByText(Locale.Browser.Actions.Refresh)).toBeTruthy();
    expect(screen.getByText(Locale.Browser.Hint.RUNNING)).toBeTruthy();
  });
});

describe("运行时长格式化", () => {
  test("B-14 按天/时/分/秒分级展示,无数据时给占位符", () => {
    expect(formatUptime(3 * 3600_000 + 12 * 60_000)).toBe("3h 12m");
    expect(formatUptime(2 * 86400_000 + 3600_000)).toBe("2d 1h");
    expect(formatUptime(65_000)).toBe("1m 5s");
    expect(formatUptime(900)).toBe("0s");
    expect(formatUptime(null, null)).toBe(EMPTY);
    expect(formatUptime(-1)).toBe(EMPTY);
  });

  test("B-15 缺 uptimeMs 时按 startedAt 与当前时间推算", () => {
    const started = new Date(Date.now() - 90 * 60_000).toISOString();
    expect(formatUptime(null, started)).toBe("1h 30m");
  });
});
