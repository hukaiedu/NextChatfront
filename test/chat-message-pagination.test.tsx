import { jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ChatMessage, ChatSession } from "../app/store/chat";
import type { PendingHistoryAnchor } from "../app/components/chat";
import type {
  BackendMessage,
  BackendMessageRole,
} from "../app/client/backend-api";

/**
 * PAG-2 Phase B2 UI / scroll 测试矩阵(设计 §30,PAG2-UI-01..10 + 01A/05A/09A)。
 *
 * 渲染完整 <Chat>,从最外层伪造 HTTP(fetch 内存版后端)与 IntersectionObserver,
 * 断言 sentinel 七条件、two-phase anchor 状态机(pendingHistoryAnchorRef 模块级导出,
 * 供测试直接断言)、append-only 收窄、Header total 公式与 Export snapshot 全链。
 */

const STAMP = "2026-09-03T00:00:00.000Z";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

let useChatStore: (typeof import("../app/store/chat"))["useChatStore"];
let Chat: (typeof import("../app/components/chat"))["Chat"];
let pendingHistoryAnchorRef: (typeof import("../app/components/chat"))["pendingHistoryAnchorRef"];
let createEmptyMask: (typeof import("../app/store/mask"))["createEmptyMask"];
let Locale: (typeof import("../app/locales"))["default"];
let MessageSelector: (typeof import("../app/components/message-selector"))["MessageSelector"];
let useMessageSelector: (typeof import("../app/components/message-selector"))["useMessageSelector"];

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
  // jsdom 未实现 IntersectionObserver / scrollIntoView / scrollTo / getBoundingClientRect
  (globalThis as any).IntersectionObserver = FakeIntersectionObserver;
  Element.prototype.scrollIntoView = () => {};
  (Element.prototype as any).scrollTo = function (x: number, y: number) {
    (this as any).__scrollCalls = ((this as any).__scrollCalls ?? []).concat([
      [x, y],
    ]);
  };
  // jsdom 无 layout:scrollHeight/clientHeight 恒 0。PAG2-FIX-01 Phase2 在
  // mount commit 内同步 scrollTo(0, scrollHeight),此刻容器级 mock 尚未挂上,
  // 故原型级给定值(与 getBoundingClientRect 同思路);容器级 mockScrollDims
  // 的同名 own property 会覆盖原型,既有用例行为不变
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get: () => 6000,
  });
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get: () => 600,
  });
  const rectTops = rectTopRegistry;
  (Element.prototype as any).getBoundingClientRect = function () {
    const id =
      typeof this.getAttribute === "function"
        ? this.getAttribute("data-message-id")
        : null;
    const top = id !== null && rectTops.has(id) ? rectTops.get(id)! : 0;
    rectEvents.push({ id, afterRelease: releaseMarker });
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 0,
      bottom: top + 600,
      width: 0,
      height: 600,
      toJSON: () => ({}),
    };
  };

  // chat store 必须先于组件求值(组件经 store/index 形成循环依赖)
  ({ useChatStore } = await import("../app/store/chat"));
  ({ createEmptyMask } = await import("../app/store/mask"));
  ({ Chat, pendingHistoryAnchorRef } = await import("../app/components/chat"));
  ({ MessageSelector, useMessageSelector } = await import(
    "../app/components/message-selector"
  ));
  Locale = (await import("../app/locales")).default;
});

// ---- 内存版后端(与 backend-chat-store.test.ts 同构的 messages GET 分支) ----

interface RecordedCall {
  url: string;
  method: string;
  body?: any;
}

const calls: RecordedCall[] = [];
const server = { messages: new Map<string, BackendMessage[]>() };

interface Hold {
  call: RecordedCall | null;
  promise: Promise<any>;
  release: (make: () => any) => void;
  match: (call: RecordedCall) => boolean;
}
const holds: Hold[] = [];

function holdMessages(
  match: (conversationId: string, params: URLSearchParams) => boolean,
): Hold {
  let doRelease!: (response: any) => void;
  const promise = new Promise<any>((resolve) => {
    doRelease = resolve;
  });
  const hold: Hold = {
    call: null,
    promise,
    release: (make) => doRelease(make()),
    match: (call) => {
      const parsed = messagesQuery(call);
      return parsed !== null && match(parsed.id, parsed.params);
    },
  };
  holds.push(hold);
  return hold;
}

function backendMessage(
  id: string,
  position: number,
  role: BackendMessageRole,
  content: string,
): BackendMessage {
  return {
    id,
    conversationId: "c-1",
    role,
    content,
    status: "COMPLETED",
    position,
    createdAt: STAMP,
    updatedAt: STAMP,
    request: null,
  };
}

function seedServerMessages(conversationId: string, total: number) {
  server.messages.set(
    conversationId,
    Array.from({ length: total }, (_, k) =>
      backendMessage(
        `m-${k + 1}`,
        k + 1,
        k % 2 === 0 ? "USER" : "ASSISTANT",
        `内容 ${k + 1}`,
      ),
    ),
  );
}

/** PAG-2:position 游标(base64url({p}),语义 position < p) */
function encodeMessageCursorOf(position: number) {
  return btoa(JSON.stringify({ p: position }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeMessageCursorP(raw: string): number {
  const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  return (JSON.parse(atob(base64)) as { p: number }).p;
}

function messagesQuery(
  call: RecordedCall,
): { id: string; params: URLSearchParams } | null {
  if (call.method !== "GET") return null;
  const match =
    /^\/backend-api\/conversations\/([^/?]+)\/messages\?(.*)$/.exec(call.url);
  return match ? { id: match[1], params: new URLSearchParams(match[2]) } : null;
}

const messageCalls = () => calls.filter((c) => messagesQuery(c) !== null);

function reply(status: number, data?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data ?? null,
  };
}

function fail(status: number, code: string, errorMessage: string) {
  return reply(status, {
    error: { code, message: errorMessage, requestId: "r" },
  });
}

function route(url: string, method: string): any {
  const messagesMatch =
    /^\/backend-api\/conversations\/([^/?]+)\/messages\?(.*)$/.exec(url);
  if (messagesMatch && method === "GET") {
    // 与后端同构:position keyset(desc 取 limit+1 探测 → slice → reverse 旧→新)
    const id = messagesMatch[1];
    const params = new URLSearchParams(messagesMatch[2]);
    const limit = Number(params.get("limit")) || 50;
    const all = (server.messages.get(id) ?? [])
      .slice()
      .sort((a, b) => a.position - b.position);
    const cursor = params.get("cursor");
    const pool = cursor
      ? all.filter((m) => m.position < decodeMessageCursorP(cursor))
      : all;
    const desc = pool.slice().reverse();
    const hasMore = desc.length > limit;
    const page = desc.slice(0, limit).reverse();
    return reply(200, {
      data: page,
      meta: {
        nextCursor: hasMore
          ? encodeMessageCursorOf(page[0]!.position)
          : null,
        totalCount: all.length,
      },
    });
  }
  return fail(404, "NOT_FOUND", `未预期的请求 ${method} ${url}`);
}

// ---- getBoundingClientRect 虚拟布局 + 放行标记(REVIEW-25 时序探针) ----

// 按 data-message-id 注册:msgRenderIndex=0 的中间 commit 会因 key 集整体变化
// 重挂消息节点,按元素身份注册会失效
const rectTopRegistry = new Map<string, number>();
const rectEvents: { id: string | null; afterRelease: boolean }[] = [];
let releaseMarker = false;

function setRectTop(messageId: string, top: number) {
  rectTopRegistry.set(messageId, top);
}

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

// ---- store 会话种子 ----

function chatMessage(
  id: string,
  position: number | undefined,
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role: position !== undefined && position % 2 === 0 ? "assistant" : "user",
    content,
    date: STAMP,
    ...(position !== undefined ? { position } : {}),
    ...extra,
  };
}

function persistedMessages(from: number, to: number): ChatMessage[] {
  return Array.from({ length: to - from + 1 }, (_, k) => {
    const position = from + k;
    return chatMessage(`m-${position}`, position, `内容 ${position}`);
  });
}

function makeSession(
  overrides: Partial<ChatSession> = {},
): ChatSession {
  return {
    id: "c-1",
    topic: "分页会话",
    messages: [],
    stat: { tokenCount: 0, wordCount: 0, charCount: 0 },
    lastUpdate: Date.parse(STAMP),
    mask: createEmptyMask(),
    loaded: true,
    draft: false,
    conversationStatus: "ACTIVE",
    messageNextCursor: null,
    loadingOlderMessages: false,
    messageHistoryError: false,
    messageTotalCount: 0,
    ...overrides,
  } as ChatSession;
}

/** 首查后状态:已载最新 50 条(position 151..200),更老历史还有 150 条 */
function firstPageSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return makeSession({
    messages: persistedMessages(151, 200),
    messageNextCursor: encodeMessageCursorOf(151),
    messageTotalCount: 200,
    ...overrides,
  });
}

function applySessions(sessions: ChatSession[], currentSessionIndex = 0) {
  useChatStore.setState({
    sessions,
    currentSessionIndex,
    ready: true,
    loadingList: false,
    listStatus: "ACTIVE",
    listNextCursor: null,
    loadingMoreList: false,
    listReloadError: false,
    listMoreError: false,
  } as any);
}

// ---- 渲染与滚动工具 ----

function findChatBody(): HTMLDivElement {
  const body = document.querySelector("[data-message-id]")?.parentElement;
  if (!body) throw new Error("chat-body 容器未找到(无消息渲染)");
  return body as HTMLDivElement;
}

/** jsdom 无 layout:scrollTop 可变,scrollHeight/clientHeight 定值
 *  (0+600 >= 6000-600 不成立 → scroll 事件恒判触顶,窗口上移一页) */
function mockScrollDims(container: HTMLElement) {
  let scrollTop = 0;
  Object.defineProperty(container, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
  });
  Object.defineProperty(container, "scrollHeight", {
    configurable: true,
    get: () => 6000,
  });
  Object.defineProperty(container, "clientHeight", {
    configurable: true,
    get: () => 600,
  });
}

async function renderChat() {
  render(
    <MemoryRouter>
      <Chat />
    </MemoryRouter>,
  );
  const container = findChatBody();
  mockScrollDims(container);
  // 冲掉挂载期 scrollDomToBottom 的 rAF(UI-06 的自动到底就发生在这里)
  await act(async () => {
    await nextFrame();
  });
  return container;
}

const scrollUp = (container: HTMLElement) => fireEvent.scroll(container);

/** 50 条会话:窗口 35→20→5→0,渲染 m-151..m-195,sentinel 出现 */
async function scrollToTopWithSentinel(container: HTMLDivElement) {
  scrollUp(container);
  scrollUp(container);
  scrollUp(container);
  return container.querySelector('[data-message-id="m-151"]')!;
}

const checkboxes = () =>
  Array.from(
    document.querySelectorAll('input[type="checkbox"]'),
  ) as HTMLInputElement[];

beforeEach(() => {
  calls.length = 0;
  holds.length = 0;
  server.messages = new Map();
  FakeIntersectionObserver.instances = [];
  rectTopRegistry.clear();
  rectEvents.length = 0;
  releaseMarker = false;
  pendingHistoryAnchorRef.current = null;
  useChatStore.setState({
    sessions: [],
    currentSessionIndex: 0,
    lastInput: "",
    ready: false,
    loadingList: false,
    listStatus: "ACTIVE",
    listNextCursor: null,
    loadingMoreList: false,
    listReloadError: false,
    listMoreError: false,
  } as any);
  localStorage.clear();
  (globalThis as any).fetch = jest.fn(
    async (input: any, init: RequestInit = {}) => {
      const url = String(input);
      const method = String(init.method ?? "GET").toUpperCase();
      const parsed =
        typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      const call: RecordedCall = { url, method, body: parsed };
      calls.push(call);
      const hold = holds.find((h) => h.call === null && h.match(call));
      if (hold) {
        hold.call = call;
        return hold.promise;
      }
      return route(url, method);
    },
  );
});

// ---- PAG2-UI-01 / 01A / 02:sentinel 七条件 ----

describe("PAG2-UI-01/01A/02 sentinel 可见性", () => {
  test("UI-01:sentinel intersect → 恰触发一次 loadOlder(root/300px/触发期二次请求被 guard)", async () => {
    seedServerMessages("c-1", 200);
    applySessions([firstPageSession()]);
    const container = await renderChat();

    // 初始 msgRenderIndex=35:窗口内无 sentinel,零请求
    expect(
      document.querySelector('[data-message-pagination-sentinel="true"]'),
    ).toBeNull();
    expect(messageCalls()).toHaveLength(0);

    const anchorEl = await scrollToTopWithSentinel(container);
    const sentinel = document.querySelector(
      '[data-message-pagination-sentinel="true"]',
    );
    expect(sentinel).not.toBeNull();
    const observer = FakeIntersectionObserver.instances.at(-1)!;
    expect(observer.targets).toContain(sentinel!);
    expect(observer.options?.root).toBe(container);
    expect(observer.options?.rootMargin).toBe("300px 0px 0px 0px");

    const hold = holdMessages(
      (_id, params) =>
        params.get("cursor") === encodeMessageCursorOf(151),
    );
    observer.intersect();
    observer.intersect(); // loading 中第二次 intersect → guard 拦截

    expect(messageCalls()).toHaveLength(1);
    await act(async () => {
      hold.release(() => route(hold.call!.url, "GET"));
      await tick();
    });

    const session = useChatStore.getState().sessions[0];
    expect(session.messages).toHaveLength(100);
    expect(session.messages[0].id).toBe("m-101");
    expect(session.messageNextCursor).toBe(encodeMessageCursorOf(101));
    expect(session.loadingOlderMessages).toBe(false);
    expect(messageCalls()).toHaveLength(1);
  });

  test("UI-01A:msgRenderIndex>0 → 无 Backend history sentinel、零请求,窗口仅本地移动", async () => {
    seedServerMessages("c-1", 200);
    applySessions([firstPageSession()]);
    const container = await renderChat();

    scrollUp(container); // 35→20

    expect(
      document.querySelector('[data-message-pagination-sentinel="true"]'),
    ).toBeNull();
    expect(messageCalls()).toHaveLength(0);
    // 窗口 20..50:m-171 起,m-151(index 0)已滑出窗口
    expect(container.querySelector('[data-message-id="m-171"]')).not.toBeNull();
    expect(container.querySelector('[data-message-id="m-151"]')).toBeNull();
  });

  test("UI-02:cursor=null → 无 sentinel/无三态 UI,滚到顶也不触发", async () => {
    applySessions([
      makeSession({ messages: persistedMessages(1, 50), messageTotalCount: 50 }),
    ]);
    const container = await renderChat();

    scrollUp(container);
    scrollUp(container);
    scrollUp(container);

    expect(
      document.querySelector('[data-message-pagination-sentinel="true"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-message-pagination-status="loading"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-message-pagination-status="error"]'),
    ).toBeNull();
    expect(messageCalls()).toHaveLength(0);
  });
});

// ---- PAG2-UI-03 / 04:loading / error / retry UX ----

describe("PAG2-UI-03/04 loading 与 retry", () => {
  test("UI-03:loading 中 → 顶部 loading UI,无 sentinel 零请求", async () => {
    seedServerMessages("c-1", 200);
    applySessions([firstPageSession({ loadingOlderMessages: true })]);
    const container = await renderChat();

    expect(
      document.querySelector('[data-message-pagination-status="loading"]'),
    ).not.toBeNull();
    expect(screen.getByText(Locale.Chat.HistoryLoading)).toBeTruthy();
    expect(
      document.querySelector('[data-message-pagination-sentinel="true"]'),
    ).toBeNull();
    expect(messageCalls()).toHaveLength(0);

    scrollUp(container); // 窗口本地移动,仍不触发请求

    expect(
      document.querySelector('[data-message-pagination-status="loading"]'),
    ).not.toBeNull();
    expect(messageCalls()).toHaveLength(0);
  });

  test("UI-04:error → Retry 可见且恰重发一次,成功后 error 消失", async () => {
    seedServerMessages("c-1", 200);
    applySessions([firstPageSession({ messageHistoryError: true })]);
    const container = await renderChat();

    // 用户已滚到顶:msgRenderIndex=0,anchor 可见(error 态无 sentinel)
    const anchorEl = await scrollToTopWithSentinel(container);
    expect(
      document.querySelector('[data-message-pagination-status="error"]'),
    ).not.toBeNull();
    expect(messageCalls()).toHaveLength(0); // 无自动重试风暴

    setRectTop("m-151", 50);
    const retry = document.querySelector(
      '[data-message-pagination-retry="older"]',
    ) as HTMLButtonElement;
    const hold = holdMessages(() => true);
    fireEvent.click(retry);

    expect(messageCalls()).toHaveLength(1); // 恰重发一次,同 cursor
    expect(messagesQuery(messageCalls()[0])!.params.get("cursor")).toBe(
      encodeMessageCursorOf(151),
    );
    await act(async () => {
      hold.release(() => route(hold.call!.url, "GET"));
      await tick();
    });

    expect(
      document.querySelector('[data-message-pagination-status="error"]'),
    ).toBeNull();
    const session = useChatStore.getState().sessions[0];
    expect(session.messageHistoryError).toBe(false);
    expect(session.messages).toHaveLength(100);
    expect(session.messageNextCursor).toBe(encodeMessageCursorOf(101));
  });
});

// ---- PAG2-UI-05 / 05A:two-phase anchor 状态机 ----

describe("PAG2-UI-05/05A anchor 状态机", () => {
  test("UI-05:请求前写入 awaiting-prepend(六字段)→ phase1 findIndex=50 → phase2 锚定 ±0px → 三态迁移 null", async () => {
    seedServerMessages("c-1", 200);
    applySessions([firstPageSession()]);
    const container = await renderChat();
    const mountScrollCalls = (container as any).__scrollCalls as [
      number,
      number,
    ][];
    const anchorEl = await scrollToTopWithSentinel(container);
    setRectTop("m-151", 50);

    const hold = holdMessages(
      (_id, params) =>
        params.get("cursor") === encodeMessageCursorOf(151),
    );
    FakeIntersectionObserver.instances.at(-1)!.intersect();

    // §23.2:请求发出前 ref 已写入,信息跨 async 存活
    expect(pendingHistoryAnchorRef.current).toEqual({
      sessionId: "c-1",
      requestedCursor: encodeMessageCursorOf(151),
      oldFirstMessageId: "m-151",
      messageId: "m-151",
      relativeTop: 50,
      prependedCount: 0,
      phase: "awaiting-prepend",
    });
    await act(async () => {
      await tick(); // GET 在飞
    });
    expect(pendingHistoryAnchorRef.current!.phase).toBe("awaiting-prepend");

    // 放行 page2:store prepend → commit(REVIEW-25:layout 两阶段不依赖 await 后的 result)
    releaseMarker = true;
    setRectTop("m-151", 30); // prepend 后 anchor 的虚拟位置
    await act(async () => {
      hold.release(() => route(hold.call!.url, "GET"));
      await tick();
    });

    // awaiting-prepend → restore-anchor → null 三态迁移完成
    expect(pendingHistoryAnchorRef.current).toBeNull();
    // phase2:scrollTop += (30 − 50)
    expect(container.scrollTop).toBe(-20);
    expect(
      rectEvents.filter((e) => e.id === "m-151" && e.afterRelease),
    ).toHaveLength(1); // phase2 恰读一次 anchor rect
    const session = useChatStore.getState().sessions[0];
    expect(session.messages).toHaveLength(100);
    expect(session.messages[0].id).toBe("m-101");
    expect(session.messageNextCursor).toBe(encodeMessageCursorOf(101));
    expect(session.loadingOlderMessages).toBe(false);
    // 主补偿 0→50:m-151 在窗口内,m-101 留在窗口外
    expect(container.querySelector('[data-message-id="m-151"]')).not.toBeNull();
    expect(container.querySelector('[data-message-id="m-101"]')).toBeNull();
    expect(messageCalls()).toHaveLength(1);
    // prepend 零拉底:scrollTo 调用与挂载期基线一致(基线含 autoFocus 的重复拉底)
    expect((container as any).__scrollCalls).toEqual(mountScrollCalls);
  });

  test("UI-05(0-prepend 空页):await continuation 以 requestAnchor 身份校验收口,不留旧 anchor", async () => {
    seedServerMessages("c-1", 200);
    applySessions([firstPageSession()]);
    const container = await renderChat();
    const anchorEl = await scrollToTopWithSentinel(container);
    setRectTop("m-151", 50);

    const hold = holdMessages(() => true);
    FakeIntersectionObserver.instances.at(-1)!.intersect();
    expect(pendingHistoryAnchorRef.current!.phase).toBe("awaiting-prepend");

    await act(async () => {
      hold.release(() =>
        reply(200, { data: [], meta: { nextCursor: null, totalCount: 200 } }),
      );
      await tick();
    });

    // REVIEW-32:applied=true && prependedCount=0 → continuation 清 null
    expect(pendingHistoryAnchorRef.current).toBeNull();
    expect(container.scrollTop).toBe(0); // 无 phase2 修正
    expect(
      rectEvents.filter((e) => e.afterRelease),
    ).toHaveLength(0); // phase2 从未执行
    // 窗口未动(msgRenderIndex 仍 0),消息数不变
    expect(container.querySelector('[data-message-id="m-151"]')).not.toBeNull();
    expect(useChatStore.getState().sessions[0].messages).toHaveLength(50);
    expect(useChatStore.getState().sessions[0].messageNextCursor).toBeNull();
  });

  test("UI-05(失败):ref 清理含 requestAnchor 身份校验,不误清新一轮已重写的 ref", async () => {
    seedServerMessages("c-1", 200);
    applySessions([firstPageSession()]);
    const container = await renderChat();
    const anchorEl = await scrollToTopWithSentinel(container);
    setRectTop("m-151", 50);

    const hold = holdMessages(() => true);
    FakeIntersectionObserver.instances.at(-1)!.intersect();
    expect(pendingHistoryAnchorRef.current!.phase).toBe("awaiting-prepend");

    // 模拟:await continuation 恢复前,新一轮请求已重写 ref(真实新一轮写入的是
    // awaiting-prepend;restore-anchor 会被 layout effect 当 phase2 完成清掉)
    const fakeNew = {
      ...(pendingHistoryAnchorRef.current as PendingHistoryAnchor),
      phase: "awaiting-prepend",
    } as PendingHistoryAnchor;
    await act(async () => {
      hold.release(() => fail(500, "INTERNAL_ERROR", "boom"));
      pendingHistoryAnchorRef.current = fakeNew;
      await tick();
    });

    expect(pendingHistoryAnchorRef.current).toBe(fakeNew); // 身份不符,不清
    expect(useChatStore.getState().sessions[0].messageHistoryError).toBe(true);
    expect(
      document.querySelector('[data-message-pagination-status="error"]'),
    ).not.toBeNull();
    pendingHistoryAnchorRef.current = null; // 收尾防泄漏
  });

  test("UI-05A:prepend 期间并发 append → prependCount=findIndex=50(非 length delta),append 两条仍在尾部", async () => {
    seedServerMessages("c-1", 200);
    applySessions([firstPageSession()]);
    const container = await renderChat();
    const anchorEl = await scrollToTopWithSentinel(container);
    setRectTop("m-151", 50);

    const hold = holdMessages(() => true);
    FakeIntersectionObserver.instances.at(-1)!.intersect();

    // 在飞期间 send append 2 条 transient(直接写权威态,不走真实 send)
    await act(async () => {
      useChatStore.setState((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === "c-1"
            ? {
                ...s,
                messages: [
                  ...s.messages,
                  chatMessage("t-1", undefined, "并发 1", { role: "user" }),
                  chatMessage("t-2", undefined, "并发 2", {
                    role: "assistant",
                  }),
                ],
              }
            : s,
        ),
      }));
      await tick();
    });
    // append commit:phase1 findIndex=0 → 无 UI 副作用,ref 不动
    expect(pendingHistoryAnchorRef.current!.phase).toBe("awaiting-prepend");

    releaseMarker = true;
    setRectTop("m-151", 30);
    await act(async () => {
      hold.release(() => route(hold.call!.url, "GET"));
      await tick();
    });

    expect(pendingHistoryAnchorRef.current).toBeNull();
    expect(container.scrollTop).toBe(-20);
    const session = useChatStore.getState().sessions[0];
    expect(session.messages).toHaveLength(102);
    expect(session.messages[0].id).toBe("m-101");
    // append 的 2 条仍在尾部,position 未定义
    expect(session.messages[100]).toMatchObject({ id: "t-1" });
    expect(session.messages[101]).toMatchObject({ id: "t-2" });
    expect(session.messages[100].position).toBeUndefined();
    // findIndex=50 → 窗口 slice(50,95)=m-151..m-195;
    // 若错用请求前快照的 length delta(52)会滑到 m-153..m-197
    expect(container.querySelector('[data-message-id="m-151"]')).not.toBeNull();
    expect(container.querySelector('[data-message-id="m-152"]')).not.toBeNull();
    expect(container.querySelector('[data-message-id="m-101"]')).toBeNull();
  });

  test("UI-05A:findIndex=-1(链被 latest gap/reset 替换)→ 清 ref、不做猜测性 scroll 修正", async () => {
    seedServerMessages("c-1", 200);
    applySessions([firstPageSession()]);
    const container = await renderChat();
    const anchorEl = await scrollToTopWithSentinel(container);
    setRectTop("m-151", 50);

    const hold = holdMessages(() => true);
    FakeIntersectionObserver.instances.at(-1)!.intersect();

    // 在飞期间整组替换 messages(不含 m-151)
    await act(async () => {
      useChatStore.setState((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === "c-1" ? { ...s, messages: persistedMessages(201, 250) } : s,
        ),
      }));
      await tick();
    });
    // 替换 commit 的 phase1 即清 ref(§23.4 五)
    expect(pendingHistoryAnchorRef.current).toBeNull();

    releaseMarker = true;
    await act(async () => {
      hold.release(() => route(hold.call!.url, "GET"));
      await tick();
    });

    expect(pendingHistoryAnchorRef.current).toBeNull();
    expect(container.scrollTop).toBe(0); // 无猜测性修正
    expect(rectEvents.filter((e) => e.afterRelease)).toHaveLength(0);
    // msgRenderIndex 未动:窗口仍从 0 起 → 渲染 prepend 后的 m-101..m-145
    expect(container.querySelector('[data-message-id="m-101"]')).not.toBeNull();
    expect(container.querySelector('[data-message-id="m-146"]')).toBeNull();
  });
});

// ---- PAG2-UI-06 / 07 / 08:scroll 行为与会话隔离 ----

describe("PAG2-UI-06/07/08 scroll 与会话", () => {
  test("UI-06:首开自动到底部(现行为保留),初始窗口=最新 15 条", async () => {
    applySessions([firstPageSession()]);
    const container = await renderChat();

    // 挂载期 scrollDomToBottom(textarea autoFocus 还会再触发一次,均为拉底)
    const scrollCalls = (container as any).__scrollCalls as [number, number][];
    expect(scrollCalls.length).toBeGreaterThanOrEqual(1);
    expect(scrollCalls.every(([x, y]) => x === 0 && y === 6000)).toBe(true);
    const ids = Array.from(container.querySelectorAll("[data-message-id]")).map(
      (el) => el.getAttribute("data-message-id"),
    );
    expect(ids).toHaveLength(15);
    expect(ids[0]).toBe("m-186");
    expect(ids.at(-1)).toBe("m-200");
  });

  test("UI-07:prepend 不触发 scroll-to-bottom(append-only 收窄回归锁定)", async () => {
    seedServerMessages("c-1", 200);
    applySessions([firstPageSession()]);
    const container = await renderChat();
    const mountScrollCalls = (container as any).__scrollCalls as [
      number,
      number,
    ][];
    expect(mountScrollCalls.length).toBeGreaterThanOrEqual(1); // 仅首开

    const anchorEl = await scrollToTopWithSentinel(container);
    setRectTop("m-151", 50);
    const hold = holdMessages(() => true);
    FakeIntersectionObserver.instances.at(-1)!.intersect();
    await act(async () => {
      hold.release(() => route(hold.call!.url, "GET"));
      await tick();
    });

    expect(useChatStore.getState().sessions[0].messages).toHaveLength(100);
    // prepend 零拉底:scrollTo 调用与挂载期基线完全一致
    expect((container as any).__scrollCalls).toEqual(mountScrollCalls);
  });

  test("UI-08:切换会话再切回,各自分页状态独立保留,组件 remount 后 UI 从 store 恢复", async () => {
    seedServerMessages("c-1", 200);
    applySessions([
      makeSession({
        messages: persistedMessages(101, 200),
        messageNextCursor: encodeMessageCursorOf(101),
        messageTotalCount: 200,
        messageHistoryError: true,
      }),
      makeSession({
        id: "c-2",
        messages: persistedMessages(1, 30),
        messageTotalCount: 30,
      }),
    ]);
    await renderChat();
    let container = findChatBody();

    // A:错误态可见(store 恢复);msgRenderIndex=85 → 无 sentinel
    expect(
      document.querySelector('[data-message-pagination-status="error"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-message-pagination-sentinel="true"]'),
    ).toBeNull();
    expect(container.querySelector('[data-message-id="m-186"]')).not.toBeNull();

    await act(async () => {
      useChatStore.setState({ currentSessionIndex: 1 });
      await tick();
    });
    container = findChatBody();
    // B:cursor=null → 无任何分页 UI,窗口=最新 15 条
    expect(
      document.querySelector('[data-message-pagination-status="error"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-message-pagination-sentinel="true"]'),
    ).toBeNull();
    expect(container.querySelector('[data-message-id="m-16"]')).not.toBeNull();

    await act(async () => {
      useChatStore.setState({ currentSessionIndex: 0 });
      await tick();
    });
    container = findChatBody();
    // 切回 A:错误态/消息/cursor 全部独立保留,且零重拉
    expect(
      document.querySelector('[data-message-pagination-status="error"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-message-id="m-186"]')).not.toBeNull();
    const a = useChatStore.getState().sessions[0];
    expect(a.messages).toHaveLength(100);
    expect(a.messageNextCursor).toBe(encodeMessageCursorOf(101));
    expect(a.messageHistoryError).toBe(true);
    expect(messageCalls()).toHaveLength(0);
  });
});

// ---- PAG2-UI-09 / 09A:Export snapshot 链 ----

function SelectorHost(props: { messages?: ChatMessage[] }) {
  const { selection, updateSelection } = useMessageSelector();
  return (
    <MessageSelector
      messages={props.messages}
      selection={selection}
      updateSelection={updateSelection}
      defaultSelectAll
    />
  );
}

describe("PAG2-UI-09/09A Export snapshot", () => {
  test("UI-09:Export 全链 → Modal 收到 200 条 snapshot,Chat 的 50 条局部态不受影响", async () => {
    seedServerMessages("c-1", 200);
    applySessions([firstPageSession()]);
    const container = await renderChat();
    const exportButton = screen.getByTitle(
      Locale.Chat.Actions.Export,
    ) as HTMLButtonElement;

    const hold = holdMessages((_id, params) => params.get("cursor") === null);
    fireEvent.click(exportButton);
    await act(async () => {
      await tick();
    });
    // preparingExport:按钮 disabled,禁重复触发
    expect(exportButton.disabled).toBe(true);
    expect(messageCalls()).toHaveLength(1);
    fireEvent.click(exportButton);
    expect(messageCalls()).toHaveLength(1);

    await act(async () => {
      hold.release(() => route(hold.call!.url, "GET"));
      await tick();
      await tick();
    });

    // Modal 打开:MessageSelector 基于 200 条 snapshot + defaultSelectAll 全选
    // (exporter 自带一个 includeContext checkbox,Selector 行均带 readOnly 属性)
    const selectorChecks = checkboxes().filter((cb) => cb.readOnly);
    expect(selectorChecks).toHaveLength(200);
    expect(selectorChecks.every((cb) => cb.checked)).toBe(true);

    // Chat 不受影响:局部 50 条 / cursor / scrollTop / 渲染窗口全不变
    const session = useChatStore.getState().sessions[0];
    expect(session.messages).toHaveLength(50);
    expect(session.messageNextCursor).toBe(encodeMessageCursorOf(151));
    expect(container.scrollTop).toBe(0);
    expect(container.querySelector('[data-message-id="m-186"]')).not.toBeNull();
    expect(container.querySelector('[data-message-id="m-151"]')).toBeNull();
    expect(messageCalls()).toHaveLength(4); // 恰 4 页(50×4)
    expect(exportButton.disabled).toBe(false); // finally 复位
  });

  test("UI-09A:props.messages 为唯一数据源,clearContextIndex 不应用,搜索跑在 snapshot 上", async () => {
    applySessions([
      makeSession({
        messages: persistedMessages(151, 200),
        messageTotalCount: 200,
        clearContextIndex: 25,
      }),
    ]);
    const snapshot = persistedMessages(1, 200);
    render(
      <MemoryRouter>
        <SelectorHost messages={snapshot} />
      </MemoryRouter>,
    );
    await act(async () => {
      await tick();
    });

    // fallback 会裁到 25(slice)或 50(reset 边界);200 证明未应用 clearContextIndex
    expect(checkboxes()).toHaveLength(200);
    expect(checkboxes().every((cb) => cb.checked)).toBe(true);

    // 搜索「内容 42」:只在 snapshot 早段存在,fallback 切片永远看不到
    const search = document.querySelector(
      'input[type="text"]',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.input(search, { target: { value: "内容 42" } });
    });
    expect(checkboxes()).toHaveLength(1);
    await act(async () => {
      fireEvent.input(search, { target: { value: "" } });
    });
    expect(checkboxes()).toHaveLength(200);
  });

  test("UI-09A(fallback 回归):不传 messages → 沿用 session.messages 的 clearContextIndex 切片", async () => {
    applySessions([
      makeSession({
        messages: persistedMessages(1, 10),
        messageTotalCount: 10,
        clearContextIndex: 5,
      }),
    ]);
    render(
      <MemoryRouter>
        <SelectorHost />
      </MemoryRouter>,
    );
    await act(async () => {
      await tick();
    });

    expect(checkboxes()).toHaveLength(5);
    expect(screen.getByText("内容 6")).toBeTruthy();
    expect(screen.queryByText("内容 5")).toBeNull();
  });

  test("UI-09A(fallback 边界):clearContextIndex === length-1 → 重置为全量", async () => {
    applySessions([
      makeSession({
        messages: persistedMessages(1, 10),
        messageTotalCount: 10,
        clearContextIndex: 9,
      }),
    ]);
    render(
      <MemoryRouter>
        <SelectorHost />
      </MemoryRouter>,
    );
    await act(async () => {
      await tick();
    });

    expect(checkboxes()).toHaveLength(10);
  });
});

// ---- PAG2-UI-10:Header total 四分支 ----

describe("PAG2-UI-10 Header displayedCount", () => {
  test("建链后:首次只载 50,totalCount=200 → Header 显示 200", async () => {
    applySessions([firstPageSession()]);
    await renderChat();
    expect(screen.getByText(Locale.Chat.SubTitle(200))).toBeTruthy();
  });

  test("send 后(链已建立):显示 totalCount + 本地 transient = 202", async () => {
    applySessions([firstPageSession()]);
    await renderChat();
    await act(async () => {
      useChatStore.setState((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === "c-1"
            ? {
                ...s,
                messages: [
                  ...s.messages,
                  chatMessage("t-1", undefined, "新消息", { role: "user" }),
                  chatMessage("t-2", undefined, "", { role: "assistant" }),
                ],
              }
            : s,
        ),
      }));
      await tick();
    });
    expect(screen.getByText(Locale.Chat.SubTitle(202))).toBeTruthy();
  });

  test("send 失败 error bubble 在列:同样计入 totalCount + transientCount = 201", async () => {
    applySessions([firstPageSession()]);
    await renderChat();
    await act(async () => {
      useChatStore.setState((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === "c-1"
            ? {
                ...s,
                messages: [
                  ...s.messages,
                  chatMessage("t-err", undefined, "", {
                    role: "user",
                    isError: true,
                  }),
                ],
              }
            : s,
        ),
      }));
      await tick();
    });
    expect(screen.getByText(Locale.Chat.SubTitle(201))).toBeTruthy();
  });

  test("draft 或 loaded=false:显示本地 messages.length(禁 0+2 冒充)", async () => {
    applySessions([
      makeSession({
        id: "draft-1",
        draft: true,
        loaded: false,
        messages: persistedMessages(1, 3),
      }),
    ]);
    await renderChat();
    expect(screen.getByText(Locale.Chat.SubTitle(3))).toBeTruthy();
  });
});

// ---- PAG2-UI-FIX-01 / FIX-02:冷启动窗口初始化状态机(FIX-01 review round) ----

describe("PAG2-UI-FIX-01/02 冷启动窗口初始化", () => {
  /**
   * 冷启动公共序:loaded=false 空链 mount + latest GET 挂起 → 放行响应。
   * 容器在消息落地后才能经 findChatBody 取得(jsdom 空链无 data-message-id),
   * Phase2 的贴底调用已由原型级 scrollTo polyfill 记录在元素上,不依赖取容器时机
   */
  async function coldMountChat() {
    seedServerMessages("c-1", 200);
    applySessions([makeSession({ loaded: false })]);
    const hold = holdMessages((_id, params) => params.get("cursor") === null);
    await act(async () => {
      void useChatStore.getState().loadSessionMessages("c-1");
      await tick();
    });
    render(
      <MemoryRouter>
        <Chat />
      </MemoryRouter>,
    );
    // 冷挂载:空链、无任何分页 UI,latest GET 仍在飞(§十六 步骤 1-3)
    expect(document.querySelector("[data-message-id]")).toBeNull();
    expect(
      document.querySelector('[data-message-pagination-sentinel="true"]'),
    ).toBeNull();
    expect(messageCalls()).toHaveLength(1);

    // 放行 latest 响应:items=50(151..200),nextCursor=p151,totalCount=200
    await act(async () => {
      hold.release(() => route(hold.call!.url, "GET"));
      await tick();
    });
    const container = findChatBody();
    mockScrollDims(container);
    return container;
  }

  test("UI-FIX-01:latest 响应异步落地 → 窗口对齐 latest 15 条、贴底、零抢跑,gate 打开", async () => {
    const container = await coldMountChat();

    // A/B:恰 1 次 Message GET,cold-start 无自动第 2 页
    expect(messageCalls()).toHaveLength(1);
    // D/E:render window = latest window,DOM 恰 15 条 m-186..m-200
    const ids = Array.from(
      container.querySelectorAll("[data-message-id]"),
    ).map((el) => el.getAttribute("data-message-id"));
    expect(ids).toHaveLength(15);
    expect(ids[0]).toBe("m-186");
    expect(ids.at(-1)).toBe("m-200");
    // F:初始化贴底已发生(Phase2 同步 scrollTo + mount rAF,全部为贴底调用)
    const scrollCalls = (container as any).__scrollCalls as [
      number,
      number,
    ][];
    expect(scrollCalls.length).toBeGreaterThanOrEqual(1);
    expect(scrollCalls.every(([x, y]) => x === 0 && y === 6000)).toBe(true);
    // G:Header = 200
    expect(screen.getByText(Locale.Chat.SubTitle(200))).toBeTruthy();
    // H:sentinel 不存在(msgRenderIndex=35 ≠ 0)
    expect(
      document.querySelector('[data-message-pagination-sentinel="true"]'),
    ).toBeNull();
    // I:期间无 scroll anchor 触发
    expect(pendingHistoryAnchorRef.current).toBeNull();

    // C:稳定窗口后仍零请求;滚到顶 sentinel 出现 → 证明 initialization gate 已 ready
    await act(async () => {
      await nextFrame();
    });
    expect(messageCalls()).toHaveLength(1);
    scrollUp(container);
    scrollUp(container);
    scrollUp(container);
    expect(
      document.querySelector('[data-message-pagination-sentinel="true"]'),
    ).not.toBeNull();
    expect(messageCalls()).toHaveLength(1); // gate 开了,但 IO 未 intersect 不拉取
  });

  test("UI-FIX-02:ready 是终态 —— refresh merge 不重入初始化,阅读窗口与滚动保持", async () => {
    const container = await coldMountChat();
    expect(container.querySelector('[data-message-id="m-186"]')).not.toBeNull();

    // 用户上滚一页:window 35→20,首条 m-171
    scrollUp(container);
    // 排干 scrollUp 前已挂起的 rAF 拉底链(rAF→scrollTo+setAutoScroll(true)→
    // commit→effect→再排一个 rAF,链条最长 2 帧);否则链条会落在基线捕获之后,
    // 令 __scrollCalls 基线偶发多出 [0,6000](约 1/3 概率的时序 flake)
    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        await nextFrame();
      }
    });
    expect(
      container.querySelector('[data-message-id="m-171"]'),
    ).not.toBeNull();
    const scrollBaseline = ((container as any).__scrollCalls ?? []).slice();

    // normal latest refresh(authoritative merge,loaded 始终 true)
    await act(async () => {
      await useChatStore.getState().refreshSessionMessages("c-1");
      await tick();
    });

    // A/B:不重入 aligning —— msgRenderIndex 不被重置回 35(首条仍 m-171)
    const firstId = container
      .querySelector("[data-message-id]")
      ?.getAttribute("data-message-id");
    expect(firstId).toBe("m-171");
    // C:无自动 scroll-to-bottom(同步 scrollTo 与基线一致)
    expect((container as any).__scrollCalls).toEqual(scrollBaseline);
    // D:阅读窗口保持(m-151 仍不在窗口)
    expect(container.querySelector('[data-message-id="m-151"]')).toBeNull();
    // E:PAG-2 normal refresh merge 正常(链/游标/总数不变)
    const session = useChatStore.getState().sessions[0];
    expect(session.loaded).toBe(true);
    expect(session.messages).toHaveLength(50);
    expect(session.messageNextCursor).toBe(encodeMessageCursorOf(151));
    expect(session.messageTotalCount).toBe(200);
    // F:不产生额外 loadOlder(全部 GET 均为 latest,cursor=null)
    expect(messageCalls()).toHaveLength(2);
    expect(
      messageCalls().filter(
        (c) => messagesQuery(c)!.params.get("cursor") !== null,
      ),
    ).toHaveLength(0);
    expect(pendingHistoryAnchorRef.current).toBeNull();
  });
});
