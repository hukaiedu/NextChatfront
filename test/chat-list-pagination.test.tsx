import { jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ChatSession } from "../app/store/chat";
import sidebarStyles from "../app/components/home.module.scss";

// chat-list → mask → error → store/sync → utils/sync 链会在模块求值期创建
// prompt store 并 fetch ./prompts.json,全局 fetch mock 返回的 [] 缺 en/tw/cn,
// 抛出无 catch 的 rejection 会杀掉 worker;jest.mock 工厂在本仓 ESM 配置下
// 解析失败,因此改为:先装 prompts.json 形状的 fetch 桩,再动态 import 应用模块
let useChatStore: (typeof import("../app/store/chat"))["useChatStore"];
let ChatList: (typeof import("../app/components/chat-list"))["ChatList"];
let createEmptyMask: (typeof import("../app/store/mask"))["createEmptyMask"];
let Locale: (typeof import("../app/locales"))["default"];

beforeAll(async () => {
  const prevFetch = globalThis.fetch.bind(globalThis);
  (globalThis as any).fetch = async (input: any, init?: any) => {
    if (String(input).includes("prompts.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ en: [], tw: [], cn: [] }),
      };
    }
    return prevFetch(input, init);
  };
  // jsdom 未实现 scrollIntoView,ChatItem 选中态的 useEffect 会调用
  Element.prototype.scrollIntoView = () => {};

  // chat store 必须先于组件求值:组件经 store/index 形成循环依赖,
  // 先完成 chat.ts 求值可避免 Locale 未初始化
  ({ useChatStore } = await import("../app/store/chat"));
  ({ createEmptyMask } = await import("../app/store/mask"));
  ({ ChatList } = await import("../app/components/chat-list"));
  Locale = (await import("../app/locales")).default;
});

/**
 * PAG-1 第 15 组验收(设计 §十八 + PAG-REVIEW-04/05/14 + PAG-IMPL-01)。
 *
 * ChatList 的分页触发入口是 IntersectionObserver,store 全绿但 sentinel
 * 无 observer 时生产功能完全不可用,所以必须做组件级自动化:
 * mock IO、把 store 的 loadMore/reload 换成 spy,直接驱动渲染与交互。
 * DnD 用键盘传感器模拟(space 抬起 / Escape 取消 / space 原位放下),
 * 覆盖 PAG-REVIEW-14 的「onDragEnd 先复位再 early return」。
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];

  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  targets: Element[] = [];

  constructor(
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.callback = callback;
    this.options = options;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: Element) {
    this.targets.push(target);
  }

  unobserve() {}

  disconnect() {
    this.targets = [];
  }

  takeRecords() {
    return [];
  }

  intersect(isIntersecting = true) {
    const entries = this.targets.map((target) => ({
      target,
      isIntersecting,
      intersectionRatio: isIntersecting ? 1 : 0,
      time: 0,
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRect: target.getBoundingClientRect(),
      rootBounds: null,
      isVisible: isIntersecting,
    }));
    act(() => {
      this.callback(entries as any, this as any);
    });
  }
}

function fakeSession(id: string, topic: string): ChatSession {
  return {
    id,
    topic,
    messages: [],
    stat: { tokenCount: 0, wordCount: 0, charCount: 0 },
    lastUpdate: Date.parse("2026-09-07T00:00:00.000Z"),
    mask: createEmptyMask(),
    loaded: true,
    draft: false,
  };
}

function defaultSessions(): ChatSession[] {
  return [fakeSession("s-1", "会话一"), fakeSession("s-2", "会话二")];
}

interface ListOverrides {
  sessions?: ChatSession[];
  listNextCursor?: string | null;
  loadingList?: boolean;
  loadingMoreList?: boolean;
  listReloadError?: boolean;
  listMoreError?: boolean;
}

function setupStore(overrides: ListOverrides = {}) {
  const loadMoreSpy = jest.fn(async () => {});
  const reloadSpy = jest.fn(async () => {});
  useChatStore.setState({
    sessions: defaultSessions(),
    currentSessionIndex: 0,
    ready: true,
    loadingList: false,
    listStatus: "ACTIVE",
    listNextCursor: "cursor-1",
    loadingMoreList: false,
    listReloadError: false,
    listMoreError: false,
    loadMoreConversations: loadMoreSpy,
    reloadList: reloadSpy,
    ...overrides,
  } as any);
  return { loadMoreSpy, reloadSpy };
}

function renderList() {
  // 测试环境的 css module 经 ESM interop 后生产代码里 styles["sidebar-body"]
  // 取不到字面类名;此处用完全相同的访问方式取值,保证 sentinel.closest(...)
  // 的选择器与 wrapper 类名在测试环境(以及未来环境变化时)永远对称
  const scrollContainerClass = String((sidebarStyles as any)["sidebar-body"]);
  return render(
    <MemoryRouter>
      <div className={scrollContainerClass}>
        <ChatList />
      </div>
    </MemoryRouter>,
  );
}

async function keyboardLift(handle: HTMLElement) {
  fireEvent.keyDown(handle, { keyCode: 32, key: " " });
  await act(async () => {
    await nextFrame();
    await tick();
  });
}

async function keyboardCancel() {
  fireEvent.keyDown(window, { keyCode: 27, key: "Escape" });
  await act(async () => {
    await nextFrame();
    await tick();
  });
}

async function keyboardDropInPlace() {
  fireEvent.keyDown(window, { keyCode: 32, key: " " });
  await act(async () => {
    await nextFrame();
    await tick();
  });
}

const sentinel = (container: HTMLElement) =>
  container.querySelector('[data-pagination-sentinel="true"]');

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  (globalThis as any).IntersectionObserver = FakeIntersectionObserver;
});

describe("PAG-FE-15:ChatList 无限滚动触发与三态 UI", () => {
  test("15A hasMore=true + sentinel intersect → loadMoreConversations 恰调用一次", () => {
    const { loadMoreSpy } = setupStore();
    const { container } = renderList();

    expect(sentinel(container)).not.toBeNull();
    expect(FakeIntersectionObserver.instances).toHaveLength(1);

    const observer = FakeIntersectionObserver.instances[0];
    expect(observer.targets).toHaveLength(1);

    observer.intersect();
    expect(loadMoreSpy).toHaveBeenCalledTimes(1);
  });

  test("15B hasMore=false → 不创建 observer,sentinel 不渲染", () => {
    const { loadMoreSpy } = setupStore({ listNextCursor: null });
    const { container } = renderList();

    expect(sentinel(container)).toBeNull();
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
    observerLoop: for (const observer of FakeIntersectionObserver.instances) {
      observer.intersect();
    }
    expect(loadMoreSpy).not.toHaveBeenCalled();
  });

  test("15C listMoreError=true → intersect 不自动 retry,Retry 点击恰一次", () => {
    const { loadMoreSpy } = setupStore({
      listMoreError: true,
      listNextCursor: "cursor-1",
    });
    const { container } = renderList();

    // 失败时 cursor 保留,允许人工 retry
    expect(useChatStore.getState().listNextCursor).toBe("cursor-1");
    expect(FakeIntersectionObserver.instances).toHaveLength(1);

    const observer = FakeIntersectionObserver.instances[0];
    observer.intersect();
    expect(loadMoreSpy).not.toHaveBeenCalled();

    const status = container.querySelector('[data-pagination-status="more-error"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain(Locale.Home.LoadMoreError);

    const retry = container.querySelector('[data-pagination-retry="more"]');
    expect(retry).not.toBeNull();
    fireEvent.click(retry!);
    expect(loadMoreSpy).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().listNextCursor).toBe("cursor-1");

    // retry 后若仍失败,后续 intersect 依旧不得自动重试
    observer.intersect();
    expect(loadMoreSpy).toHaveBeenCalledTimes(1);
  });

  test("15D 拖拽期间 intersect 不 loadMore;取消/原位放下后恢复(PAG-REVIEW-14)", async () => {
    const { loadMoreSpy } = setupStore();
    const { container } = renderList();
    const observer = FakeIntersectionObserver.instances[0];

    const handle = screen.getByText("会话一").closest(
      '[role="button"]',
    ) as HTMLElement;
    expect(handle).not.toBeNull();

    // 抬起 → isDragging=true → intersect 被闸门拦下
    await keyboardLift(handle);
    observer.intersect();
    expect(loadMoreSpy).not.toHaveBeenCalled();

    // Escape 取消(destination=null 也会 early return)→ isDragging 必须先复位
    await keyboardCancel();
    observer.intersect();
    expect(loadMoreSpy).toHaveBeenCalledTimes(1);

    // 原位放下(source === destination 同样 early return)→ 仍要复位
    await keyboardLift(handle);
    observer.intersect();
    expect(loadMoreSpy).toHaveBeenCalledTimes(1);

    await keyboardDropInPlace();
    observer.intersect();
    expect(loadMoreSpy).toHaveBeenCalledTimes(2);
    expect(sentinel(container)).not.toBeNull();
  });

  test("15E observer root 必须是 sidebar-body 滚动容器,rootMargin 底部 300px", () => {
    setupStore();
    const { container } = renderList();

    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    const observer = FakeIntersectionObserver.instances[0];
    // root = sentinel.closest(sidebar-body 选择器) 命中的渲染 wrapper
    expect(observer.options?.root).toBe(container.firstElementChild);
    expect(observer.options?.rootMargin).toBe("0px 0px 300px 0px");
  });

  test("15F listReloadError=true 且 cursor=null:会话保留、reload Retry 可见且独立于 hasMore", () => {
    const { loadMoreSpy, reloadSpy } = setupStore({
      listNextCursor: null,
      listReloadError: true,
    });
    const { container } = renderList();

    // ① sessions 继续显示(错误不清列表)
    expect(screen.getByText("会话一")).toBeTruthy();
    expect(screen.getByText("会话二")).toBeTruthy();

    // ② reload-error 状态行 + Retry 可见
    const status = container.querySelector(
      '[data-pagination-status="reload-error"]',
    );
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain(Locale.Home.ReloadError);
    const retry = container.querySelector('[data-pagination-retry="reload"]');
    expect(retry).not.toBeNull();
    expect(retry!.textContent).toBe(Locale.Home.Retry);

    // ③ hasMore=false:sentinel 不渲染、无 observer、不可能触发 loadMore
    expect(sentinel(container)).toBeNull();
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
    expect(loadMoreSpy).not.toHaveBeenCalled();

    // ④ 点击 Retry → reloadList 恰一次
    fireEvent.click(retry!);
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    // ⑤ 不调用 loadMoreConversations
    expect(loadMoreSpy).not.toHaveBeenCalled();
  });
});
