import { jest } from "@jest/globals";
import {
  BACKEND_MODEL_LABEL,
  ChatSession,
  errorTextForCode,
  useChatStore,
} from "../app/store/chat";
import { StoreKey } from "../app/constant";
import { indexedDBStorage } from "../app/utils/indexedDB-storage";
import type {
  BackendConversation,
  BackendMessage,
  BackendMessageRole,
  BackendRequest,
  ConversationStatus,
} from "../app/client/backend-api";

/**
 * 第 7 阶段验收用例(§十一)。
 *
 * 这里不 mock chat store 依赖的函数,而是从最外层伪造 HTTP 与 SSE:
 * fetch 走一个内存版后端,EventSource 走 FakeEventSource,
 * 这样 API Client 的信封解析、状态映射和 store 行为被一起覆盖。
 */

const STAMP = "2026-09-03T00:00:00.000Z";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function conversation(
  id: string,
  title: string,
  status: ConversationStatus | "DELETED" = "ACTIVE",
): BackendConversation {
  return {
    id,
    title,
    status,
    provider: "gemini",
    providerConversationUrl: null,
    preferredModelKey: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: status === "DELETED" ? STAMP : null,
  };
}

function message(
  id: string,
  conversationId: string,
  role: BackendMessageRole,
  content: string,
  extra: Partial<BackendMessage> = {},
): BackendMessage {
  return {
    id,
    conversationId,
    role,
    content,
    status: "COMPLETED",
    position: 0,
    createdAt: STAMP,
    updatedAt: STAMP,
    request: null,
    ...extra,
  };
}

function request(
  id: string,
  conversationId: string,
  userMessageId: string,
  assistantMessageId: string,
  status: BackendRequest["status"] = "PENDING",
): BackendRequest {
  return {
    id,
    conversationId,
    userMessageId,
    assistantMessageId,
    status,
    errorCode: null,
    errorMessage: null,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.OPEN;
  closed = false;
  private handlers = new Map<string, ((event: any) => void)[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: any) => void) {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  /** data 为 undefined 时模拟传输层错误(原生 Event,没有 data 字段) */
  emit(type: string, data?: unknown) {
    const event: any = { type };
    if (data !== undefined) event.data = JSON.stringify(data);
    (this.handlers.get(type) ?? []).forEach((handler) => handler(event));
  }
}

function lastSource(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("没有建立 SSE 订阅");
  return source;
}

function statusFrame(
  requestId: string,
  frame: Partial<{
    status: BackendMessage["status"] | null;
    requestStatus: BackendRequest["status"];
    errorCode: string | null;
    errorMessage: string | null;
  }>,
) {
  return { requestId, status: null, requestStatus: "PROCESSING", ...frame };
}

interface RecordedCall {
  url: string;
  method: string;
  body?: any;
  headers: Record<string, string>;
}

const calls: RecordedCall[] = [];
const server = {
  conversations: [] as BackendConversation[],
  messages: new Map<string, BackendMessage[]>(),
  sendSeq: 0,
  /** PAG-1:设置后 fake 服务器按 keyset 分页返回(默认 null = 旧用例一次性全量,行为不变) */
  pageSize: null as number | null,
};

function listQuery(call: RecordedCall): URLSearchParams | null {
  if (call.method !== "GET") return null;
  const match = /^\/backend-api\/conversations\?(.*)$/.exec(call.url);
  return match ? new URLSearchParams(match[1]) : null;
}

const listCalls = () => calls.filter((c) => listQuery(c) !== null);

/**
 * PAG-1:挂起匹配的列表请求,由测试手动放行,用来构造 in-flight 竞态。
 * release 的入参是响应工厂,放行那一刻才求值(可读到当时的 server 状态)。
 */
interface Hold {
  call: RecordedCall | null;
  promise: Promise<any>;
  release: (make: () => any) => void;
}
const holds: (Hold & { match: (call: RecordedCall) => boolean })[] = [];

function holdList(match: (params: URLSearchParams) => boolean): Hold {
  let doRelease!: (response: any) => void;
  const promise = new Promise<any>((resolve) => {
    doRelease = resolve;
  });
  const hold: Hold & { match: (call: RecordedCall) => boolean } = {
    call: null,
    promise,
    release: (make) => doRelease(make()),
    match: (call) => {
      const params = listQuery(call);
      return params !== null && match(params);
    },
  };
  holds.push(hold);
  return hold;
}

function resetServer() {
  server.conversations = [];
  server.messages = new Map();
  server.sendSeq = 0;
  server.pageSize = null;
  calls.length = 0;
  holds.length = 0;
  FakeEventSource.instances = [];
}

/** PAG-1:与后端 ORDER BY updatedAt DESC, id DESC 一致的排序 */
function sortedByRecency(list: BackendConversation[]) {
  return [...list].sort((a, b) =>
    a.updatedAt !== b.updatedAt ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.id < b.id ? 1 : -1,
  );
}

function encodeCursorOf(item: BackendConversation) {
  return btoa(JSON.stringify({ u: item.updatedAt, i: item.id }));
}

/** PAG-1:按 keyset(updatedAt, id)切页,nextCursor 规则与后端一致(整页才给 cursor) */
function listPage(params: URLSearchParams) {
  const status = params.get("status");
  const all = sortedByRecency(
    server.conversations.filter((c) => c.status === status),
  );
  let start = 0;
  const cursor = params.get("cursor");
  if (cursor) {
    const key = JSON.parse(atob(cursor)) as { u: string; i: string };
    start = all.findIndex((c) => c.updatedAt === key.u && c.id === key.i) + 1;
  }
  const limit = server.pageSize ?? (Number(params.get("limit")) || 50);
  const items = all.slice(start, start + limit);
  return {
    items,
    nextCursor:
      items.length === limit ? encodeCursorOf(items[items.length - 1]) : null,
  };
}

/** PAG-1:批量造会话,updatedAt 按分钟递减(p-1 最新),与 POST 创建的 STAMP 会话不并列 */
function seedConversations(
  count: number,
  prefix: string,
  status: ConversationStatus = "ACTIVE",
): BackendConversation[] {
  const list = Array.from({ length: count }, (_, k) => ({
    ...conversation(`${prefix}-${k + 1}`, `${prefix} ${k + 1}`, status),
    updatedAt: new Date(Date.parse(STAMP) - (k + 1) * 60_000).toISOString(),
  }));
  server.conversations.push(...list);
  return list;
}

/** PAG-1:此刻服务端第一页的响应(与 route 分页分支同构) */
function firstPageReply(status: ConversationStatus) {
  const { items, nextCursor } = listPage(new URLSearchParams({ status }));
  return reply(200, { data: items, meta: { nextCursor } });
}

/** PAG-1:第 page 页(1 起)的响应,与 keyset 翻页序列一致 */
function pageReply(status: ConversationStatus, page: number) {
  const limit = server.pageSize ?? 50;
  const all = sortedByRecency(
    server.conversations.filter((c) => c.status === status),
  );
  const items = all.slice((page - 1) * limit, page * limit);
  const nextCursor =
    items.length === limit ? encodeCursorOf(items[items.length - 1]) : null;
  return reply(200, { data: items, meta: { nextCursor } });
}

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

function route(url: string, method: string, body: any): any {
  const listMatch = /^\/backend-api\/conversations\?(.*)$/.exec(url);
  if (listMatch && method === "GET") {
    const params = new URLSearchParams(listMatch[1]);
    if (server.pageSize === null) {
      const status = params.get("status");
      return reply(200, {
        data: server.conversations.filter((c) => c.status === status),
        meta: { nextCursor: null },
      });
    }
    const { items, nextCursor } = listPage(params);
    return reply(200, { data: items, meta: { nextCursor } });
  }

  if (url === "/backend-api/conversations" && method === "POST") {
    const seq = server.conversations.length + 1;
    const created = conversation(`c-${seq}`, body?.title ?? `会话 ${seq}`);
    server.conversations.unshift(created);
    return reply(201, { data: created });
  }

  const itemMatch = /^\/backend-api\/conversations\/([^/?]+)$/.exec(url);
  if (itemMatch) {
    const id = itemMatch[1];
    const index = server.conversations.findIndex((c) => c.id === id);
    if (index < 0) return fail(404, "CONVERSATION_NOT_FOUND", "not found");
    const target = server.conversations[index];

    if (method === "DELETE") {
      server.conversations.splice(index, 1);
      server.messages.delete(id);
      return { ok: true, status: 204, json: async () => null };
    }
    if (method === "PATCH") {
      server.conversations[index] = {
        ...target,
        ...(body?.title ? { title: body.title } : {}),
        ...(body?.status ? { status: body.status } : {}),
      };
      return reply(200, { data: server.conversations[index] });
    }
    if (method === "GET") return reply(200, { data: target });
  }

  const messagesMatch =
    /^\/backend-api\/conversations\/([^/?]+)\/messages$/.exec(url);
  if (messagesMatch) {
    const id = messagesMatch[1];
    if (method === "GET")
      return reply(200, { data: server.messages.get(id) ?? [] });

    const seq = ++server.sendSeq;
    const userMessageId = `msg-user-${seq}`;
    const assistantMessageId = `msg-assistant-${seq}`;
    const requestId = `req-${seq}`;
    const content = body?.content ?? "";
    const userMessage = message(userMessageId, id, "USER", content);
    const assistantMessage = message(assistantMessageId, id, "ASSISTANT", "", {
      status: "PENDING",
      request: {
        id: requestId,
        status: "PENDING",
        errorCode: null,
        errorMessage: null,
      },
    });
    server.messages.set(id, [
      ...(server.messages.get(id) ?? []),
      userMessage,
      assistantMessage,
    ]);
    return reply(201, {
      data: {
        request: request(requestId, id, userMessageId, assistantMessageId),
        userMessage,
        assistantMessage,
        deduplicated: false,
      },
    });
  }

  return fail(404, "NOT_FOUND", `未预期的请求 ${method} ${url}`);
}

function resetStore() {
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
  });
}

function activeSession(): ChatSession {
  const state = useChatStore.getState();
  return state.sessions[state.currentSessionIndex];
}

function assistantMessage(): ChatSession["messages"][number] {
  const messages = activeSession().messages;
  return messages[messages.length - 1];
}

beforeEach(() => {
  resetServer();
  resetStore();
  localStorage.clear();
  (globalThis as any).EventSource = FakeEventSource;
  (globalThis as any).fetch = jest.fn(
    async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      const method = String(init.method ?? "GET").toUpperCase();
      const parsed =
        typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      const call: RecordedCall = {
        url,
        method,
        body: parsed,
        headers: (init.headers ?? {}) as Record<string, string>,
      };
      calls.push(call);
      const hold = holds.find((h) => h.call === null && h.match(call));
      if (hold) {
        hold.call = call;
        return hold.promise;
      }
      return route(url, method, parsed);
    },
  );
});

describe("第 7 阶段:NextChat 以 Backend API 为唯一聊天数据源", () => {
  test("① 首屏从后端加载会话列表,默认只取 ACTIVE", async () => {
    server.conversations = [
      conversation("c-1", "第一个会话"),
      conversation("c-2", "第二个会话"),
      conversation("c-3", "归档会话", "ARCHIVED"),
    ];

    await useChatStore.getState().bootstrap();
    await tick();

    const state = useChatStore.getState();
    expect(state.ready).toBe(true);
    expect(state.listStatus).toBe("ACTIVE");
    expect(state.sessions.map((s) => s.id)).toEqual(["c-1", "c-2"]);
    expect(state.sessions[0].topic).toBe("第一个会话");
    expect(calls[0].url).toContain(
      "/backend-api/conversations?status=ACTIVE&limit=50",
    );
    // 打开的会话才拉消息,列表里的其他会话保持未加载
    expect(
      calls.some(
        (c) =>
          c.method === "GET" &&
          c.url === "/backend-api/conversations/c-1/messages",
      ),
    ).toBe(true);
    expect(state.sessions[0].loaded).toBe(true);
    expect(state.sessions[1].loaded).toBe(false);
    expect(
      calls.some((c) => c.url === "/backend-api/conversations/c-3/messages"),
    ).toBe(false);
  });

  test("② 发送消息:草稿会话先建 Conversation,再带 Idempotency-Key POST", async () => {
    await useChatStore.getState().bootstrap();
    await tick();
    expect(activeSession().draft).toBe(true);

    await useChatStore.getState().onUserInput("hello gemini");
    await tick();

    const created = calls.find(
      (c) => c.method === "POST" && c.url === "/backend-api/conversations",
    );
    expect(created?.body).toEqual({ title: "hello gemini" });

    const send = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/messages"),
    );
    expect(send?.url).toBe("/backend-api/conversations/c-1/messages");
    expect(send?.body).toEqual({ content: "hello gemini" });
    expect(send?.headers["Idempotency-Key"]).toMatch(/^web-/);

    const session = activeSession();
    expect(session.draft).toBe(false);
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[0].content).toBe("hello gemini");
    expect(session.messages[1].streaming).toBe(true);
    expect(session.pendingRequestId).toBe("req-1");
    expect(lastSource().url).toBe("/backend-api/requests/req-1/events");
  });

  test("③ delta 帧是本连接已发文本的后缀增量,短增量同样不能丢", async () => {
    await useChatStore.getState().bootstrap();
    await useChatStore.getState().onUserInput("hi");
    await tick();

    const source = lastSource();
    source.emit("delta", { content: "一致性哈希把节点映射到哈希环上," });
    source.emit("delta", { content: "扩缩容" });
    source.emit("delta", { content: "只影响相邻" });
    source.emit("delta", { content: "节点。" });

    const answer = assistantMessage();
    expect(answer.content).toBe(
      "一致性哈希把节点映射到哈希环上,扩缩容只影响相邻节点。",
    );
    expect(answer.streaming).toBe(true);
    expect(activeSession().messages).toHaveLength(2);

    // 快照帧是整段文本,按前缀覆盖而非追加
    source.emit("snapshot", { content: `${answer.content}以上为快照。` });
    expect(assistantMessage().content).toBe(
      "一致性哈希把节点映射到哈希环上,扩缩容只影响相邻节点。以上为快照。",
    );
  });

  test("④ 终态帧落定:SUCCESS 完成,FAILED 展示错误码文案", async () => {
    await useChatStore.getState().bootstrap();
    await useChatStore.getState().onUserInput("hi");
    await tick();

    const source = lastSource();
    source.emit("delta", { content: "部分回答" });
    source.emit(
      "status",
      statusFrame("req-1", { status: "COMPLETED", requestStatus: "SUCCESS" }),
    );
    await tick();

    const done = assistantMessage();
    expect(done.content).toBe("部分回答");
    expect(done.streaming).toBe(false);
    expect(done.isError).toBe(false);
    expect(source.closed).toBe(true);
    expect(activeSession().pendingRequestId).toBeUndefined();

    await useChatStore.getState().onUserInput("再来一次");
    await tick();
    const second = lastSource();
    second.emit(
      "status",
      statusFrame("req-2", {
        status: "FAILED",
        requestStatus: "FAILED",
        errorCode: "PROVIDER_LOGIN_REQUIRED",
      }),
    );
    await tick();

    const failed = assistantMessage();
    expect(failed.streaming).toBe(false);
    expect(failed.isError).toBe(true);
    expect(failed.errorCode).toBe("PROVIDER_LOGIN_REQUIRED");
    expect(errorTextForCode(failed.errorCode)).toBe(
      "Gemini 未登录,请在服务端浏览器里重新登录",
    );
  });

  test("⑤ 刷新后从后端恢复历史消息", async () => {
    server.conversations = [conversation("c-9", "历史会话")];
    server.messages.set("c-9", [
      message("m-1", "c-9", "USER", "上一个问题"),
      message("m-2", "c-9", "ASSISTANT", "后端保存的回答", {
        request: {
          id: "req-old",
          status: "SUCCESS",
          errorCode: null,
          errorMessage: null,
        },
      }),
    ]);

    resetStore();
    await useChatStore.getState().bootstrap();
    await tick();

    const session = activeSession();
    expect(session.loaded).toBe(true);
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[1].content).toBe("后端保存的回答");
    expect(session.messages[1].streaming).toBe(false);
    expect(session.messages[1].model).toBe(BACKEND_MODEL_LABEL);
    expect(session.pendingRequestId).toBeUndefined();
  });

  test("⑥ 刷新后自动续接执行中的 Request", async () => {
    server.conversations = [conversation("c-9", "进行中")];
    server.messages.set("c-9", [
      message("m-1", "c-9", "USER", "还在回答的问题"),
      message("m-2", "c-9", "ASSISTANT", "已经", {
        status: "STREAMING",
        request: {
          id: "req-9",
          status: "PROCESSING",
          errorCode: null,
          errorMessage: null,
        },
      }),
    ]);

    resetStore();
    await useChatStore.getState().bootstrap();
    await tick();

    expect(assistantMessage().streaming).toBe(true);
    expect(activeSession().pendingRequestId).toBe("req-9");
    expect(lastSource().url).toBe("/backend-api/requests/req-9/events");

    // 重连首帧是整段快照,直接覆盖即可自愈
    lastSource().emit("snapshot", { content: "已经生成的内容" });
    expect(assistantMessage().content).toBe("已经生成的内容");

    lastSource().emit(
      "status",
      statusFrame("req-9", { status: "COMPLETED", requestStatus: "SUCCESS" }),
    );
    await tick();
    expect(assistantMessage().streaming).toBe(false);
  });

  test("⑦ 删除会话直接打到后端且立即生效,没有 5 秒撤销", async () => {
    server.conversations = [
      conversation("c-1", "删掉我"),
      conversation("c-2", "留下我"),
    ];
    await useChatStore.getState().bootstrap();
    await tick();

    await useChatStore.getState().deleteSession(0);
    await tick();

    expect(
      calls.some(
        (c) =>
          c.method === "DELETE" && c.url === "/backend-api/conversations/c-1",
      ),
    ).toBe(true);
    const state = useChatStore.getState();
    expect(state.sessions.map((s) => s.id)).toEqual(["c-2"]);
    expect(state.sessions.find((s) => s.id === "c-1")).toBeUndefined();
    expect(server.conversations.map((c) => c.id)).toEqual(["c-2"]);

    // 草稿会话从未进过后端,删除不该发请求
    const before = calls.length;
    useChatStore.getState().newSession();
    await useChatStore.getState().deleteSession(0);
    expect(calls.slice(before).some((c) => c.method === "DELETE")).toBe(false);
  });

  test("⑧ 归档与恢复:PATCH status,列表在 ACTIVE / ARCHIVED 间切换", async () => {
    server.conversations = [conversation("c-1", "要归档的会话")];
    await useChatStore.getState().bootstrap();
    await tick();

    await useChatStore.getState().archiveSession(0);
    await tick();
    expect(
      calls.some(
        (c) =>
          c.method === "PATCH" &&
          c.url === "/backend-api/conversations/c-1" &&
          c.body.status === "ARCHIVED",
      ),
    ).toBe(true);
    expect(activeSession().draft).toBe(true);

    await useChatStore.getState().switchListStatus("ARCHIVED");
    await tick();
    expect(
      calls.some((c) =>
        c.url.includes("/backend-api/conversations?status=ARCHIVED"),
      ),
    ).toBe(true);
    const archivedIndex = useChatStore
      .getState()
      .sessions.findIndex((s) => s.id === "c-1");
    expect(archivedIndex).toBeGreaterThanOrEqual(0);

    await useChatStore.getState().restoreSession(archivedIndex);
    await tick();
    expect(
      calls.some(
        (c) =>
          c.method === "PATCH" &&
          c.body?.status === "ACTIVE" &&
          c.url === "/backend-api/conversations/c-1",
      ),
    ).toBe(true);
    expect(
      useChatStore.getState().sessions.find((s) => s.id === "c-1"),
    ).toBeUndefined();

    await useChatStore.getState().switchListStatus("ACTIVE");
    await tick();
    expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual(["c-1"]);
  });

  test("⑨ 断线重连后已渲染内容不回退", async () => {
    await useChatStore.getState().bootstrap();
    await useChatStore.getState().onUserInput("hi");
    await tick();

    const first = lastSource();
    first.emit("delta", { content: "第一段内容" });
    expect(assistantMessage().content).toBe("第一段内容");

    // 服务端连接被断开(无 data 的 error 事件)→ 指数退避后重连
    first.readyState = FakeEventSource.CLOSED;
    first.emit("error");
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const second = lastSource();
    expect(second).not.toBe(first);
    // 重连首帧快照来自数据库(节流写入),可能比已渲染内容短:只作为新连接的前缀,不渲染
    second.emit("snapshot", { content: "第一段" });
    expect(assistantMessage().content).toBe("第一段内容");

    // 后续 delta 是相对该快照前缀的增量,拼接后不得重复已渲染字符
    second.emit("delta", { content: "内容第二段" });
    expect(assistantMessage().content).toBe("第一段内容第二段");

    // 更短的快照不能截断已经渲染出来的文本
    second.emit("snapshot", { content: "第一段" });
    expect(assistantMessage().content).toBe("第一段内容第二段");

    second.emit(
      "status",
      statusFrame("req-1", { status: "COMPLETED", requestStatus: "SUCCESS" }),
    );
    await tick();
    expect(assistantMessage().streaming).toBe(false);
    expect(assistantMessage().isError).toBe(false);
  }, 15000);

  test("⑩ 旧 IndexedDB / localStorage 聊天数据不覆盖后端", async () => {
    localStorage.setItem(
      StoreKey.Chat,
      JSON.stringify({
        state: {
          sessions: [{ id: "legacy", topic: "本地旧会话", messages: [] }],
          currentSessionIndex: 0,
          _hasHydrated: true,
        },
        version: 1,
      }),
    );
    server.conversations = [conversation("c-1", "后端会话")];

    const getItem = jest.spyOn(indexedDBStorage, "getItem");
    await useChatStore.getState().bootstrap();
    await tick();

    expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual(["c-1"]);
    expect(useChatStore.getState().sessions[0].topic).toBe("后端会话");
    expect(getItem.mock.calls.some(([key]) => key === StoreKey.Chat)).toBe(
      false,
    );
    getItem.mockRestore();
    expect(localStorage.getItem(StoreKey.Chat)).toBeNull();
  });

  test("⑪ 后端拒绝时给出错误码文案并在气泡上标错", async () => {
    server.conversations = [conversation("c-1", "忙碌会话")];
    await useChatStore.getState().bootstrap();
    await tick();

    const fallback = route;
    (globalThis as any).fetch = jest.fn(
      async (input: string, init: RequestInit = {}) => {
        const url = String(input);
        const method = String(init.method ?? "GET").toUpperCase();
        const body =
          typeof init.body === "string" ? JSON.parse(init.body) : undefined;
        if (url.endsWith("/messages") && method === "POST") {
          calls.push({ url, method, body, headers: {} });
          return fail(409, "CONVERSATION_REQUEST_IN_PROGRESS", "in progress");
        }
        calls.push({ url, method, body, headers: {} });
        return fallback(url, method, body);
      },
    );

    await useChatStore.getState().onUserInput("你好");
    await tick();

    const answer = assistantMessage();
    expect(answer.isError).toBe(true);
    expect(answer.errorCode).toBe("CONVERSATION_REQUEST_IN_PROGRESS");
    expect(errorTextForCode(answer.errorCode)).toBe(
      "这个会话还有回答在进行中,请先等它完成",
    );
  });

  test("⑫ 归档会话不允许发送", async () => {
    server.conversations = [conversation("c-1", "归档", "ARCHIVED")];
    await useChatStore.getState().switchListStatus("ARCHIVED");
    await tick();

    const before = calls.length;
    await useChatStore.getState().onUserInput("还能发吗");
    await tick();

    expect(
      calls
        .slice(before)
        .some((c) => c.method === "POST" && c.url.endsWith("/messages")),
    ).toBe(false);
    expect(activeSession().messages).toHaveLength(0);
  });

  test("⑬ 内容帧漏收时终态回读后端,不留空气泡", async () => {
    await useChatStore.getState().bootstrap();
    await useChatStore.getState().onUserInput("hi");
    await tick();

    // 后端已写好终态内容,前端这边只收到状态帧(代理抖动把内容帧整段丢掉)
    const stored = server.messages.get("c-1")!;
    const assistant = stored[stored.length - 1];
    server.messages.set("c-1", [
      ...stored.slice(0, -1),
      {
        ...assistant,
        content: "后端已经保存的完整回答",
        status: "COMPLETED",
        request: {
          id: "req-1",
          status: "SUCCESS",
          errorCode: null,
          errorMessage: null,
        },
      },
    ]);

    lastSource().emit(
      "status",
      statusFrame("req-1", { status: "COMPLETED", requestStatus: "SUCCESS" }),
    );
    await tick();

    expect(assistantMessage().content).toBe("后端已经保存的完整回答");
    expect(assistantMessage().streaming).toBe(false);
  });

  describe("PAG-1:会话列表分页(设计 §十八 store 矩阵)", () => {
    test("PAG-FE-01 首屏 reloadList:第一页落 UI、listNextCursor 保存", async () => {
      server.pageSize = 2;
      seedConversations(5, "p");
      await useChatStore.getState().bootstrap();
      await tick();

      const state = useChatStore.getState();
      expect(state.ready).toBe(true);
      expect(state.sessions.map((s) => s.id)).toEqual(["p-1", "p-2"]);
      expect(state.listNextCursor).toBe(
        encodeCursorOf(server.conversations.find((c) => c.id === "p-2")!),
      );
      expect(state.loadingList).toBe(false);
      expect(state.loadingMoreList).toBe(false);
    });

    test("PAG-FE-02 loadMore 追加第二页并更新 cursor,末页 cursor 归 null", async () => {
      server.pageSize = 2;
      seedConversations(5, "p");
      await useChatStore.getState().bootstrap();
      await tick();

      await useChatStore.getState().loadMoreConversations();
      expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual([
        "p-1",
        "p-2",
        "p-3",
        "p-4",
      ]);
      expect(useChatStore.getState().listNextCursor).toBe(
        encodeCursorOf(server.conversations.find((c) => c.id === "p-4")!),
      );
      expect(useChatStore.getState().loadingMoreList).toBe(false);

      await useChatStore.getState().loadMoreConversations();
      const state = useChatStore.getState();
      expect(state.sessions).toHaveLength(5);
      expect(state.listNextCursor).toBeNull();
    });

    test("PAG-FE-03 listNextCursor=null 时 loadMore 直接返回,不发请求", async () => {
      server.pageSize = 2;
      seedConversations(1, "p");
      await useChatStore.getState().bootstrap();
      await tick();
      expect(useChatStore.getState().listNextCursor).toBeNull();

      const before = listCalls().length;
      await useChatStore.getState().loadMoreConversations();
      expect(listCalls().length).toBe(before);
      expect(useChatStore.getState().loadingMoreList).toBe(false);
    });

    test("PAG-FE-04 loadingMore 期间连调多次 loadMore → 同 cursor 恰一次请求", async () => {
      server.pageSize = 2;
      seedConversations(4, "p");
      await useChatStore.getState().bootstrap();
      await tick();

      const hold = holdList((params) => params.get("cursor") !== null);
      const first = useChatStore.getState().loadMoreConversations();
      expect(hold.call).not.toBeNull();

      await Promise.all([
        useChatStore.getState().loadMoreConversations(),
        useChatStore.getState().loadMoreConversations(),
      ]);
      expect(
        listCalls().filter((c) => listQuery(c)!.get("cursor") !== null),
      ).toHaveLength(1);

      hold.release(() => pageReply("ACTIVE", 2));
      await first;
      await tick();

      const state = useChatStore.getState();
      expect(state.sessions.map((s) => s.id)).toEqual([
        "p-1",
        "p-2",
        "p-3",
        "p-4",
      ]);
      expect(state.loadingMoreList).toBe(false);
    });

    test("PAG-FE-05 reload 替换列表、cursor 重置,drafts 与已加载消息保留", async () => {
      server.pageSize = 2;
      seedConversations(4, "p");
      server.messages.set("p-1", [message("m-1", "p-1", "USER", "之前的问题")]);
      await useChatStore.getState().bootstrap();
      await tick();
      await tick();
      const loaded = useChatStore
        .getState()
        .sessions.find((s) => s.id === "p-1")!;
      expect(loaded.loaded).toBe(true);
      expect(loaded.messages).toHaveLength(1);

      useChatStore.getState().newSession();
      await useChatStore.getState().loadMoreConversations();
      expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual([
        expect.any(String),
        "p-1",
        "p-2",
        "p-3",
        "p-4",
      ]);
      expect(useChatStore.getState().sessions[0].draft).toBe(true);

      await useChatStore.getState().reloadList();
      await tick();

      const state = useChatStore.getState();
      expect(state.sessions.map((s) => s.id)).toEqual([
        expect.any(String),
        "p-1",
        "p-2",
      ]);
      expect(state.sessions[0].draft).toBe(true);
      expect(state.listNextCursor).toBe(
        encodeCursorOf(server.conversations.find((c) => c.id === "p-2")!),
      );
      expect(state.sessions.find((s) => s.id === "p-1")!.messages).toHaveLength(
        1,
      );
      expect(state.sessions.find((s) => s.id === "p-1")!.loaded).toBe(true);
    });

    test("PAG-FE-06 切状态清 cursor 重载;ACTIVE 在途 loadMore 不污染 ARCHIVED", async () => {
      server.pageSize = 2;
      seedConversations(3, "p");
      seedConversations(2, "ar", "ARCHIVED");
      await useChatStore.getState().bootstrap();
      await tick();
      expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual([
        "p-1",
        "p-2",
      ]);

      const hold = holdList((params) => params.get("cursor") !== null);
      const loadMore = useChatStore.getState().loadMoreConversations();
      expect(hold.call).not.toBeNull();

      await useChatStore.getState().switchListStatus("ARCHIVED");
      expect(
        calls.some(
          (c) =>
            listQuery(c)?.get("status") === "ARCHIVED" &&
            listQuery(c)?.get("cursor") === null,
        ),
      ).toBe(true);

      hold.release(() => pageReply("ACTIVE", 2));
      await loadMore;
      await tick();

      const state = useChatStore.getState();
      expect(state.listStatus).toBe("ARCHIVED");
      expect(state.sessions.map((s) => s.id)).toEqual(["ar-1", "ar-2"]);
      expect(state.listNextCursor).toBe(
        encodeCursorOf(server.conversations.find((c) => c.id === "ar-2")!),
      );
      expect(state.loadingMoreList).toBe(false);
      expect(state.ready).toBe(true);
    });

    test("PAG-FE-06A 首次 reload 在途时切状态:立即重置 + 跨状态旧响应零影响", async () => {
      server.pageSize = 2;
      seedConversations(2, "p");
      seedConversations(2, "ar", "ARCHIVED");

      const holdActive = holdList(
        (params) => params.get("status") === "ACTIVE",
      );
      const bootstrapping = useChatStore.getState().bootstrap();
      // bootstrap 先清 IndexedDB 再发列表请求,fetch 不会同步发出
      await tick();
      expect(holdActive.call).not.toBeNull();
      expect(useChatStore.getState().loadingList).toBe(true);

      const holdArchived = holdList(
        (params) => params.get("status") === "ARCHIVED",
      );
      const switching = useChatStore.getState().switchListStatus("ARCHIVED");
      // PAG-REVIEW-07:切换动作后、ARCHIVED 响应未回前,分页状态必须已清空
      expect(useChatStore.getState().listStatus).toBe("ARCHIVED");
      expect(useChatStore.getState().sessions).toEqual([]);
      expect(useChatStore.getState().listNextCursor).toBeNull();
      expect(useChatStore.getState().loadingMoreList).toBe(false);
      expect(useChatStore.getState().listMoreError).toBe(false);
      expect(holdArchived.call).not.toBeNull();

      // ACTIVE 旧响应后到:ownsInitialSlot=false → 完全退出,不写任何状态
      holdActive.release(() => firstPageReply("ACTIVE"));
      await bootstrapping;
      await tick();
      expect(useChatStore.getState().sessions).toEqual([]);

      holdArchived.release(() => firstPageReply("ARCHIVED"));
      await switching;
      await tick();

      const state = useChatStore.getState();
      expect(state.listStatus).toBe("ARCHIVED");
      expect(state.sessions.map((s) => s.id)).toEqual(["ar-1", "ar-2"]);
      expect(state.listNextCursor).toBe(
        encodeCursorOf(server.conversations.find((c) => c.id === "ar-2")!),
      );
      expect(state.loadingList).toBe(false);
      expect(state.ready).toBe(true);
    });

    test("PAG-FE-06B 同 status 重复 reloadList:第一页只允许一个 in-flight", async () => {
      server.pageSize = 2;
      seedConversations(2, "p");

      const hold = holdList((params) => params.get("status") === "ACTIVE");
      const first = useChatStore.getState().reloadList();
      expect(hold.call).not.toBeNull();

      const second = useChatStore.getState().reloadList();
      expect(listCalls()).toHaveLength(1);

      hold.release(() => firstPageReply("ACTIVE"));
      await first;
      await second;
      await tick();

      expect(listCalls()).toHaveLength(2);
      const state = useChatStore.getState();
      expect(state.sessions.map((s) => s.id)).toEqual(["p-1", "p-2"]);
      expect(state.loadingList).toBe(false);
      expect(state.ready).toBe(true);
    });

    test("PAG-FE-07 loadMore 在途 + reloadList:stale loadMore 整体丢弃不重复追加", async () => {
      server.pageSize = 2;
      seedConversations(4, "p");
      await useChatStore.getState().bootstrap();
      await tick();

      const hold = holdList((params) => params.get("cursor") !== null);
      const loadMore = useChatStore.getState().loadMoreConversations();
      expect(hold.call).not.toBeNull();

      await useChatStore.getState().reloadList();
      await tick();
      expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual([
        "p-1",
        "p-2",
      ]);

      hold.release(() => pageReply("ACTIVE", 2));
      await loadMore;
      await tick();

      const state = useChatStore.getState();
      expect(state.sessions.map((s) => s.id)).toEqual(["p-1", "p-2"]);
      expect(state.listNextCursor).toBe(
        encodeCursorOf(server.conversations.find((c) => c.id === "p-2")!),
      );
      expect(state.loadingMoreList).toBe(false);
    });

    test("PAG-FE-08 第二页与第一页 id 重叠:去重追加", async () => {
      server.pageSize = 2;
      seedConversations(3, "p");
      await useChatStore.getState().bootstrap();
      await tick();

      const p2 = server.conversations.find((c) => c.id === "p-2")!;
      const p3 = server.conversations.find((c) => c.id === "p-3")!;
      const originalFetch = globalThis.fetch;
      (globalThis as any).fetch = jest.fn(
        async (input: string, init: RequestInit = {}) => {
          const url = String(input);
          if (
            url.includes("/conversations?") &&
            new URLSearchParams(url.split("?")[1]).get("cursor")
          ) {
            // 服务器异常返回了与第一页重叠的第二页
            return reply(200, { data: [p2, p3], meta: { nextCursor: null } });
          }
          return (originalFetch as any)(input, init);
        },
      );

      await useChatStore.getState().loadMoreConversations();

      const state = useChatStore.getState();
      expect(state.sessions.map((s) => s.id)).toEqual(["p-1", "p-2", "p-3"]);
      expect(state.listNextCursor).toBeNull();
    });

    test("PAG-FE-09 loadMore 失败:sessions 与 cursor 原样保留,重试成功恢复", async () => {
      server.pageSize = 2;
      seedConversations(4, "p");
      await useChatStore.getState().bootstrap();
      await tick();
      const cursorBefore = useChatStore.getState().listNextCursor;
      const idsBefore = useChatStore.getState().sessions.map((s) => s.id);

      const originalFetch = globalThis.fetch;
      (globalThis as any).fetch = jest.fn(
        async (input: string, init: RequestInit = {}) => {
          const url = String(input);
          if (
            url.includes("/conversations?") &&
            new URLSearchParams(url.split("?")[1]).get("cursor")
          ) {
            return fail(500, "INTERNAL_ERROR", "boom");
          }
          return (originalFetch as any)(input, init);
        },
      );

      await useChatStore.getState().loadMoreConversations();
      let state = useChatStore.getState();
      expect(state.listMoreError).toBe(true);
      expect(state.loadingMoreList).toBe(false);
      expect(state.sessions.map((s) => s.id)).toEqual(idsBefore);
      expect(state.listNextCursor).toBe(cursorBefore);

      (globalThis as any).fetch = originalFetch;
      await useChatStore.getState().loadMoreConversations();
      state = useChatStore.getState();
      expect(state.listMoreError).toBe(false);
      expect(state.sessions.map((s) => s.id)).toEqual([
        "p-1",
        "p-2",
        "p-3",
        "p-4",
      ]);
    });

    test("PAG-FE-10 首次 reload 失败:listReloadError 且 ready=false,reloadList 重试成功", async () => {
      server.pageSize = 2;
      seedConversations(2, "p");

      const hold = holdList((params) => params.get("status") === "ACTIVE");
      const bootstrapping = useChatStore.getState().bootstrap();
      hold.release(() => fail(500, "INTERNAL_ERROR", "boom"));
      await bootstrapping;
      await tick();

      let state = useChatStore.getState();
      expect(state.ready).toBe(false);
      expect(state.listReloadError).toBe(true);
      expect(state.loadingList).toBe(false);
      expect(state.listNextCursor).toBeNull();
      expect(state.sessions).toEqual([]);

      const retryHold = holdList((params) => params.get("status") === "ACTIVE");
      const retrying = useChatStore.getState().reloadList();
      expect(retryHold.call).not.toBeNull();
      retryHold.release(() => firstPageReply("ACTIVE"));
      await retrying;
      await tick();

      state = useChatStore.getState();
      expect(state.ready).toBe(true);
      expect(state.listReloadError).toBe(false);
      expect(state.sessions.map((s) => s.id)).toEqual(["p-1", "p-2"]);
    });

    test("PAG-FE-11 archive 不复活:旧 loadMore 响应被 generation 丢弃", async () => {
      server.pageSize = 2;
      seedConversations(3, "p");
      await useChatStore.getState().bootstrap();
      await tick();

      const hold = holdList((params) => params.get("cursor") !== null);
      const loadMore = useChatStore.getState().loadMoreConversations();
      expect(hold.call).not.toBeNull();

      await useChatStore.getState().archiveSession(0);
      await tick();
      expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual([
        "p-2",
        "p-3",
      ]);

      const p1 = server.conversations.find((c) => c.id === "p-1")!;
      const p2 = server.conversations.find((c) => c.id === "p-2")!;
      // 旧快照响应里 p-1 还是 ACTIVE:绝不允许写回
      hold.release(() =>
        reply(200, { data: [p1, p2], meta: { nextCursor: encodeCursorOf(p2) } }),
      );
      await loadMore;
      await tick();

      const state = useChatStore.getState();
      expect(state.sessions.find((s) => s.id === "p-1")).toBeUndefined();
      expect(state.sessions.map((s) => s.id)).toEqual(["p-2", "p-3"]);
      expect(state.listNextCursor).toBe(
        encodeCursorOf(server.conversations.find((c) => c.id === "p-3")!),
      );
      expect(state.loadingMoreList).toBe(false);
    });

    test("PAG-FE-12 restore 不复活:ARCHIVED loadMore 在途被权威 reload 丢弃", async () => {
      server.pageSize = 2;
      seedConversations(1, "p");
      seedConversations(3, "ar", "ARCHIVED");
      await useChatStore.getState().switchListStatus("ARCHIVED");
      await tick();
      expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual([
        "ar-1",
        "ar-2",
      ]);

      const hold = holdList((params) => params.get("cursor") !== null);
      const loadMore = useChatStore.getState().loadMoreConversations();
      expect(hold.call).not.toBeNull();

      await useChatStore.getState().restoreSession(0);
      await tick();
      expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual([
        "ar-2",
        "ar-3",
      ]);

      const ar3 = server.conversations.find((c) => c.id === "ar-3")!;
      hold.release(() =>
        reply(200, { data: [ar3], meta: { nextCursor: null } }),
      );
      await loadMore;
      await tick();

      const state = useChatStore.getState();
      expect(state.listStatus).toBe("ARCHIVED");
      expect(state.sessions.find((s) => s.id === "ar-1")).toBeUndefined();
      expect(state.sessions.map((s) => s.id)).toEqual(["ar-2", "ar-3"]);
      expect(state.listNextCursor).toBe(encodeCursorOf(ar3));
    });

    test("PAG-FE-13 delete 不复活:旧 loadMore 响应不得写回列表", async () => {
      server.pageSize = 2;
      seedConversations(3, "p");
      await useChatStore.getState().bootstrap();
      await tick();

      const hold = holdList((params) => params.get("cursor") !== null);
      const loadMore = useChatStore.getState().loadMoreConversations();
      expect(hold.call).not.toBeNull();

      await useChatStore.getState().deleteSession(0);
      await tick();
      expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual([
        "p-2",
        "p-3",
      ]);

      const p3 = server.conversations.find((c) => c.id === "p-3")!;
      hold.release(() =>
        reply(200, { data: [p3], meta: { nextCursor: null } }),
      );
      await loadMore;
      await tick();

      const state = useChatStore.getState();
      expect(state.sessions.find((s) => s.id === "p-1")).toBeUndefined();
      expect(state.sessions.map((s) => s.id)).toEqual(["p-2", "p-3"]);
      expect(state.listNextCursor).toBe(encodeCursorOf(p3));
    });

    test("PAG-FE-14 草稿发送后顶部出现新会话,loadMore 不产生重复", async () => {
      server.pageSize = 2;
      seedConversations(3, "p");
      await useChatStore.getState().bootstrap();
      await tick();

      useChatStore.getState().newSession();
      await useChatStore.getState().onUserInput("你好");
      await tick();
      await tick();

      const afterSend = useChatStore.getState();
      expect(afterSend.sessions[0].draft).toBe(false);
      expect(afterSend.sessions[0].id).toBe("c-4");

      await useChatStore.getState().loadMoreConversations();
      await tick();

      const state = useChatStore.getState();
      const ids = state.sessions.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain("p-1");
      expect(ids).toContain("p-2");
      expect(ids).toContain("p-3");
      expect(ids).toContain("c-4");
    });

    test("PAG-FE-16 loadingMore 期间 sessions 长度只增不减", async () => {
      server.pageSize = 2;
      seedConversations(4, "p");
      await useChatStore.getState().bootstrap();
      await tick();
      expect(useChatStore.getState().sessions).toHaveLength(2);

      const hold = holdList((params) => params.get("cursor") !== null);
      const loadMore = useChatStore.getState().loadMoreConversations();
      expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual([
        "p-1",
        "p-2",
      ]);
      expect(useChatStore.getState().loadingMoreList).toBe(true);

      hold.release(() => pageReply("ACTIVE", 2));
      await loadMore;
      await tick();
      expect(useChatStore.getState().sessions).toHaveLength(4);
    });

    test("PAG-FE-17A 已加载 3 页且 loadMore 在途 → 权威 reload:旧 loadMore 丢弃回第一页", async () => {
      server.pageSize = 2;
      seedConversations(6, "p");
      await useChatStore.getState().bootstrap();
      await tick();
      await useChatStore.getState().loadMoreConversations();
      expect(useChatStore.getState().sessions).toHaveLength(4);

      const hold = holdList((params) => params.get("cursor") !== null);
      const loadMore = useChatStore.getState().loadMoreConversations();
      expect(hold.call).not.toBeNull();

      await useChatStore.getState().reloadList();
      await tick();
      // 第一页替换,旧第 2/3 页不保留
      expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual([
        "p-1",
        "p-2",
      ]);

      const p5 = server.conversations.find((c) => c.id === "p-5")!;
      const p6 = server.conversations.find((c) => c.id === "p-6")!;
      hold.release(() =>
        reply(200, { data: [p5, p6], meta: { nextCursor: encodeCursorOf(p6) } }),
      );
      await loadMore;
      await tick();

      const state = useChatStore.getState();
      expect(state.sessions.map((s) => s.id)).toEqual(["p-1", "p-2"]);
      expect(state.listNextCursor).toBe(
        encodeCursorOf(server.conversations.find((c) => c.id === "p-2")!),
      );
      expect(state.loadingMoreList).toBe(false);
    });

    test("PAG-FE-17B single-flight+trailing:被超越的旧响应永不写 UI", async () => {
      server.pageSize = 2;
      seedConversations(2, "p");
      await useChatStore.getState().bootstrap();
      await tick();
      const baseline = listCalls().length;

      const firstHold = holdList((params) => params.get("status") === "ACTIVE");
      const first = useChatStore.getState().reloadList();
      expect(firstHold.call).not.toBeNull();

      const second = useChatStore.getState().reloadList();
      // ① 无并发第二个请求;入口已递增 epoch 并废弃旧 cursor(PAG-REVIEW-12/13)
      expect(listCalls().length).toBe(baseline + 1);
      expect(useChatStore.getState().listNextCursor).toBeNull();
      expect(useChatStore.getState().loadingList).toBe(true);

      const trailingHold = holdList(
        (params) => params.get("status") === "ACTIVE",
      );

      const stale = {
        ...conversation("stale-1", "陈旧会话"),
        updatedAt: new Date(Date.parse(STAMP) - 60_000).toISOString(),
      };
      firstHold.release(() =>
        reply(200, { data: [stale], meta: { nextCursor: "stale-cursor" } }),
      );
      await first;
      await tick();
      // ②③ 旧响应未写 UI(即时断言):sessions 不变、stale 会话未出现、cursor 未被写入
      expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual([
        "p-1",
        "p-2",
      ]);
      expect(
        useChatStore.getState().sessions.some((s) => s.id === "stale-1"),
      ).toBe(false);
      expect(useChatStore.getState().listNextCursor).toBeNull();
      // ④ trailing 已自动发出并被挂起
      expect(trailingHold.call).not.toBeNull();
      expect(listCalls().length).toBe(baseline + 2);

      trailingHold.release(() => firstPageReply("ACTIVE"));
      await second;
      await tick();
      // ⑤⑥⑦ trailing 落定后才写最终 UI;总请求 = initial + trailing
      const state = useChatStore.getState();
      expect(state.sessions.map((s) => s.id)).toEqual(["p-1", "p-2"]);
      expect(state.listNextCursor).toBe(
        encodeCursorOf(server.conversations.find((c) => c.id === "p-2")!),
      );
      expect(state.loadingList).toBe(false);
      expect(state.ready).toBe(true);
      expect(listCalls().length).toBe(baseline + 2);
    });

    test("PAG-FE-17C inflight 期间连调 5 次 reloadList:总请求=2、pending 最终清空", async () => {
      server.pageSize = 2;
      seedConversations(2, "p");

      const firstHold = holdList((params) => params.get("status") === "ACTIVE");
      const first = useChatStore.getState().reloadList();
      expect(firstHold.call).not.toBeNull();

      const folds = [
        useChatStore.getState().reloadList(),
        useChatStore.getState().reloadList(),
        useChatStore.getState().reloadList(),
        useChatStore.getState().reloadList(),
        useChatStore.getState().reloadList(),
      ];
      expect(listCalls()).toHaveLength(1);

      const trailingHold = holdList(
        (params) => params.get("status") === "ACTIVE",
      );
      firstHold.release(() => firstPageReply("ACTIVE"));
      await first;
      await Promise.all(folds);
      await tick();
      expect(trailingHold.call).not.toBeNull();
      expect(listCalls()).toHaveLength(2);

      trailingHold.release(() => firstPageReply("ACTIVE"));
      await tick();
      const state = useChatStore.getState();
      expect(state.sessions.map((s) => s.id)).toEqual(["p-1", "p-2"]);
      expect(state.loadingList).toBe(false);

      // pendingReloadStatus 已清空:再调 reloadList 会立即发起新请求,而非继续折叠
      const probe = holdList((params) => params.get("status") === "ACTIVE");
      const pendingProbe = useChatStore.getState().reloadList();
      expect(probe.call).not.toBeNull();
      probe.release(() => firstPageReply("ACTIVE"));
      await pendingProbe;
      await tick();
      expect(listCalls()).toHaveLength(3);
      expect(useChatStore.getState().loadingList).toBe(false);
    });

    test("PAG-FE-18 防瞬时复活:inflight reload 期间归档,旧响应中的 X 不得再现", async () => {
      server.pageSize = 50;
      seedConversations(2, "p");
      await useChatStore.getState().bootstrap();
      await tick();
      const baseline = listCalls().length;

      const firstHold = holdList((params) => params.get("status") === "ACTIVE");
      const first = useChatStore.getState().reloadList();
      expect(firstHold.call).not.toBeNull();

      await useChatStore.getState().archiveSession(0);
      await tick();
      expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual([
        "p-2",
      ]);

      const trailingHold = holdList(
        (params) => params.get("status") === "ACTIVE",
      );
      const p1 = server.conversations.find((c) => c.id === "p-1")!;
      const p2 = server.conversations.find((c) => c.id === "p-2")!;
      // gen10 响应仍含 p-1(旧快照):处理完的瞬间 p-1 不得复活
      firstHold.release(() =>
        reply(200, { data: [p1, p2], meta: { nextCursor: null } }),
      );
      await first;
      await tick();
      expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual([
        "p-2",
      ]);
      expect(trailingHold.call).not.toBeNull();

      trailingHold.release(() =>
        reply(200, { data: [p2], meta: { nextCursor: null } }),
      );
      await tick();
      const state = useChatStore.getState();
      expect(state.sessions.map((s) => s.id)).toEqual(["p-2"]);
      expect(state.listNextCursor).toBeNull();
      expect(state.loadingList).toBe(false);
      expect(listCalls().length).toBe(baseline + 2);
    });

    test("PAG-FE-19 权威 reload 失败=分页冻结:旧 cursor 不续翻,Retry 恢复", async () => {
      server.pageSize = 2;
      seedConversations(6, "p");
      await useChatStore.getState().bootstrap();
      await tick();
      await useChatStore.getState().loadMoreConversations();
      expect(useChatStore.getState().listNextCursor).toBe(
        encodeCursorOf(server.conversations.find((c) => c.id === "p-4")!),
      );

      const moreHold = holdList((params) => params.get("cursor") !== null);
      const loadMore = useChatStore.getState().loadMoreConversations();
      expect(moreHold.call).not.toBeNull();

      const reloadHold = holdList(
        (params) => params.get("status") === "ACTIVE" && params.get("cursor") === null,
      );
      const reloading = useChatStore.getState().reloadList();
      // ① 权威失效到达:listNextCursor 立即 null、loadingMore 立即复位
      expect(useChatStore.getState().listNextCursor).toBeNull();
      expect(useChatStore.getState().loadingMoreList).toBe(false);

      moreHold.release(() => pageReply("ACTIVE", 3));
      await loadMore;
      await tick();
      // ② 旧 loadMore 响应被 generation 丢弃
      expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual([
        "p-1",
        "p-2",
        "p-3",
        "p-4",
      ]);
      expect(useChatStore.getState().listNextCursor).toBeNull();

      reloadHold.release(() => fail(500, "INTERNAL_ERROR", "boom"));
      await reloading;
      await tick();
      let state = useChatStore.getState();
      // ③ 已有 sessions 保留(不清空、不闪空) ④ listReloadError=true
      expect(state.sessions.map((s) => s.id)).toEqual([
        "p-1",
        "p-2",
        "p-3",
        "p-4",
      ]);
      expect(state.listReloadError).toBe(true);
      expect(state.loadingList).toBe(false);
      expect(state.ready).toBe(true);

      // ⑤ loadMoreConversations 不会用旧 cursor 发请求(cursor=null 守卫直接 return)
      const before = listCalls().length;
      await useChatStore.getState().loadMoreConversations();
      expect(listCalls().length).toBe(before);
      // ⑥ IO 不自动 loadMore 的 store 侧前提:hasMore=false 且 listReloadError=true
      expect(useChatStore.getState().listNextCursor).toBeNull();
      expect(useChatStore.getState().listReloadError).toBe(true);

      // ⑦ 点击 Retry(= reloadList)重新请求第一页
      const retryHold = holdList(
        (params) => params.get("status") === "ACTIVE" && params.get("cursor") === null,
      );
      const retrying = useChatStore.getState().reloadList();
      expect(retryHold.call).not.toBeNull();
      retryHold.release(() => firstPageReply("ACTIVE"));
      await retrying;
      await tick();
      // ⑧ Retry 成功:新第一页 + 新 cursor + 错误清除
      state = useChatStore.getState();
      expect(state.sessions.map((s) => s.id)).toEqual(["p-1", "p-2"]);
      expect(state.listNextCursor).toBe(
        encodeCursorOf(server.conversations.find((c) => c.id === "p-2")!),
      );
      expect(state.listReloadError).toBe(false);
      expect(state.ready).toBe(true);
    });
  });
});
