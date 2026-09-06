import { create } from "zustand";
import {
  BackendApiError,
  BackendBrowserStatus,
  getBrowserStatus,
  restartBrowser,
} from "../client/backend-api";
import { backendErrorMessage } from "./chat";
// 必须在 ./chat 之后:locales -> utils -> store/index 会回指本模块,先求值 chat 才能拿到初始化完成的 Locale
import Locale from "../locales";

/** 面板可见期间的轮询间隔:状态是服务端事实,不做本地缓存持久化 */
export const BROWSER_POLL_INTERVAL_MS = 15000;

export type BrowserFetchState = "idle" | "loading" | "ready" | "error";

interface BrowserState {
  /** 最近一次成功拉到的快照;拉取失败时仍保留,UI 按 stale 显示 */
  status: BackendBrowserStatus | null;
  fetchState: BrowserFetchState;
  /** 拉取失败的后端错误码,连不上后端时为 NETWORK_ERROR */
  fetchErrorCode: string | null;
  /** 失败时的 HTTP 状态码;NETWORK_ERROR + 404 = 后端尚未实现该接口 */
  fetchErrorStatus: number | null;
  /** 最近一次响应(成功或失败)到达本地的时刻 */
  fetchedAt: number | null;
  restarting: boolean;
}

interface BrowserActions {
  /** 已在途时合并请求;ready 且非 force 时直接返回缓存 */
  refresh(force?: boolean): Promise<void>;
  /** 重启服务端浏览器;errorText 已按后端错误码本地化 */
  restart(): Promise<{ ok: boolean; errorText: string | null }>;
  reset(): void;
}

export type BrowserStore = BrowserState & BrowserActions;

const DEFAULT_BROWSER_STATE: BrowserState = {
  status: null,
  fetchState: "idle",
  fetchErrorCode: null,
  fetchErrorStatus: null,
  fetchedAt: null,
  restarting: false,
};

let inflight: Promise<void> | null = null;

function errorInfo(error: unknown): { code: string; status: number | null } {
  return error instanceof BackendApiError
    ? { code: error.code, status: error.status }
    : { code: "NETWORK_ERROR", status: null };
}

/**
 * 后端还没有 /browser/* 时命中 Express 的 HTML 404,与「连不上后端」是两回事:
 * 前者提示升级后端,后者提示网络/服务问题。
 */
export function isUnsupportedBrowserApi(
  code: string | null,
  httpStatus: number | null,
): boolean {
  return code === "NETWORK_ERROR" && httpStatus === 404;
}

export const useBrowserStore = create<BrowserStore>()((set, get) => {
  async function doRefresh(): Promise<void> {
    set({ fetchState: "loading" });
    try {
      const status = await getBrowserStatus();
      set({
        status,
        fetchState: "ready",
        fetchErrorCode: null,
        fetchErrorStatus: null,
        fetchedAt: Date.now(),
      });
    } catch (error) {
      console.error("[Browser] 状态加载失败", error);
      const info = errorInfo(error);
      set({
        fetchState: "error",
        fetchErrorCode: info.code,
        fetchErrorStatus: info.status,
        fetchedAt: Date.now(),
      });
    }
  }

  return {
    ...DEFAULT_BROWSER_STATE,

    async refresh(force?: boolean) {
      if (inflight) return inflight;
      if (!force && get().fetchState === "ready") return;
      inflight = doRefresh().finally(() => {
        inflight = null;
      });
      return inflight;
    },

    async restart() {
      if (get().restarting) {
        return { ok: false, errorText: null };
      }
      set({ restarting: true });
      try {
        const status = await restartBrowser();
        set({
          status,
          fetchState: "ready",
          fetchErrorCode: null,
          fetchErrorStatus: null,
          fetchedAt: Date.now(),
        });
        return { ok: true, errorText: null };
      } catch (error) {
        console.error("[Browser] 重启失败", error);
        const info = errorInfo(error);
        set({
          fetchState: "idle",
          fetchErrorCode: info.code,
          fetchErrorStatus: info.status,
        });
        // 后端可能已经部分重启成功,立刻回读一次真实状态
        void get().refresh(true);
        return {
          ok: false,
          errorText: isUnsupportedBrowserApi(info.code, info.status)
            ? Locale.Browser.Unsupported
            : backendErrorMessage(error),
        };
      } finally {
        set({ restarting: false });
      }
    },

    reset() {
      inflight = null;
      set(DEFAULT_BROWSER_STATE);
    },
  };
});

let refCount = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function onTick() {
  // 页面隐藏时跳过这一轮但不停表,切回前台即可拿到新状态
  if (typeof document !== "undefined" && document.hidden) return;
  void useBrowserStore.getState().refresh(true);
}

/**
 * 多个展示位(聊天头部按钮 + 设置页面板)共享一个轮询定时器。
 * 返回释放函数,最后一个使用者卸载后停表;重复调用安全。
 */
export function retainBrowserStatusPolling(): () => void {
  refCount += 1;
  if (!timer) timer = setInterval(onTick, BROWSER_POLL_INTERVAL_MS);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    refCount -= 1;
    if (refCount <= 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** 供测试与「退出登录 / 重置」路径使用:立即停表并清空缓存 */
export function stopBrowserStatusPolling() {
  refCount = 0;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  useBrowserStore.getState().reset();
}
