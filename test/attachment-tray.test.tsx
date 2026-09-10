import { jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React from "react";
import fs from "fs";
import type { ChatSession } from "../app/store/chat";
import type {
  BackendConversation,
  BackendMessage,
  BackendMessageRole,
  BackendRequest,
  BackendRequestBrief,
} from "../app/client/backend-api";

/**
 * I3-A 附件托盘 / 组件层竞态测试(R38 矩阵组件侧)。
 *
 * - I3-PREVIEW-01..05 托盘渲染 / 删除第 i 张 / 预览 / 处理中禁用 / 移动端 mask
 * - I3-PROCESS-01..05 准备期 Send 与 picker 不可用、批内失败继续、张数/总量上限、
 *   pendingRequestId(Stop)阶段 upload 入口不可用
 * - I3-SUBMIT-01..03  POST 在途:双击恰一次、附件不可改、跨会话 continuation 不串台
 * - I3-DRAFT-01..04   草稿 promotion:remount 不归零 / 失败保留重试 / 恰一次 / accepted 清空
 * - I3-MEM-CONV-01    慢压缩期间切会话,旧结果不得进入新会话
 * - I3-MEM-01..03     切会话清空 / 卸载无持久化 / 硬 reload 无本地副本
 *
 * 渲染完整 <Chat>,从最外层伪造 fetch(内存版后端)与 FileReader/Image/canvas,
 * 使"准备中(PREPARING)"与"POST 在途(SUBMITTING)"两个窗口可被精确挂起。
 */

// 默认 svg mock(test/svg-mock.tsx)渲染 null,DeleteIcon 在 jsdom 里没有 DOM
// 节点。本文件把该 mock 渲染为 span 并透传 props(className/role/aria-label/
// onClick),托盘删除按钮才能被真实点击。仅影响本测试文件。
// (ESM 下 jest.mock 不生效,must 用 unstable_mockModule;路径基准是 rootDir。)
jest.unstable_mockModule("./test/svg-mock.tsx", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) =>
    React.createElement("span", props),
}));

const STAMP = "2026-09-10T00:00:00.000Z";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let useChatStore: (typeof import("../app/store/chat"))["useChatStore"];
let Chat: (typeof import("../app/components/chat"))["Chat"];
let createEmptyMask: (typeof import("../app/store/mask"))["createEmptyMask"];
let getMessageImages: (typeof import("../app/utils"))["getMessageImages"];
let Locale: (typeof import("../app/locales"))["default"];

/** 真实 ui-lib:toast / 图片弹窗都直接断言它们落到 DOM 的产物 */
const bodyText = () => document.body.textContent ?? "";
const modalImages = () =>
  Array.from(document.querySelectorAll(".modal-mask img")) as HTMLImageElement[];

// ---- 文件 / 解码 / canvas 伪实现(可挂起,用于制造 PREPARING 窗口) ----

const PNG_A = `data:image/png;base64,${"A".repeat(64)}`;
const GIF_C = `data:image/gif;base64,${"C".repeat(48)}`;
const JPEG_OUT = `data:image/jpeg;base64,${"B".repeat(64)}`;

let readerHold = false;
let heldReaders: (() => void)[] = [];
let imageHold = false;
let heldImages: (() => void)[] = [];

class FakeFileReader {
  onload: ((event: unknown) => void) | null = null;
  onerror: (() => void) | null = null;
  result: string | undefined;

  readAsDataURL(file: Blob) {
    const dataUrl = (file as unknown as { __dataUrl?: string }).__dataUrl;
    if (typeof dataUrl !== "string") {
      throw new Error("测试文件未设置 __dataUrl");
    }
    this.result = dataUrl;
    const fire = () => this.onload?.({ target: { result: dataUrl } });
    if (readerHold) heldReaders.push(fire);
    else queueMicrotask(fire);
  }
}

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width = 1200;
  height = 900;

  set src(_value: string) {
    const fire = () => this.onload?.();
    if (imageHold) heldImages.push(fire);
    else queueMicrotask(fire);
  }
}

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.OPEN;
  closed = false;
  private handlers = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void) {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

class FakeIntersectionObserver {
  constructor(_callback: unknown, _options?: unknown) {}
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function releaseReaders() {
  readerHold = false;
  const list = heldReaders;
  heldReaders = [];
  list.forEach((fire) => fire());
}

function releaseImages() {
  imageHold = false;
  const list = heldImages;
  heldImages = [];
  list.forEach((fire) => fire());
}

// ---- 内存版后端 ----

interface RecordedCall {
  url: string;
  method: string;
  body?: any;
}

const calls: RecordedCall[] = [];
const server = {
  conversations: [] as BackendConversation[],
  messages: new Map<string, BackendMessage[]>(),
  nextConversationId: 1,
  nextRequestId: 1,
  nextMessageId: 1,
};

interface Hold {
  call: RecordedCall | null;
  promise: Promise<unknown>;
  release: (make: () => unknown) => void;
  match: (call: RecordedCall) => boolean;
}
const holds: Hold[] = [];

function holdCall(match: (call: RecordedCall) => boolean): Hold {
  let doRelease!: (response: unknown) => void;
  const promise = new Promise<unknown>((resolve) => {
    doRelease = resolve;
  });
  const hold: Hold = {
    call: null,
    promise,
    release: (make) => doRelease(make()),
    match,
  };
  holds.push(hold);
  return hold;
}

function sendConversationId(url: string): string | null {
  const match = /^\/backend-api\/conversations\/([^/?]+)\/messages$/.exec(url);
  return match ? match[1] : null;
}

const sendCalls = (conversationId?: string) =>
  calls.filter(
    (call) =>
      call.method === "POST" &&
      sendConversationId(call.url) !== null &&
      (conversationId === undefined ||
        sendConversationId(call.url) === conversationId),
  );

/** 挂起 POST /conversations/:id/messages(POST 在途窗口) */
const holdSend = (conversationId?: string) =>
  holdCall(
    (call) =>
      call.method === "POST" &&
      sendConversationId(call.url) !== null &&
      (conversationId === undefined ||
        sendConversationId(call.url) === conversationId),
  );

function reply(status: number, data?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data ?? null,
    headers: { get: () => null },
  };
}

function fail(status: number, code: string, message: string) {
  return reply(status, {
    error: { code, message, requestId: "r" },
  });
}

function conversation(id: string, minuteOffset = 1): BackendConversation {
  return {
    id,
    title: `${id} 会话`,
    status: "ACTIVE",
    provider: "gemini",
    providerConversationUrl: null,
    preferredModelKey: null,
    createdAt: STAMP,
    updatedAt: new Date(Date.parse(STAMP) - minuteOffset * 60_000).toISOString(),
    deletedAt: null,
  };
}

function backendMessage(
  id: string,
  conversationId: string,
  role: BackendMessageRole,
  content: string,
  position: number,
  extra: Partial<BackendMessage> = {},
): BackendMessage {
  return {
    id,
    conversationId,
    role,
    content,
    status: "COMPLETED",
    position,
    createdAt: STAMP,
    updatedAt: STAMP,
    request: null,
    ...extra,
  };
}

/** POST /messages 成功响应(request active + assistant PENDING → 应建立 SSE) */
function sendResponse(call: RecordedCall, conversationId: string) {
  const requestId = `r-${server.nextRequestId++}`;
  const existing = server.messages.get(conversationId) ?? [];
  const userMessage = backendMessage(
    `u-${server.nextMessageId++}`,
    conversationId,
    "USER",
    String(call.body?.content ?? ""),
    existing.length + 1,
  );
  const assistantMessage = backendMessage(
    `a-${server.nextMessageId++}`,
    conversationId,
    "ASSISTANT",
    "",
    existing.length + 2,
    {
      status: "PENDING",
      request: { id: requestId, status: "PENDING", errorCode: null, errorMessage: null },
    },
  );
  server.messages.set(conversationId, [...existing, userMessage, assistantMessage]);
  const request: BackendRequest = {
    id: requestId,
    conversationId,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    status: "PENDING",
    errorCode: null,
    errorMessage: null,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
  return reply(202, {
    data: { request, userMessage, assistantMessage, deduplicated: false },
  });
}

function encodeMessageCursor(position: number) {
  return btoa(JSON.stringify({ p: position }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeMessageCursor(raw: string): number {
  const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  return (JSON.parse(atob(base64)) as { p: number }).p;
}

/** PAG-2 同构分页(latest 只供 I3-MEM-03 的硬 reload bootstrap 使用) */
function messagePage(conversationId: string, params: URLSearchParams) {
  const limit = Number(params.get("limit")) || 50;
  const all = (server.messages.get(conversationId) ?? [])
    .slice()
    .sort((a, b) => a.position - b.position);
  const cursor = params.get("cursor");
  const pool = cursor
    ? all.filter((message) => message.position < decodeMessageCursor(cursor))
    : all;
  const desc = pool.slice().reverse();
  const hasMore = desc.length > limit;
  const page = desc.slice(0, limit).reverse();
  return reply(200, {
    data: page,
    meta: {
      nextCursor: hasMore ? encodeMessageCursor(page[0]!.position) : null,
      totalCount: all.length,
    },
  });
}

function route(call: RecordedCall) {
  const { url, method } = call;
  if (method === "GET" && url.startsWith("/backend-api/conversations?")) {
    return reply(200, {
      data: server.conversations,
      meta: { nextCursor: null },
    });
  }
  if (method === "POST" && url === "/backend-api/conversations") {
    const created: BackendConversation = {
      ...conversation(`c-new-${server.nextConversationId++}`),
      title: String(call.body?.title ?? "新会话"),
    };
    server.conversations = [created, ...server.conversations];
    return reply(201, { data: created });
  }
  const sendId = sendConversationId(url);
  if (method === "POST" && sendId) {
    return sendResponse(call, sendId);
  }
  const listMatch =
    /^\/backend-api\/conversations\/([^/?]+)\/messages\?(.*)$/.exec(url);
  if (method === "GET" && listMatch) {
    return messagePage(listMatch[1], new URLSearchParams(listMatch[2]));
  }
  if (method === "GET" && url === "/backend-api/browser/status") {
    return reply(200, {
      data: {
        state: "RUNNING",
        browserType: "chromium",
        headless: true,
        providerLoggedIn: true,
        activeRequests: 0,
        observedAt: STAMP,
      },
    });
  }
  if (method === "GET" && url === "/backend-api/provider/models") {
    return reply(200, { data: { models: [], currentModelKey: null } });
  }
  return fail(404, "NOT_FOUND", `未预期的请求 ${method} ${url}`);
}

// ---- store 会话种子 ----

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "c-1",
    topic: "附件会话",
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

function draftSession(id = "draft-d1"): ChatSession {
  return makeSession({ id, topic: "新对话", draft: true, loaded: true });
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

function sessionOf(id: string): ChatSession {
  const session = useChatStore.getState().sessions.find((s) => s.id === id);
  if (!session) throw new Error(`session ${id} 不存在`);
  return session;
}

// ---- DOM 工具 ----
// 注:本仓库 jest 未把 *.module.scss 映射成 identity-obj-proxy(styleMock 命中),
// 组件上的 CSS Module 类名在测试环境是空串 —— 一律按结构 / 语义属性定位。

/** composer(label[for=chat-input])内的托盘缩略图 */
const trayImages = () =>
  Array.from(
    composer().querySelectorAll('[style*="background-image"]'),
  ) as HTMLElement[];

const trayHasUrl = (url: string) =>
  trayImages().some((el) => (el.getAttribute("style") ?? "").includes(url));

/** 托盘删除按钮 = svg mock 透传出的 span(aria-label 随 UI 语言) */
const deleteIcons = () =>
  Array.from(
    composer().querySelectorAll(`span[aria-label="${Locale.Chat.Actions.Delete}"]`),
  ) as HTMLElement[];

function composer(): HTMLElement {
  const label = document.querySelector('label[for="chat-input"]');
  if (!label) throw new Error("composer 未找到");
  return label as HTMLElement;
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error("附件 file input 未找到");
  return input as HTMLInputElement;
}

/** Send / Stop 是 composer 内唯一带文字的角色按钮 */
function sendButton(): HTMLButtonElement {
  const texts = [Locale.Chat.Send, Locale.Chat.InputActions.Stop];
  const button = Array.from(document.querySelectorAll("button")).find((el) =>
    texts.includes(el.textContent ?? ""),
  );
  if (!button) throw new Error("Send 按钮未找到");
  return button as HTMLButtonElement;
}

const sendDisabled = () => sendButton().disabled;
const isStopButton = () =>
  sendButton().textContent === Locale.Chat.InputActions.Stop;

function pickerElement(): HTMLElement {
  const element =
    screen.queryByText(Locale.Chat.InputActions.UploadImage) ??
    screen.queryByText(Locale.Chat.ImagePreparing);
  if (!element) throw new Error("上传图片入口未找到");
  return element;
}

function textArea(): HTMLTextAreaElement {
  const textarea = document.querySelector("textarea");
  if (!textarea) throw new Error("输入框未找到");
  return textarea as HTMLTextAreaElement;
}

async function flush() {
  await act(async () => {
    await tick();
    await tick();
  });
}

async function renderChat() {
  render(
    <MemoryRouter>
      <Chat />
    </MemoryRouter>,
  );
  await flush();
}

/** 单张文件:真实 File + 伪造 size 与 dataURL(避免为上限用例分配真实大内存) */
function fileOf(
  name: string,
  type: string,
  size: number,
  dataUrl = PNG_A,
): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { configurable: true, value: size });
  (file as unknown as { __dataUrl: string }).__dataUrl = dataUrl;
  return file;
}

/** 与生产同构:readAsDataURL 结果经 decodedBytesOf 换算 */
function base64LengthOf(decodedBytes: number) {
  return Math.ceil(decodedBytes / 3) * 4;
}

async function pickFiles(files: File[]) {
  const input = fileInput();
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => {
    fireEvent.change(input);
    await tick();
  });
}

async function clickSend(times = 1) {
  await act(async () => {
    for (let i = 0; i < times; i += 1) {
      fireEvent.click(sendButton());
    }
    await tick();
  });
}

async function pressEnter() {
  await act(async () => {
    fireEvent.keyDown(textArea(), { key: "Enter" });
    await tick();
  });
}

async function switchTo(index: number) {
  await act(async () => {
    useChatStore.setState({ currentSessionIndex: index });
    await tick();
  });
}

async function releaseSend(hold: Hold, make?: () => unknown) {
  await act(async () => {
    hold.release(make ?? (() => route(hold.call!)));
    await tick();
    await tick();
  });
}

function localStorageHasInlineImage(): boolean {
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && (key.includes("data:image") || (localStorage.getItem(key) ?? "").includes("data:image"))) {
      return true;
    }
  }
  return false;
}

let inputClickSpy: jest.Mock;

beforeAll(() => {
  (globalThis as any).FileReader = FakeFileReader as unknown as typeof FileReader;
  (globalThis as any).Image = FakeImage as unknown as typeof Image;
  (globalThis as any).EventSource = FakeEventSource as unknown as typeof EventSource;
  (globalThis as any).IntersectionObserver = FakeIntersectionObserver;

  // jsdom 无 layout 与 canvas
  Element.prototype.scrollIntoView = () => {};
  (Element.prototype as any).scrollTo = () => {};
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get: () => 600,
  });
  const ctx = { fillStyle: "", fillRect: () => {}, drawImage: () => {} };
  (HTMLCanvasElement.prototype as any).getContext = () => ctx;
  (HTMLCanvasElement.prototype as any).toDataURL = () => JPEG_OUT;
});

beforeEach(async () => {
  calls.length = 0;
  holds.length = 0;
  server.conversations = [];
  server.messages = new Map();
  server.nextConversationId = 1;
  server.nextRequestId = 1;
  server.nextMessageId = 1;
  FakeEventSource.instances = [];
  readerHold = false;
  imageHold = false;
  heldReaders = [];
  heldImages = [];
  // 上一用例的图片弹窗(ui-lib 直接挂到 body)不得串场;toast 只按文本断言,
  // 不参与结构查询,故无需清理
  document.querySelectorAll(".modal-mask").forEach((modal) => modal.remove());
  inputClickSpy = jest
    .spyOn(HTMLInputElement.prototype, "click")
    .mockImplementation(() => {}) as unknown as jest.Mock;

  // fetch 必须早于任何 app 模块求值:prompt store 在模块 rehydrate 时就拉
  // ./prompts.json,错过窗口会留下真实的 unhandled rejection
  (globalThis as any).fetch = jest.fn(
    async (input: any, init: RequestInit = {}) => {
      const url = String(input);
      const method = String(init.method ?? "GET").toUpperCase();
      if (url.includes("prompts.json")) {
        return reply(200, { en: [], tw: [], cn: [] });
      }
      // plugin store 在 rehydrate 时拉 ./plugins.json(期望数组)
      if (url.includes("plugins.json")) {
        return reply(200, []);
      }
      const parsed =
        typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      const call: RecordedCall = { url, method, body: parsed };
      calls.push(call);
      const hold = holds.find((h) => h.call === null && h.match(call));
      if (hold) {
        hold.call = call;
        return hold.promise;
      }
      return route(call);
    },
  );

  ({ useChatStore } = await import("../app/store/chat"));
  ({ createEmptyMask } = await import("../app/store/mask"));
  ({ Chat } = await import("../app/components/chat"));
  ({ getMessageImages } = await import("../app/utils"));
  Locale = (await import("../app/locales")).default;

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
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---- I3-PREVIEW:托盘 ----

describe("I3-A 附件托盘(I3-PREVIEW)", () => {
  test("I3-PREVIEW-01 选中 n 张即渲染 n 张托盘缩略图,composer 进 attach 态", async () => {
    server.conversations = [conversation("c-1")];
    applySessions([makeSession()]);
    await renderChat();

    expect(trayImages()).toHaveLength(0);

    await pickFiles([
      fileOf("a.png", "image/png", 1024, PNG_A),
      fileOf("c.gif", "image/gif", 2048, GIF_C),
    ]);

    expect(trayImages()).toHaveLength(2);
    expect(trayHasUrl(PNG_A)).toBe(true);
    expect(trayHasUrl(GIF_C)).toBe(true);
    expect(sendDisabled()).toBe(false);
  });

  test("I3-PREVIEW-02 删除第 i 张:只移除该张,其余保持原顺序", async () => {
    server.conversations = [conversation("c-1")];
    applySessions([makeSession()]);
    await renderChat();

    const urlB = `data:image/png;base64,${"D".repeat(32)}`;
    await pickFiles([
      fileOf("a.png", "image/png", 1024, PNG_A),
      fileOf("b.png", "image/png", 1024, urlB),
      fileOf("c.gif", "image/gif", 2048, GIF_C),
    ]);
    expect(trayImages()).toHaveLength(3);

    await act(async () => {
      fireEvent.click(deleteIcons()[1]);
      await tick();
    });

    expect(trayImages()).toHaveLength(2);
    expect(trayHasUrl(PNG_A)).toBe(true);
    expect(trayHasUrl(urlB)).toBe(false);
    expect(trayHasUrl(GIF_C)).toBe(true);
  });

  test("I3-PREVIEW-03 点击缩略图调用 showImageModal(显示完整图)", async () => {
    server.conversations = [conversation("c-1")];
    applySessions([makeSession()]);
    await renderChat();

    await pickFiles([fileOf("a.png", "image/png", 1024, PNG_A)]);

    await act(async () => {
      fireEvent.click(trayImages()[0]);
      await tick();
    });
    await flush();

    expect(modalImages()).toHaveLength(1);
    expect(modalImages()[0].getAttribute("src")).toBe(PNG_A);
  });

  test("I3-PREVIEW-04 处理中语义:准备中删除仍可用 / POST 在途删除 disabled", async () => {
    server.conversations = [conversation("c-1")];
    applySessions([makeSession()]);
    await renderChat();

    await pickFiles([fileOf("a.png", "image/png", 1024, PNG_A)]);
    expect(trayImages()).toHaveLength(1);

    // 准备中(第二批挂起):设计只禁 Send / picker,托盘删除仍可用
    readerHold = true;
    await pickFiles([fileOf("b.png", "image/png", 1024, GIF_C)]);
    expect(deleteIcons()[0].getAttribute("aria-disabled")).toBeNull();
    await act(async () => {
      fireEvent.click(deleteIcons()[0]);
      await tick();
    });
    expect(trayImages()).toHaveLength(0);

    await act(async () => {
      releaseReaders();
      await tick();
    });
    expect(trayImages()).toHaveLength(1);

    // POST 在途:R35 托盘删除 disabled(点击无效)
    const hold = holdSend("c-1");
    await clickSend();
    expect(deleteIcons()[0].getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.click(deleteIcons()[0]);
      await tick();
    });
    expect(trayImages()).toHaveLength(1);

    await releaseSend(hold);
    expect(trayImages()).toHaveLength(0);
  });

  test("I3-PREVIEW-05 移动端 mask 常显(scss 静态检查,max-width 600px 下 opacity 1)", () => {
    const scss = fs.readFileSync("app/components/chat.module.scss", "utf8");
    const hoverRule = scss.indexOf(".attach-image-mask:hover");
    expect(hoverRule).toBeGreaterThanOrEqual(0);
    expect(scss.slice(hoverRule)).toMatch(
      /@media only screen and \(max-width: 600px\)\s*\{\s*\.attach-image \.attach-image-mask\s*\{\s*opacity: 1;/,
    );
  });
});

// ---- I3-PROCESS:准备期与批内限额 ----

describe("I3-A 准备期与批内限额(I3-PROCESS)", () => {
  test("I3-PROCESS-01 preparing 期间 Send 不可执行(disabled + 点击/回车均不发请求)", async () => {
    server.conversations = [conversation("c-1")];
    applySessions([makeSession()]);
    await renderChat();

    readerHold = true;
    await pickFiles([fileOf("a.png", "image/png", 1024, PNG_A)]);

    expect(sendDisabled()).toBe(true);
    expect(
      screen.queryByText(Locale.Chat.ImagePreparing),
    ).not.toBeNull();

    await clickSend();
    await pressEnter();

    expect(sendCalls()).toHaveLength(0);
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    await act(async () => {
      releaseReaders();
      await tick();
    });
    expect(trayImages()).toHaveLength(1);
    expect(sendDisabled()).toBe(false);
  });

  test("I3-PROCESS-02 preparing 期间 picker 不可用(不触发第二次文件选择)", async () => {
    server.conversations = [conversation("c-1")];
    applySessions([makeSession()]);
    await renderChat();

    readerHold = true;
    await pickFiles([fileOf("a.png", "image/png", 1024, PNG_A)]);
    expect(inputClickSpy).toHaveBeenCalledTimes(0);

    await act(async () => {
      fireEvent.click(pickerElement());
      await tick();
    });
    expect(inputClickSpy).toHaveBeenCalledTimes(0);

    await act(async () => {
      releaseReaders();
      await tick();
    });
    expect(trayImages()).toHaveLength(1);

    await act(async () => {
      fireEvent.click(pickerElement());
      await tick();
    });
    expect(inputClickSpy).toHaveBeenCalledTimes(1);
  });

  test("I3-PROCESS-03 批内单张失败只拒该张:提示 + 其余继续入列(R28)", async () => {
    server.conversations = [conversation("c-1")];
    applySessions([makeSession()]);
    await renderChat();

    await pickFiles([
      fileOf("ok1.png", "image/png", 1024, PNG_A),
      fileOf("bad.png", "image/png", 1024, "data:text/plain;base64,AAAA"),
      fileOf("ok2.gif", "image/gif", 2048, GIF_C),
    ]);
    await flush();

    expect(trayImages()).toHaveLength(2);
    expect(trayHasUrl(PNG_A)).toBe(true);
    expect(trayHasUrl(GIF_C)).toBe(true);
    expect(bodyText()).toContain(Locale.Chat.ImageTypeUnsupported);
  });

  test("I3-PROCESS-04 批内限额:超 4 张只留前 4 张;总量超 10MiB 跳过该张", async () => {
    server.conversations = [conversation("c-1")];
    applySessions([makeSession()]);
    await renderChat();

    await pickFiles([
      fileOf("1.png", "image/png", 1024, PNG_A),
      fileOf("2.png", "image/png", 1024, PNG_A),
      fileOf("3.png", "image/png", 1024, PNG_A),
      fileOf("4.png", "image/png", 1024, PNG_A),
      fileOf("5.png", "image/png", 1024, PNG_A),
    ]);
    expect(trayImages()).toHaveLength(4);
    await flush();
    expect(bodyText()).toContain(Locale.Chat.ImageCountExceeded);

    // 3 张 3.5MiB(decoded)同图:前两张合计 7MiB 通过,第三张触发总量上限
    const decoded = 3_670_016;
    const bigPng = `data:image/png;base64,${"E".repeat(
      base64LengthOf(decoded),
    )}`;
    await act(async () => {
      for (const icon of deleteIcons()) {
        fireEvent.click(icon);
      }
      await tick();
    });
    expect(trayImages()).toHaveLength(0);

    await pickFiles([
      fileOf("big1.png", "image/png", 4096, bigPng),
      fileOf("big2.png", "image/png", 4096, bigPng),
      fileOf("big3.png", "image/png", 4096, bigPng),
    ]);
    await flush();
    expect(trayImages()).toHaveLength(2);
    expect(bodyText()).toContain(Locale.Chat.ImageTotalExceeded);
  });

  test("I3-PROCESS-05 pendingRequestId 阶段(Stop):upload 入口不可用,hidden input 不被触发", async () => {
    server.conversations = [conversation("c-1")];
    applySessions([makeSession()]);
    await renderChat();
    await pickFiles([fileOf("a.png", "image/png", 1024, PNG_A)]);
    expect(trayImages()).toHaveLength(1);

    // 正控:空闲时入口可用,点击恰触发 1 次 input.click
    await act(async () => {
      fireEvent.click(pickerElement());
      await tick();
    });
    expect(inputClickSpy).toHaveBeenCalledTimes(1);

    // 发送成功 → accepted → pendingRequestId 接管(Stop 阶段)
    const hold = holdSend("c-1");
    await clickSend();
    expect(sendCalls("c-1")).toHaveLength(1);
    await releaseSend(hold);
    expect(sessionOf("c-1").pendingRequestId).toBe("r-1");
    expect(isStopButton()).toBe(true);

    // Stop 阶段:picker 不可用(不改附件,不触发文件选择)
    await act(async () => {
      fireEvent.click(pickerElement());
      await tick();
    });
    expect(inputClickSpy).toHaveBeenCalledTimes(1);
  });
});

// ---- I3-SUBMIT:POST 在途 ----

describe("I3-A POST 在途(I3-SUBMIT)", () => {
  test("I3-SUBMIT-01 POST 挂起 + 双击/回车连发 → sendMessage 恰 1 次", async () => {
    server.conversations = [conversation("c-1")];
    applySessions([makeSession()]);
    await renderChat();
    await pickFiles([fileOf("a.png", "image/png", 1024, PNG_A)]);

    const hold = holdSend("c-1");
    await act(async () => {
      const button = sendButton();
      button.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      button.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      fireEvent.keyDown(textArea(), { key: "Enter" });
      await tick();
    });

    expect(sendCalls("c-1")).toHaveLength(1);
    expect(sendCalls("c-1")[0].body.attachments).toEqual([
      { name: "a.png", mimeType: "image/png", data: PNG_A },
    ]);
    expect(trayImages()).toHaveLength(1);
    expect(sendDisabled()).toBe(true);

    await releaseSend(hold);

    expect(trayImages()).toHaveLength(0);
    expect(isStopButton()).toBe(true);
    expect(sessionOf("c-1").pendingRequestId).toBe("r-1");
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  test("I3-SUBMIT-02 POST 在途期间 picker 与托盘删除均不可修改附件", async () => {
    server.conversations = [conversation("c-1")];
    applySessions([makeSession()]);
    await renderChat();
    await pickFiles([fileOf("a.png", "image/png", 1024, PNG_A)]);

    const hold = holdSend("c-1");
    await clickSend();
    expect(sendCalls("c-1")).toHaveLength(1);

    await act(async () => {
      fireEvent.click(pickerElement());
      fireEvent.click(deleteIcons()[0]);
      await tick();
    });
    expect(inputClickSpy).toHaveBeenCalledTimes(0);
    expect(trayImages()).toHaveLength(1);

    await clickSend();
    expect(sendCalls("c-1")).toHaveLength(1);

    await releaseSend(hold);
    expect(trayImages()).toHaveLength(0);
  });

  test("I3-SUBMIT-03 A POST 在途 → 切 B → A resolve 后 B 的 pending/submitting 不被修改", async () => {
    server.conversations = [conversation("c-1"), conversation("c-2", 0)];
    applySessions([makeSession({ id: "c-1" }), makeSession({ id: "c-2" })]);
    await renderChat();
    await pickFiles([fileOf("a.png", "image/png", 1024, PNG_A)]);

    const hold = holdSend("c-1");
    await clickSend();
    expect(sendCalls("c-1")).toHaveLength(1);

    await switchTo(1);
    expect(sessionOf("c-2").id).toBe("c-2");
    expect(trayImages()).toHaveLength(0);
    expect(sendDisabled()).toBe(false);

    await releaseSend(hold);

    // A 的 continuation 已 resolve:不得动 B 的附件态,也不得把 A 的图片塞进 B
    expect(trayImages()).toHaveLength(0);
    expect(sendDisabled()).toBe(false);
    expect(sessionOf("c-2").pendingRequestId).toBeUndefined();
    expect(
      sessionOf("c-2").messages.every((m) => getMessageImages(m).length === 0),
    ).toBe(true);
    // A 自身在 store 层照常收口(组件不再展示而已)
    expect(sessionOf("c-1").pendingRequestId).toBe("r-1");
  });
});

// ---- I3-DRAFT:草稿 promotion ----

describe("I3-A 草稿 promotion(I3-DRAFT)", () => {
  test("I3-DRAFT-01 草稿首发:draft-id→real-id 的 _Chat remount 不清附件/preparing/submitting", async () => {
    applySessions([draftSession()]);
    await renderChat();
    await pickFiles([fileOf("a.png", "image/png", 1024, PNG_A)]);
    expect(trayImages()).toHaveLength(1);

    const hold = holdSend("c-new-1");
    await clickSend();

    // ensureConversation 已落地 → remount 发生,POST 仍挂起
    expect(sessionOf("c-new-1").draft).toBe(false);
    expect(sessionOf("c-new-1").loaded).toBe(true);
    expect(trayImages()).toHaveLength(1);
    expect(trayHasUrl(PNG_A)).toBe(true);
    expect(sendDisabled()).toBe(true);
    expect(isStopButton()).toBe(false);

    await act(async () => {
      fireEvent.click(pickerElement());
      fireEvent.click(deleteIcons()[0]);
      await tick();
    });
    expect(inputClickSpy).toHaveBeenCalledTimes(0);
    expect(trayImages()).toHaveLength(1);

    await releaseSend(hold);
    expect(trayImages()).toHaveLength(0);
    expect(isStopButton()).toBe(true);
  });

  test("I3-DRAFT-02 promotion 后 POST 同步失败:真实会话保留 + pending 保留 + 可再次发送", async () => {
    applySessions([draftSession()]);
    await renderChat();
    await pickFiles([fileOf("a.png", "image/png", 1024, PNG_A)]);

    const hold = holdSend("c-new-1");
    await clickSend();
    await releaseSend(hold, () =>
      fail(503, "ATTACHMENT_CAPACITY_EXCEEDED", "附件队列已满"),
    );

    expect(sessionOf("c-new-1").draft).toBe(false);
    expect(sessionOf("c-new-1").messages.some((m) => m.isError)).toBe(true);
    expect(
      sessionOf("c-new-1").messages.find((m) => m.isError)!.errorCode,
    ).toBe("ATTACHMENT_CAPACITY_EXCEEDED");
    expect(trayImages()).toHaveLength(1);
    expect(sendDisabled()).toBe(false);
    expect(isStopButton()).toBe(false);

    await clickSend();
    expect(sendCalls("c-new-1")).toHaveLength(2);
  });

  test("I3-DRAFT-03 promotion 后 POST 仍挂起:连续触发不重开双击窗口(总 POST 恰 1)", async () => {
    applySessions([draftSession()]);
    await renderChat();
    await pickFiles([fileOf("a.png", "image/png", 1024, PNG_A)]);

    const hold = holdSend("c-new-1");
    await clickSend();
    expect(sendCalls("c-new-1")).toHaveLength(1);

    await act(async () => {
      const button = sendButton();
      button.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      button.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      fireEvent.keyDown(textArea(), { key: "Enter" });
      await tick();
    });
    expect(sendCalls("c-new-1")).toHaveLength(1);

    await releaseSend(hold);
    expect(sendCalls("c-new-1")).toHaveLength(1);
  });

  test("I3-DRAFT-04 promotion 后 POST accepted:pending 清空 + USER 图片注入 + Stop 接管", async () => {
    applySessions([draftSession()]);
    await renderChat();
    await pickFiles([fileOf("a.png", "image/png", 1024, PNG_A)]);

    const hold = holdSend("c-new-1");
    await clickSend();
    await releaseSend(hold);

    expect(trayImages()).toHaveLength(0);
    expect(isStopButton()).toBe(true);
    expect(sendDisabled()).toBe(false);
    expect(sessionOf("c-new-1").pendingRequestId).toBe("r-1");

    const userMessage = sessionOf("c-new-1").messages.find(
      (m) => m.role === "user",
    )!;
    expect(getMessageImages(userMessage)).toEqual([PNG_A]);
    expect(userMessage.content).toEqual([
      { type: "image_url", image_url: { url: PNG_A } },
    ]);

    const rendered = Array.from(document.querySelectorAll("img")).map((img) =>
      img.getAttribute("src"),
    );
    expect(rendered).toContain(PNG_A);
  });
});

// ---- I3-MEM-CONV:跨会话竞态 ----

describe("I3-A 跨会话竞态(I3-MEM-CONV)", () => {
  test("I3-MEM-CONV-01 慢压缩期间切会话:旧结果不得进入新会话", async () => {
    server.conversations = [conversation("c-1"), conversation("c-2", 0)];
    applySessions([makeSession({ id: "c-1" }), makeSession({ id: "c-2" })]);
    await renderChat();

    imageHold = true;
    await pickFiles([fileOf("big.png", "image/png", 600 * 1024, PNG_A)]);
    expect(screen.queryByText(Locale.Chat.ImagePreparing)).not.toBeNull();

    await switchTo(1);
    expect(trayImages()).toHaveLength(0);
    expect(screen.queryByText(Locale.Chat.ImagePreparing)).toBeNull();

    expect(heldImages).toHaveLength(1);
    await act(async () => {
      releaseImages();
      await tick();
      await tick();
    });

    // 旧 continuation 已 resolve:仍不得进入 B
    expect(trayImages()).toHaveLength(0);
    expect(screen.queryByText(Locale.Chat.ImagePreparing)).toBeNull();
    expect(sendDisabled()).toBe(false);
  });
});

// ---- I3-MEM:附件状态的生命周期 ----

describe("I3-A 附件状态生命周期(I3-MEM)", () => {
  test("I3-MEM-01 切会话清空且不随切回恢复", async () => {
    server.conversations = [conversation("c-1"), conversation("c-2", 0)];
    applySessions([makeSession({ id: "c-1" }), makeSession({ id: "c-2" })]);
    await renderChat();
    await pickFiles([fileOf("a.png", "image/png", 1024, PNG_A)]);
    expect(trayImages()).toHaveLength(1);

    await switchTo(1);
    expect(trayImages()).toHaveLength(0);

    await switchTo(0);
    expect(trayImages()).toHaveLength(0);
    expect(sendDisabled()).toBe(false);
  });

  test("I3-MEM-02 卸载不写 localStorage / IndexedDB(附件只在内存)", async () => {
    server.conversations = [conversation("c-1")];
    applySessions([makeSession()]);
    const view = render(
      <MemoryRouter>
        <Chat />
      </MemoryRouter>,
    );
    await flush();
    await pickFiles([fileOf("a.png", "image/png", 1024, PNG_A)]);
    expect(trayImages()).toHaveLength(1);

    view.unmount();

    expect(localStorageHasInlineImage()).toBe(false);
    expect(typeof (globalThis as any).indexedDB).toBe("undefined");
  });

  test("I3-MEM-03 硬 reload(store 重建)后无本地注入副本:同页 refresh 之外不保图", async () => {
    server.conversations = [conversation("c-1")];
    server.messages.set("c-1", [
      backendMessage("m-1", "c-1", "USER", "", 1),
      backendMessage("m-2", "c-1", "ASSISTANT", "回答", 2),
    ]);
    applySessions([makeSession()]);
    await renderChat();
    await pickFiles([fileOf("a.png", "image/png", 1024, PNG_A)]);
    expect(localStorageHasInlineImage()).toBe(false);

    // 模拟 page reload:内存全丢,应用从后端重新 bootstrap
    useChatStore.setState({
      sessions: [],
      currentSessionIndex: 0,
      ready: false,
    } as any);
    await act(async () => {
      await useChatStore.getState().bootstrap();
      await useChatStore.getState().loadSessionMessages("c-1");
      await tick();
    });

    const reloaded = sessionOf("c-1");
    expect(reloaded.messages.length).toBeGreaterThan(0);
    expect(
      reloaded.messages.every((m) => getMessageImages(m).length === 0),
    ).toBe(true);
    expect(JSON.stringify(reloaded.messages)).not.toContain("data:image");
  });
});
