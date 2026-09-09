import { jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import {
  BACKEND_MODEL_LABEL,
  ChatSession,
  errorTextForCode,
  mergeFreshMessageWithLocal,
  useChatStore,
} from "../app/store/chat";
import { StoreKey } from "../app/constant";
import { indexedDBStorage } from "../app/utils/indexedDB-storage";
import {
  BackendApiError,
  isRequestFinished,
  listMessages,
  setUnauthorizedHandler,
} from "../app/client/backend-api";
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
  /** PAG-2:messages 分页大小(null = 用请求自带的 limit,默认 50) */
  messagePageSize: null as number | null,
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
 * PAG-2:挂起期间 route() 已先行执行(GET 纯读;POST messages = 事务先 commit),
 * committed 保存事务产出的响应,供 release(() => hold.committed) 回放。
 */
interface Hold {
  call: RecordedCall | null;
  promise: Promise<any>;
  release: (make: () => any) => void;
  committed?: any;
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

/** PAG-2:与后端 Message 模块一致的 position 游标(base64url({p}),语义 position < p) */
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

/** PAG-2:解析 GET messages 调用(会话 id + query);非 messages GET 返回 null */
function messagesQuery(
  call: RecordedCall,
): { id: string; params: URLSearchParams } | null {
  if (call.method !== "GET") return null;
  const match =
    /^\/backend-api\/conversations\/([^/?]+)\/messages\?(.*)$/.exec(call.url);
  return match ? { id: match[1], params: new URLSearchParams(match[2]) } : null;
}

const messageCalls = () => calls.filter((c) => messagesQuery(c) !== null);

/** PAG-2:挂起匹配的 messages 请求,由测试手动放行(构造 latest/loadOlder in-flight 竞态) */
function holdMessages(
  match: (conversationId: string, params: URLSearchParams) => boolean,
): Hold {
  let doRelease!: (response: any) => void;
  const promise = new Promise<any>((resolve) => {
    doRelease = resolve;
  });
  const hold: Hold & { match: (call: RecordedCall) => boolean } = {
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

/** PAG-2:挂起 POST /messages(事务在 route() 内先行 commit,响应由测试放行) */
function holdPost(): Hold {
  let doRelease!: (response: any) => void;
  const promise = new Promise<any>((resolve) => {
    doRelease = resolve;
  });
  const hold: Hold & { match: (call: RecordedCall) => boolean } = {
    call: null,
    promise,
    release: (make) => doRelease(make()),
    match: (call) =>
      call.method === "POST" &&
      /\/backend-api\/conversations\/[^/]+\/messages$/.test(call.url),
  };
  holds.push(hold);
  return hold;
}

function resetServer() {
  server.conversations = [];
  server.messages = new Map();
  server.sendSeq = 0;
  server.pageSize = null;
  server.messagePageSize = null;
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

/** PAG-2:批量造消息,position 从 start 起连续递增(旧→新),role 按 USER/ASSISTANT 交替 */
function seedMessages(
  conversationId: string,
  count: number,
  { startPosition = 1, prefix = "m" }: { startPosition?: number; prefix?: string } = {},
): BackendMessage[] {
  const list = Array.from({ length: count }, (_, k) =>
    message(
      `${prefix}-${startPosition + k}`,
      conversationId,
      k % 2 === 0 ? "USER" : "ASSISTANT",
      `内容 ${startPosition + k}`,
      { position: startPosition + k },
    ),
  );
  server.messages.set(conversationId, [
    ...(server.messages.get(conversationId) ?? []),
    ...list,
  ]);
  return list;
}

/** PAG-2:构造一页显式响应(用于 stale/边界场景,不读 server 当前状态) */
function messagePageReply(
  items: BackendMessage[],
  nextCursor: string | null,
  totalCount: number,
) {
  return reply(200, { data: items, meta: { nextCursor, totalCount } });
}

/** PAG-2:此刻服务端 messages 最新页响应(与 route GET messages 分支同构,release 时求值) */
function latestMessagesReply(id: string) {
  return route(
    `/backend-api/conversations/${id}/messages?limit=50`,
    "GET",
    undefined,
  );
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
    /^\/backend-api\/conversations\/([^/?]+)\/messages(?:\?(.*))?$/.exec(url);
  if (messagesMatch) {
    const id = messagesMatch[1];
    if (method === "GET") {
      // PAG-2:与后端同构的 position keyset 分页(desc 取 limit+1 探测 → slice → reverse 旧→新)
      const params = new URLSearchParams(messagesMatch[2] ?? "");
      const limit =
        server.messagePageSize ?? (Number(params.get("limit")) || 50);
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
          nextCursor: hasMore ? encodeMessageCursorOf(page[0]!.position) : null,
          totalCount: all.length,
        },
      });
    }

    const seq = ++server.sendSeq;
    const userMessageId = `msg-user-${seq}`;
    const assistantMessageId = `msg-assistant-${seq}`;
    const requestId = `req-${seq}`;
    const content = body?.content ?? "";
    // PAG-2:后端事务原子分配 position(USER = start,ASSISTANT = start + 1)
    const start =
      (server.messages.get(id) ?? []).reduce(
        (max, m) => Math.max(max, m.position ?? 0),
        0,
      ) + 1;
    const userMessage = message(userMessageId, id, "USER", content, {
      position: start,
    });
    const assistantMessage = message(assistantMessageId, id, "ASSISTANT", "", {
      status: "PENDING",
      position: start + 1,
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

  // PAG-2:cancel 兜底回读用例需要 REQUEST_NOT_CANCELLABLE 契约(默认一律 409)
  const cancelMatch = /^\/backend-api\/requests\/([^/?]+)\/cancel$/.exec(url);
  if (cancelMatch && method === "POST") {
    return fail(409, "REQUEST_NOT_CANCELLABLE", "already settled");
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
        // 挂起前先执行 route():GET 纯读无副作用;POST messages = 事务先 commit
        // (与后端「DB commit → Scheduler → response」顺序一致),committed 供回放
        hold.committed = route(url, method, parsed);
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
          c.url.startsWith("/backend-api/conversations/c-1/messages"),
      ),
    ).toBe(true);
    expect(state.sessions[0].loaded).toBe(true);
    expect(state.sessions[1].loaded).toBe(false);
    expect(
      calls.some((c) =>
        c.url.startsWith("/backend-api/conversations/c-3/messages"),
      ),
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

describe("PAG-2:Message 历史分页(设计 §二十九 store 矩阵)", () => {
  /** updatedAt 按分钟递减制造确定列表顺序(1 = 最新) */
  const conv = (id: string, minuteOffset: number): BackendConversation => ({
    ...conversation(id, `${id} 会话`),
    updatedAt: new Date(Date.parse(STAMP) - minuteOffset * 60_000).toISOString(),
  });

  const seq = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, k) => from + k);

  const sessionOf = (id: string) => {
    const session = useChatStore.getState().sessions.find((s) => s.id === id);
    if (!session) throw new Error(`session ${id} 不存在`);
    return session;
  };

  const positionsOf = (id: string) =>
    sessionOf(id).messages.flatMap((m) =>
      m.position === undefined ? [] : [m.position],
    );

  const latestCalls = () =>
    messageCalls().filter(
      (c) => messagesQuery(c)!.params.get("cursor") === null,
    );
  const olderCalls = () =>
    messageCalls().filter(
      (c) => messagesQuery(c)!.params.get("cursor") !== null,
    );

  const holdLatest = (id: string) =>
    holdMessages((cid, params) => cid === id && params.get("cursor") === null);
  const holdOlder = (id: string) =>
    holdMessages((cid, params) => cid === id && params.get("cursor") !== null);

  /** 此刻服务端 older 页响应(带 cursor,release 时求值) */
  const olderReply = (id: string, cursor: string) =>
    route(
      `/backend-api/conversations/${id}/messages?limit=50&cursor=${cursor}`,
      "GET",
      undefined,
    );

  /** bootstrap + 唯一会话最新页就位(200 条 → 151..200 / cursor p151 / totalCount 200) */
  async function seedLoadedConversation(id = "c-1", total = 200) {
    server.conversations = [conv(id, 1)];
    seedMessages(id, total);
    await useChatStore.getState().bootstrap();
    await tick();
  }

  test("PAG2-FE-01 首查只拉最新一页,消息升序,cursor/totalCount/loaded 落位", async () => {
    await seedLoadedConversation("c-1", 200);

    expect(messageCalls().length).toBeGreaterThan(0);
    for (const call of messageCalls()) {
      const parsed = messagesQuery(call)!;
      expect(parsed.params.get("cursor")).toBeNull();
      expect(parsed.params.get("limit")).toBe("50");
    }
    const session = sessionOf("c-1");
    expect(session.loaded).toBe(true);
    expect(positionsOf("c-1")).toEqual(seq(151, 200));
    expect(session.messageNextCursor).toBe(encodeMessageCursorOf(151));
    expect(session.messageTotalCount).toBe(200);
    expect(session.messageHistoryError).toBe(false);
    expect(session.loadingOlderMessages).toBe(false);
  });

  test("PAG2-FE-01A position 原样带入;transient 允许 undefined;persisted 缺失不静默补 0", async () => {
    server.conversations = [conv("c-1", 1)];
    const seeded = seedMessages("c-1", 5);
    delete (seeded[0] as { position?: number }).position; // invariant 缺失原样透传
    await useChatStore.getState().bootstrap();
    await tick();

    let session = sessionOf("c-1");
    expect(positionsOf("c-1")).toEqual(seq(2, 5));
    expect(session.messages[0]!.position).toBeUndefined(); // 缺 position ≠ 0
    expect(session.messages[0]!.content).toBe("内容 1");

    // transient:send POST 失败的 error bubble position === undefined
    const postHold = holdPost();
    const sending = useChatStore.getState().onUserInput("触发失败");
    postHold.release(() => fail(500, "INTERNAL_ERROR", "boom"));
    await sending;
    await tick();

    session = sessionOf("c-1");
    const bubble = session.messages[session.messages.length - 1]!;
    expect(bubble.position).toBeUndefined();
    expect(bubble.isError).toBe(true);
    // POST 事务先于失败响应 commit 了 6/7 两条(服务端真相;本地失败路径不回读)
    expect(
      (server.messages.get("c-1") ?? [])
        .map((m) => m.position)
        .filter((p): p is number => p !== undefined)
        .sort((a, b) => a - b),
    ).toEqual(seq(2, 7));
    expect(positionsOf("c-1")).toEqual(seq(2, 5));
  });

  test("PAG2-FE-01B listMessages raw fetch:limit 默认/cursor 编码/meta 三元组/401 handler", async () => {
    try {
      // ① 默认 limit=50;无 cursor 不带 cursor 参数
      let seenUrl = "";
      (globalThis as any).fetch = jest.fn(async (input: string) => {
        seenUrl = String(input);
        return reply(200, { data: [], meta: { nextCursor: null, totalCount: 0 } });
      });
      await listMessages("c-1");
      expect(seenUrl).toBe("/backend-api/conversations/c-1/messages?limit=50");

      // ② cursor 有值时编进 query
      await listMessages("c-1", { cursor: "pX" });
      expect(seenUrl).toBe(
        "/backend-api/conversations/c-1/messages?limit=50&cursor=pX",
      );

      // ③ data + meta.nextCursor + meta.totalCount 三元组均可达(call<T> 会丢 meta)
      (globalThis as any).fetch = jest.fn(async () =>
        reply(200, {
          data: seq(151, 200).map((p) =>
            message(
              `m-${p}`,
              "c-1",
              p % 2 === 1 ? "USER" : "ASSISTANT",
              `内容 ${p}`,
              { position: p },
            ),
          ),
          meta: { nextCursor: "p151", totalCount: 200 },
        }),
      );
      const page = await listMessages("c-1");
      expect(page.items).toHaveLength(50);
      expect(page.items.map((m) => m.position)).toEqual(seq(151, 200));
      expect(page.nextCursor).toBe("p151");
      expect(page.totalCount).toBe(200);

      // ④ 401 AUTH_REQUIRED:全局 handler 仍触发 + BackendApiError(SEC-1 不绕过)
      let unauthorized = 0;
      setUnauthorizedHandler(() => {
        unauthorized += 1;
      });
      (globalThis as any).fetch = jest.fn(async () =>
        reply(401, {
          error: { code: "AUTH_REQUIRED", message: "login", requestId: "r" },
        }),
      );
      await expect(listMessages("c-1")).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
        status: 401,
      });
      expect(unauthorized).toBe(1);
    } finally {
      setUnauthorizedHandler(null);
    }
  });

  test("PAG2-FE-02 loadOlder 头部 prepend、cursor 推进、totalCount=Math.max", async () => {
    await seedLoadedConversation("c-1", 200);
    const tailId = sessionOf("c-1").messages.slice(-1)[0]!.id;

    const result = await useChatStore.getState().loadOlderMessages("c-1");

    expect(result).toEqual({ applied: true, prependedCount: 50 });
    const session = sessionOf("c-1");
    expect(positionsOf("c-1")).toEqual(seq(101, 200));
    expect(session.messageNextCursor).toBe(encodeMessageCursorOf(101));
    expect(session.messageTotalCount).toBe(200);
    expect(session.messages[session.messages.length - 1]!.id).toBe(tailId);
  });

  test("PAG2-FE-03 cursor=null 时 loadOlder 直接返回不发请求", async () => {
    await seedLoadedConversation("c-1", 50);
    expect(sessionOf("c-1").messageNextCursor).toBeNull();
    const before = olderCalls().length;

    const result = await useChatStore.getState().loadOlderMessages("c-1");

    expect(result).toEqual({ applied: false, prependedCount: 0 });
    expect(olderCalls().length).toBe(before);
  });

  test("PAG2-FE-04 同 session 双调单飞:恰一次请求,cursor 推进一次", async () => {
    await seedLoadedConversation("c-1", 200);
    const olderHold = holdOlder("c-1");
    const first = useChatStore.getState().loadOlderMessages("c-1");
    await tick();
    expect(olderHold.call).not.toBeNull();

    const second = await useChatStore.getState().loadOlderMessages("c-1");
    expect(second).toEqual({ applied: false, prependedCount: 0 });

    olderHold.release(() => olderReply("c-1", encodeMessageCursorOf(151)));
    expect(await first).toEqual({ applied: true, prependedCount: 50 });
    await tick();

    expect(olderCalls().length).toBe(1);
    expect(sessionOf("c-1").messageNextCursor).toBe(encodeMessageCursorOf(101));
    expect(positionsOf("c-1")).toEqual(seq(101, 200));
  });

  test("PAG2-FE-05 loadOlder 失败:messages/cursor/totalCount/loaded 不动,error=true;retry 同 cursor 成功", async () => {
    await seedLoadedConversation("c-1", 200);
    const failHold = holdOlder("c-1");
    const first = useChatStore.getState().loadOlderMessages("c-1");
    failHold.release(() => fail(500, "INTERNAL_ERROR", "boom"));
    expect(await first).toEqual({ applied: false, prependedCount: 0 });
    await tick();

    let session = sessionOf("c-1");
    expect(positionsOf("c-1")).toEqual(seq(151, 200));
    expect(session.messageNextCursor).toBe(encodeMessageCursorOf(151));
    expect(session.messageTotalCount).toBe(200);
    expect(session.loaded).toBe(true);
    expect(session.messageHistoryError).toBe(true);

    const retryHold = holdOlder("c-1");
    const retry = useChatStore.getState().loadOlderMessages("c-1");
    expect(retryHold.call).not.toBeNull();
    expect(messagesQuery(retryHold.call!)!.params.get("cursor")).toBe(
      encodeMessageCursorOf(151),
    );
    retryHold.release(() => olderReply("c-1", encodeMessageCursorOf(151)));
    expect(await retry).toEqual({ applied: true, prependedCount: 50 });
    await tick();
    session = sessionOf("c-1");
    expect(positionsOf("c-1")).toEqual(seq(101, 200));
    expect(session.messageNextCursor).toBe(encodeMessageCursorOf(101));
    expect(session.messageHistoryError).toBe(false);
  });

  test("PAG2-FE-06 A loadOlder 在飞切 B:A 响应写回 A,B 不被污染", async () => {
    server.conversations = [conv("c-1", 1), conv("c-2", 2)];
    seedMessages("c-1", 200);
    await useChatStore.getState().bootstrap();
    await tick();

    const aHold = holdOlder("c-1");
    const loading = useChatStore.getState().loadOlderMessages("c-1");
    await tick();
    expect(aHold.call).not.toBeNull();

    useChatStore.getState().selectSession(1); // 触发 B 自己的 latest load
    await tick();

    aHold.release(() => olderReply("c-1", encodeMessageCursorOf(151)));
    expect(await loading).toEqual({ applied: true, prependedCount: 50 });
    await tick();

    expect(positionsOf("c-1")).toEqual(seq(101, 200));
    const b = sessionOf("c-2");
    expect(b.loaded).toBe(true);
    expect(b.messages).toHaveLength(0);
    expect(b.messageNextCursor).toBeNull();
  });

  test("PAG2-FE-07 会话删除后 late loadOlder 响应被丢弃,不复活 A", async () => {
    await seedLoadedConversation("c-1", 200);
    const aHold = holdOlder("c-1");
    const loading = useChatStore.getState().loadOlderMessages("c-1");
    await tick();
    expect(aHold.call).not.toBeNull();

    await useChatStore.getState().deleteSession(0);
    await tick();
    expect(
      useChatStore.getState().sessions.some((s) => s.id === "c-1"),
    ).toBe(false);

    aHold.release(() => olderReply("c-1", encodeMessageCursorOf(151)));
    expect(await loading).toEqual({ applied: false, prependedCount: 0 });
    await tick();
    expect(
      useChatStore.getState().sessions.some((s) => s.id === "c-1"),
    ).toBe(false);
  });

  test("PAG2-FE-07A 移除后同 id 重建:old loadOlder 响应不得写入新 session", async () => {
    await seedLoadedConversation("c-1", 200);
    const aHold = holdOlder("c-1");
    const loading = useChatStore.getState().loadOlderMessages("c-1");
    await tick();
    expect(aHold.call).not.toBeNull();

    await useChatStore.getState().deleteSession(0);
    await tick();
    // 测试侧重新注入同 id 会话并权威 reload → 全新 session(分页字段归零)
    server.conversations = [conv("c-1", 1)];
    await useChatStore.getState().reloadList();
    await tick();
    expect(sessionOf("c-1").loaded).toBe(false);
    expect(sessionOf("c-1").messageNextCursor).toBeNull();
    expect(sessionOf("c-1").messages).toHaveLength(0);

    aHold.release(() => olderReply("c-1", encodeMessageCursorOf(151)));
    expect(await loading).toEqual({ applied: false, prependedCount: 0 });
    await tick();

    expect(sessionOf("c-1").messages).toHaveLength(0);
    expect(sessionOf("c-1").loaded).toBe(false);
    expect(sessionOf("c-1").messageNextCursor).toBeNull();
  });

  test("PAG2-FE-07B 移除后同 id 重建:old latest HTTP 响应不得覆盖新 session", async () => {
    await seedLoadedConversation("c-1", 200);
    const latestHold = holdLatest("c-1");
    const refreshing = useChatStore.getState().refreshSessionMessages("c-1");
    await tick();
    expect(latestHold.call).not.toBeNull();

    await useChatStore.getState().deleteSession(0);
    await tick();
    server.conversations = [conv("c-1", 1)];
    await useChatStore.getState().reloadList();
    await tick();
    expect(sessionOf("c-1").loaded).toBe(false);
    expect(sessionOf("c-1").messages).toHaveLength(0);

    latestHold.release(() => latestMessagesReply("c-1"));
    await refreshing;
    await tick();

    expect(sessionOf("c-1").loaded).toBe(false);
    expect(sessionOf("c-1").messages).toHaveLength(0);
  });

  test("PAG2-FE-08 send 后 reloadList merge:messages 与 4 个分页字段全部保留", async () => {
    await seedLoadedConversation("c-1", 200);
    await useChatStore.getState().onUserInput("你好");
    await tick();

    const session = sessionOf("c-1");
    expect(positionsOf("c-1")).toEqual(seq(151, 202));
    expect(session.messageNextCursor).toBe(encodeMessageCursorOf(151));
    expect(session.messageHistoryError).toBe(false);
    expect(session.loadingOlderMessages).toBe(false);
    expect(session.messageTotalCount).toBe(202);
    expect(session.loaded).toBe(true);
  });

  test("PAG2-FE-09 refresh:同 id 更新、页外 older 保留、无重复", async () => {
    await seedLoadedConversation("c-1", 200);
    await useChatStore.getState().loadOlderMessages("c-1");
    await tick();
    expect(positionsOf("c-1")).toEqual(seq(101, 200));

    const all = server.messages.get("c-1")!;
    all.find((m) => m.id === "m-200")!.content = "已更新的回答";
    all.push(message("m-201", "c-1", "USER", "追加", { position: 201 }));
    all.push(message("m-202", "c-1", "ASSISTANT", "追加回答", { position: 202 }));

    await useChatStore.getState().refreshSessionMessages("c-1");
    await tick();

    const session = sessionOf("c-1");
    expect(
      session.messages.find((m) => m.id === "m-200")!.content,
    ).toBe("已更新的回答");
    expect(positionsOf("c-1")).toEqual(seq(101, 202));
    expect(session.messageTotalCount).toBe(202);
    expect(session.messageNextCursor).toBe(encodeMessageCursorOf(101));
  });

  test("PAG2-FE-09A gap 正常 overlap:local 101..200 + fresh 153..202 → 连续且 older 保留", async () => {
    await seedLoadedConversation("c-1", 200);
    const all = server.messages.get("c-1")!;
    all.push(message("m-201", "c-1", "USER", "n1", { position: 201 }));
    all.push(message("m-202", "c-1", "ASSISTANT", "n2", { position: 202 }));
    await useChatStore.getState().loadOlderMessages("c-1"); // local 101..200
    await tick();

    const latestHold = holdLatest("c-1");
    const refreshing = useChatStore.getState().refreshSessionMessages("c-1");
    latestHold.release(() => latestMessagesReply("c-1"));
    await refreshing;
    await tick();

    expect(positionsOf("c-1")).toEqual(seq(101, 202));
    expect(sessionOf("c-1").messageNextCursor).toBe(encodeMessageCursorOf(101));
  });

  test("PAG2-FE-09B gap fallback:local 151..200 + fresh 211..260 → 整组替换,禁拼接", async () => {
    await seedLoadedConversation("c-1", 200);
    const fresh = seq(211, 260).map((p) =>
      message(
        `m-${p}`,
        "c-1",
        p % 2 === 1 ? "USER" : "ASSISTANT",
        `新页 ${p}`,
        { position: p },
      ),
    );
    const latestHold = holdLatest("c-1");
    const refreshing = useChatStore.getState().refreshSessionMessages("c-1");
    latestHold.release(() =>
      messagePageReply(fresh, encodeMessageCursorOf(211), 260),
    );
    await refreshing;
    await tick();

    const session = sessionOf("c-1");
    expect(positionsOf("c-1")).toEqual(seq(211, 260));
    expect(session.messageNextCursor).toBe(encodeMessageCursorOf(211));
    expect(session.messageTotalCount).toBe(260);
  });

  test("PAG2-FE-10 refresh 响应含本地没有的新消息:merge 进尾部无重复", async () => {
    await seedLoadedConversation("c-1", 200);
    const all = server.messages.get("c-1")!;
    all.push(message("m-201", "c-1", "USER", "新用户", { position: 201 }));
    all.push(message("m-202", "c-1", "ASSISTANT", "新回答", { position: 202 }));

    await useChatStore.getState().refreshSessionMessages("c-1");
    await tick();

    const ids = sessionOf("c-1").messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(positionsOf("c-1")).toEqual(seq(151, 202));
  });

  test("PAG2-FE-11 在飞 streaming assistant:merge 不覆盖未终态本地内容,不打 error", async () => {
    await seedLoadedConversation("c-1", 200);
    const all = server.messages.get("c-1")!;
    all.push(
      message("m-201", "c-1", "USER", "q", { position: 201 }),
      message("m-202", "c-1", "ASSISTANT", "abcde", {
        position: 202,
        status: "STREAMING",
        request: {
          id: "req-1",
          status: "PROCESSING",
          errorCode: null,
          errorMessage: null,
        },
      }),
    );
    await useChatStore.getState().refreshSessionMessages("c-1");
    await tick();
    expect(positionsOf("c-1")).toEqual(seq(151, 202));

    // 模拟 SSE delta 已把本地推进到比 fresh 快照更新的内容
    useChatStore.getState().updateTargetSession(sessionOf("c-1"), (target) => {
      target.messages.find((m) => m.id === "m-202")!.content = "abcdefghij";
    });

    await useChatStore.getState().refreshSessionMessages("c-1");
    await tick();

    const assistant = sessionOf("c-1").messages.find((m) => m.id === "m-202")!;
    expect(assistant.content).toBe("abcdefghij");
    expect(assistant.streaming).toBe(true);
    expect(assistant.isError).toBe(false);
  });

  test("PAG2-FE-12 running request 在最新页:pendingRequestId 恢复并 followRequest 续接", async () => {
    server.conversations = [conv("c-1", 1)];
    const seeded = seedMessages("c-1", 199);
    server.messages.set("c-1", [
      ...seeded,
      message("m-200", "c-1", "ASSISTANT", "生成中", {
        position: 200,
        status: "STREAMING",
        request: {
          id: "req-9",
          status: "PROCESSING",
          errorCode: null,
          errorMessage: null,
        },
      }),
    ]);
    await useChatStore.getState().bootstrap();
    await tick();

    const session = sessionOf("c-1");
    expect(session.pendingRequestId).toBe("req-9");
    expect(lastSource().url).toBe("/backend-api/requests/req-9/events");
    expect(positionsOf("c-1")).toEqual(seq(151, 200));
  });

  test("PAG2-FE-13 draft:不发 messages 请求,cursor=null、totalCount=0、无 sentinel 前置", async () => {
    await useChatStore.getState().bootstrap();
    await tick();

    const session = useChatStore.getState().sessions[0]!;
    expect(session.draft).toBe(true);
    expect(session.messageNextCursor).toBeNull();
    expect(session.messageTotalCount).toBe(0);
    expect(session.loadingOlderMessages).toBe(false);
    expect(session.messageHistoryError).toBe(false);
    expect(messageCalls()).toHaveLength(0);
  });

  test("PAG2-FE-14 archive/switchListStatus 清 ownership;reloadList 同 status merge 不清", async () => {
    // ① archive:inflight loadOlder 的旧响应不得写回(ownership 已随 archive 清理)
    await seedLoadedConversation("c-1", 200);
    const aHold = holdOlder("c-1");
    const loading = useChatStore.getState().loadOlderMessages("c-1");
    await tick();
    expect(aHold.call).not.toBeNull();
    await useChatStore.getState().archiveSession(0);
    await tick();
    aHold.release(() => olderReply("c-1", encodeMessageCursorOf(151)));
    expect(await loading).toEqual({ applied: false, prependedCount: 0 });
    await tick();
    expect(
      useChatStore.getState().sessions.some((s) => s.id === "c-1"),
    ).toBe(false);

    // ② reloadList 同 status merge 保留分页字段:send 之后 loadOlder 仍正常
    // (① 的 archive 已完成;resetStore 后重放 bootstrap,避免 ready guard 早退;
    //  seedMessages 是追加语义,须先清掉 ① 遗留的 c-1 消息再重 seed)
    resetStore();
    server.messages.delete("c-1");
    await seedLoadedConversation("c-1", 200);
    await useChatStore.getState().onUserInput("继续");
    await tick();
    expect(sessionOf("c-1").messageNextCursor).toBe(encodeMessageCursorOf(151));
    const result = await useChatStore.getState().loadOlderMessages("c-1");
    expect(result).toEqual({ applied: true, prependedCount: 50 });
    expect(positionsOf("c-1")).toEqual(seq(101, 202));
  });

  test("PAG2-FE-15 refresh 三个调用方:手动刷新 / onFinish 回读 / cancel 兜底", async () => {
    // ① 手动刷新:新消息进入尾部
    await seedLoadedConversation("c-1", 200);
    const all = server.messages.get("c-1")!;
    all.push(message("m-201", "c-1", "USER", "手动", { position: 201 }));
    all.push(message("m-202", "c-1", "ASSISTANT", "刷新可见", { position: 202 }));
    await useChatStore.getState().refreshSessionMessages("c-1");
    await tick();
    expect(positionsOf("c-1")).toEqual(seq(151, 202));

    // ② onFinish 回读:SSE 终态但内容为空 → 自动回读权威内容
    // (pendingRequestId 只在 POST 响应后落位,捕获必须在 release 之后)
    const postHold = holdPost();
    const sending = useChatStore.getState().onUserInput("再来一条");
    await tick();
    postHold.release(() => postHold.committed);
    await sending;
    await tick();
    const requestId = sessionOf("c-1").pendingRequestId!;
    expect(requestId).toMatch(/^req-/);
    const stored = server.messages.get("c-1")!;
    const lastAssistant = stored[stored.length - 1]!;
    lastAssistant.content = "权威回答";
    lastAssistant.status = "COMPLETED";
    (lastAssistant.request as { status: string }).status = "SUCCESS";
    lastSource().emit(
      "status",
      statusFrame(requestId, {
        status: "COMPLETED",
        requestStatus: "SUCCESS",
        errorCode: null,
        errorMessage: null,
      }),
    );
    await tick();
    const finished = sessionOf("c-1").messages.find(
      (m) => m.id === lastAssistant.id,
    )!;
    expect(finished.content).toBe("权威回答");
    expect(finished.streaming).toBe(false);

    // ③ cancel 兜底:REQUEST_NOT_CANCELLABLE → 回读 fresh 终态 → 清 pending
    const postHold2 = holdPost();
    const sending2 = useChatStore.getState().onUserInput("第三条");
    await tick();
    postHold2.release(() => postHold2.committed);
    await sending2;
    await tick();
    const requestId2 = sessionOf("c-1").pendingRequestId!;
    const stored2 = server.messages.get("c-1")!;
    const last2 = stored2[stored2.length - 1]!;
    (last2.request as { status: string }).status = "SUCCESS";
    last2.status = "COMPLETED";
    const latestBefore = latestCalls().length;
    await useChatStore.getState().cancelRequest("c-1");
    await tick();
    expect(latestCalls().length).toBe(latestBefore + 1);
    expect(sessionOf("c-1").pendingRequestId).toBeUndefined();
    expect(requestId2).toMatch(/^req-/);
  });

  test("PAG2-FE-16 Export 独立 snapshot:全量 200、asc、无重复,ChatStore 零写入", async () => {
    await seedLoadedConversation("c-1", 200);
    const before = sessionOf("c-1");
    const snapshot = await useChatStore
      .getState()
      .prepareMessagesForExport("c-1");

    expect(snapshot).toHaveLength(200);
    expect(snapshot.map((m) => m.position)).toEqual(seq(1, 200));
    const ids = snapshot.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(olderCalls().length).toBe(3); // 4 页 = 1 latest + 3 cursor 页

    // guard:draft 会话不允许导出
    useChatStore.getState().newSession();
    const draft = useChatStore.getState().sessions[0]!;
    expect(draft.draft).toBe(true);
    await expect(
      useChatStore.getState().prepareMessagesForExport(draft.id),
    ).rejects.toThrow("无法导出");
    useChatStore.getState().deleteSession(0);

    const after = sessionOf("c-1");
    expect(after.messages).toHaveLength(before.messages.length);
    expect(after.messageNextCursor).toBe(before.messageNextCursor);
    expect(after.messageTotalCount).toBe(before.messageTotalCount);
    expect(after.loadingOlderMessages).toBe(false);
    expect(after.messageHistoryError).toBe(false);
  });

  test("PAG2-FE-17 totalCount 首查建立 + send 同步 max 三组,绝不回退不重复 +2", async () => {
    // 组 1:current=200 / position=202 → 202(B 分支)
    await seedLoadedConversation("c-1", 200);
    await useChatStore.getState().onUserInput("组1");
    await tick();
    expect(sessionOf("c-1").messageTotalCount).toBe(202);

    // 组 2:GET 先见 send pair(时序①)→ bootstrap 202;POST 后到 id-upsert → 仍 202
    // (组 1 已置 ready → resetStore 重放,避免 bootstrap guard 早退;
    //  mock 在 pageSize=null 分支按数组原序返回列表,最新的 c-8 须放数组首位)
    server.conversations = [conv("c-8", 1), conv("c-9", 2)];
    seedMessages("c-9", 200);
    resetStore();
    await useChatStore.getState().bootstrap();
    await tick();
    expect(sessionOf("c-8").loaded).toBe(true);
    const initialHold = holdLatest("c-9");
    useChatStore.getState().selectSession(1); // c-9 initial 在飞
    await tick();
    expect(initialHold.call).not.toBeNull();

    const postHold = holdPost();
    const sending = useChatStore.getState().onUserInput("组2");
    await tick();
    expect(postHold.call).not.toBeNull(); // 事务已 commit(201/202)
    initialHold.release(() => latestMessagesReply("c-9")); // fresh 已含 send pair
    await tick();
    expect(sessionOf("c-9").loaded).toBe(true);
    expect(sessionOf("c-9").messageTotalCount).toBe(202);

    postHold.release(() => postHold.committed);
    await sending;
    await tick();
    expect(sessionOf("c-9").messageTotalCount).toBe(202); // 不重复 +2
    const ids9 = sessionOf("c-9").messages.map((m) => m.id);
    expect(new Set(ids9).size).toBe(ids9.length);

    // 先终结组 2 的 Request,清掉 pending(否则下一条 send 被 guard 拦截)
    const doneId = sessionOf("c-9").pendingRequestId!;
    lastSource().emit(
      "status",
      statusFrame(doneId, {
        status: "COMPLETED",
        requestStatus: "SUCCESS",
        errorCode: null,
        errorMessage: null,
      }),
    );
    await tick();
    expect(sessionOf("c-9").pendingRequestId).toBeUndefined();

    // 组 3:current=204(deduplicated replay)/ position=202 → 204 绝不回退
    server.messages.get("c-9")!.push(
      message("m-903", "c-9", "USER", "x1", { position: 203 }),
      message("m-904", "c-9", "ASSISTANT", "x2", { position: 204 }),
    );
    await useChatStore.getState().refreshSessionMessages("c-9");
    await tick();
    expect(sessionOf("c-9").messageTotalCount).toBe(204);

    const dupHold = holdPost();
    const dupSend = useChatStore.getState().onUserInput("组3重放");
    await tick();
    expect(dupHold.call).not.toBeNull();
    dupHold.release(() =>
      reply(201, {
        data: {
          request: request("req-dup", "c-9", "m-dup-u", "m-dup-a", "SUCCESS"),
          userMessage: message("m-dup-u", "c-9", "USER", "重放", {
            position: 201,
          }),
          assistantMessage: message("m-dup-a", "c-9", "ASSISTANT", "", {
            status: "COMPLETED",
            position: 202,
            request: {
              id: "req-dup",
              status: "SUCCESS",
              errorCode: null,
              errorMessage: null,
            },
          }),
          deduplicated: true,
        },
      }),
    );
    await dupSend;
    await tick();
    expect(sessionOf("c-9").messageTotalCount).toBe(204); // max(204,202),不 +2
  });

  test("PAG2-FE-18 latest 单飞+trailing:原子 handoff,无 loadingMessages=false 中间窗口", async () => {
    await seedLoadedConversation("c-1", 200);
    const firstHold = holdLatest("c-1");
    const first = useChatStore.getState().refreshSessionMessages("c-1");
    await tick();
    expect(firstHold.call).not.toBeNull(); // ① 在飞
    const latestBefore = latestCalls().length;

    // ② in-flight 期间第二次 refresh:登记 pending 后立即 return,不发第二个 HTTP
    const second = useChatStore.getState().refreshSessionMessages("c-1");
    await second;
    await tick();
    expect(latestCalls().length).toBe(latestBefore);
    expect(sessionOf("c-1").loadingMessages).toBe(true);

    // ③ 旧响应返回(version 已被 ② bump)→ stale,不写任何 state
    const trailingHold = holdLatest("c-1");
    firstHold.release(() => latestMessagesReply("c-1"));
    await first;
    await tick();
    expect(positionsOf("c-1")).toEqual(seq(151, 200));
    // ④ 原子 handoff:slot 直接替换为 trailing,loadingMessages 恒 true
    expect(sessionOf("c-1").loadingMessages).toBe(true);
    // ⑤ trailing 用当前 version 启动 HTTP
    expect(trailingHold.call).not.toBeNull();
    expect(latestCalls().length).toBe(latestBefore + 1);

    // ⑦ trailing 响应 responseIsLatest=true → 正常写盘
    server.messages.get("c-1")!.push(
      message("m-201", "c-1", "USER", "t1", { position: 201 }),
      message("m-202", "c-1", "ASSISTANT", "t2", { position: 202 }),
    );
    trailingHold.release(() => latestMessagesReply("c-1"));
    await tick();
    // ⑥ 直到 trailing 最终结束才 loadingMessages=false
    expect(sessionOf("c-1").loadingMessages).toBe(false);
    expect(positionsOf("c-1")).toEqual(seq(151, 202));
    // ⑧ 全程同会话 latest HTTP 最大并发 = 1(first 已计入 latestBefore,trailing 恰 +1)
    expect(latestCalls().length).toBe(latestBefore + 1);
  });

  test("PAG2-FE-18A in-flight 期间连续 5 次 refresh:折叠为 1 个 trailing,恰 2 次 HTTP", async () => {
    await seedLoadedConversation("c-1", 200);
    const firstHold = holdLatest("c-1");
    const first = useChatStore.getState().refreshSessionMessages("c-1");
    await tick();
    const latestBefore = latestCalls().length;

    for (let i = 0; i < 5; i += 1) {
      await useChatStore.getState().refreshSessionMessages("c-1");
    }
    expect(latestCalls().length).toBe(latestBefore); // 5 次全部折叠,无新 HTTP

    const trailingHold = holdLatest("c-1");
    server.messages.get("c-1")!.push(
      message("m-201", "c-1", "USER", "t1", { position: 201 }),
      message("m-202", "c-1", "ASSISTANT", "t2", { position: 202 }),
    );
    firstHold.release(() => latestMessagesReply("c-1")); // stale → 丢弃
    await first;
    await tick();
    expect(trailingHold.call).not.toBeNull();
    trailingHold.release(() => latestMessagesReply("c-1"));
    await tick();

    expect(latestCalls().length).toBe(latestBefore + 1); // first 已计入 latestBefore
    expect(positionsOf("c-1")).toEqual(seq(151, 202));
    expect(sessionOf("c-1").messageTotalCount).toBe(202);
    expect(sessionOf("c-1").loadingMessages).toBe(false);
  });

  test("PAG2-FE-19 stale latest + send 新增 tail:201/202 不消失,pending 不清", async () => {
    await seedLoadedConversation("c-1", 200);
    const latestHold = holdLatest("c-1");
    const refreshing = useChatStore.getState().refreshSessionMessages("c-1");
    await tick();

    await useChatStore.getState().onUserInput("tail");
    await tick();
    expect(sessionOf("c-1").messageTotalCount).toBe(202); // A1 立即同步
    const pendingId = sessionOf("c-1").pendingRequestId!;

    latestHold.release(() =>
      messagePageReply(
        seq(151, 200).map((p) =>
          message(`m-${p}`, "c-1", p % 2 === 1 ? "USER" : "ASSISTANT", `旧 ${p}`, {
            position: p,
          }),
        ),
        encodeMessageCursorOf(151),
        200,
      ),
    );
    await refreshing;
    await tick();

    const session = sessionOf("c-1");
    expect(positionsOf("c-1")).toEqual(seq(151, 202));
    expect(session.messageTotalCount).toBe(202);
    expect(session.pendingRequestId).toBe(pendingId);
  });

  test("PAG2-FE-19A 终态防倒退:唯一 merge 规则 fresh.streaming ? local : fresh", async () => {
    const base = {
      id: "m-1",
      role: "assistant" as const,
      date: "",
      content: "",
      isError: false,
    };
    // ① local 终态 + fresh streaming → local(stale 快照不得倒退)
    const localDone = { ...base, content: "本地终态", streaming: false };
    const freshStreaming = { ...base, content: "旧流式", streaming: true };
    expect(mergeFreshMessageWithLocal(freshStreaming, localDone)).toBe(localDone);
    // ② local streaming + fresh settled → fresh(允许向终态推进)
    const localStreaming = { ...base, content: "流式中", streaming: true };
    const freshDone = { ...base, content: "已完成", streaming: false };
    expect(mergeFreshMessageWithLocal(freshDone, localStreaming)).toBe(freshDone);
    // ③ local streaming + fresh streaming → local(防 SSE delta 闪断)
    const freshStreaming2 = { ...base, content: "另一段", streaming: true };
    expect(mergeFreshMessageWithLocal(freshStreaming2, localStreaming)).toBe(
      localStreaming,
    );
  });

  test("PAG2-FE-19B totalCount 防回退:A1 立即同步 + 旧响应 200 不回退 + loadOlder 在途 send", async () => {
    // A1:latest inflight 期间 send → totalCount 立即 202;旧 meta.totalCount=200 不回退
    await seedLoadedConversation("c-1", 200);
    const latestHold = holdLatest("c-1");
    const refreshing = useChatStore.getState().refreshSessionMessages("c-1");
    await tick();
    await useChatStore.getState().onUserInput("A1");
    await tick();
    expect(sessionOf("c-1").messageTotalCount).toBe(202);

    // trailing 在 stale release 的 handoff 微任务链中立即触发 → 先拦截再放行
    const trailingHold = holdLatest("c-1");
    latestHold.release(() =>
      messagePageReply(
        seq(151, 200).map((p) =>
          message(`m-${p}`, "c-1", p % 2 === 1 ? "USER" : "ASSISTANT", `旧 ${p}`, {
            position: p,
          }),
        ),
        encodeMessageCursorOf(151),
        200,
      ),
    );
    await refreshing;
    await tick();
    expect(sessionOf("c-1").messageTotalCount).toBe(202);

    // trailing(meta.totalCount=202)→ 保持 202
    expect(trailingHold.call).not.toBeNull();
    trailingHold.release(() => latestMessagesReply("c-1"));
    await tick();
    expect(sessionOf("c-1").messageTotalCount).toBe(202);

    // 结束 A1 的 Request,清 pending
    const doneId = sessionOf("c-1").pendingRequestId!;
    lastSource().emit(
      "status",
      statusFrame(doneId, {
        status: "COMPLETED",
        requestStatus: "SUCCESS",
        errorCode: null,
        errorMessage: null,
      }),
    );
    await tick();
    expect(sessionOf("c-1").pendingRequestId).toBeUndefined();

    // loadOlder 在途 + send 推高到 204:旧 loadOlder 响应 meta.totalCount=200 不得回退
    const olderHold = holdOlder("c-1");
    const loading = useChatStore.getState().loadOlderMessages("c-1");
    await tick();
    expect(olderHold.call).not.toBeNull();
    await useChatStore.getState().onUserInput("推高");
    await tick();
    expect(sessionOf("c-1").messageTotalCount).toBe(204); // B:max(202,204)
    olderHold.release(() =>
      messagePageReply(
        seq(101, 150).map((p) =>
          message(`m-${p}`, "c-1", p % 2 === 1 ? "USER" : "ASSISTANT", `旧 ${p}`, {
            position: p,
          }),
        ),
        encodeMessageCursorOf(101),
        200,
      ),
    );
    await loading;
    await tick();
    expect(positionsOf("c-1")).toEqual(seq(101, 204));
    expect(sessionOf("c-1").messageTotalCount).toBe(204); // max(204,200)
  });

  test("PAG2-FE-20 messageHistoryError owner:唯一置 true=loadOlder 失败;latest 不越权;success 清 false", async () => {
    await seedLoadedConversation("c-1", 200);
    // ① loadOlder 当前 cursor 失败 → true
    const failHold = holdOlder("c-1");
    const failing = useChatStore.getState().loadOlderMessages("c-1");
    failHold.release(() => fail(500, "INTERNAL_ERROR", "boom"));
    await failing;
    await tick();
    expect(sessionOf("c-1").messageHistoryError).toBe(true);

    // ② latest refresh 失败 → 保持原值 true
    const refreshFail = holdLatest("c-1");
    const r1 = useChatStore.getState().refreshSessionMessages("c-1");
    refreshFail.release(() => fail(500, "INTERNAL_ERROR", "boom"));
    await r1;
    await tick();
    expect(sessionOf("c-1").messageHistoryError).toBe(true);

    // ③ normal overlap refresh 成功 → 仍保持 true(sentinel 不自动复活)
    const refreshOk = holdLatest("c-1");
    const r2 = useChatStore.getState().refreshSessionMessages("c-1");
    refreshOk.release(() => latestMessagesReply("c-1"));
    await r2;
    await tick();
    expect(sessionOf("c-1").messageHistoryError).toBe(true);

    // ④ 合法清 false:loadOlder success
    const retryHold = holdOlder("c-1");
    const retry = useChatStore.getState().loadOlderMessages("c-1");
    retryHold.release(() => olderReply("c-1", encodeMessageCursorOf(151)));
    await retry;
    await tick();
    expect(sessionOf("c-1").messageHistoryError).toBe(false);
  });

  test("PAG2-FE-21 chainEstablished=false trailing 走 bootstrap:cursor/totalCount 权威建立,分页不失效", async () => {
    server.conversations = [conv("c-2", 1), conv("c-1", 2)];
    seedMessages("c-1", 200);
    await useChatStore.getState().bootstrap();
    await tick();
    expect(sessionOf("c-2").loaded).toBe(true);

    const initialHold = holdLatest("c-1");
    useChatStore.getState().selectSession(1);
    await tick();
    expect(initialHold.call).not.toBeNull();

    const refreshing = useChatStore.getState().refreshSessionMessages("c-1");
    // refresh 在 initial 在飞期间调用 → version++ + 登记 pending,自身不发 HTTP

    // ⑥ trailing 到达前:stale initial 不写任何 state(trailing 先拦截再放行)
    const trailingHold = holdLatest("c-1");
    initialHold.release(() => latestMessagesReply("c-1"));
    await refreshing;
    await tick();
    expect(sessionOf("c-1").loaded).toBe(false);
    expect(sessionOf("c-1").messageNextCursor).toBeNull();
    expect(sessionOf("c-1").messages).toHaveLength(0);
    expect(sessionOf("c-1").loadingMessages).toBe(true);

    // ①②③ trailing → bootstrap:loaded/cursor/totalCount 权威落位
    expect(trailingHold.call).not.toBeNull();
    trailingHold.release(() => latestMessagesReply("c-1"));
    await tick();
    let session = sessionOf("c-1");
    expect(session.loaded).toBe(true);
    expect(session.messageNextCursor).toBe(encodeMessageCursorOf(151));
    expect(session.messageTotalCount).toBe(200);
    expect(session.messageHistoryError).toBe(false);
    expect(positionsOf("c-1")).toEqual(seq(151, 200));

    // ④ 随后 loadOlder 正常请求第 2 页(分页未失效)
    const result = await useChatStore.getState().loadOlderMessages("c-1");
    expect(result).toEqual({ applied: true, prependedCount: 50 });
    expect(positionsOf("c-1")).toEqual(seq(101, 200));

    // ⑤ chain 建立后再 refresh → case 1:older cursor 保留(不重复 bootstrap)
    await useChatStore.getState().refreshSessionMessages("c-1");
    await tick();
    session = sessionOf("c-1");
    expect(session.messageNextCursor).toBe(encodeMessageCursorOf(101));
    expect(positionsOf("c-1")).toEqual(seq(101, 200));
  });

  test("PAG2-FE-21A① 五分支 D:draft 首次 send,无 GET,loaded/cursor/totalCount 完整已知", async () => {
    await useChatStore.getState().bootstrap();
    await tick();
    expect(useChatStore.getState().sessions[0]!.draft).toBe(true);

    await useChatStore.getState().onUserInput("第一条");
    await tick();

    expect(messageCalls()).toHaveLength(0);
    const session = useChatStore.getState().sessions[0]!;
    expect(session.draft).toBe(false);
    expect(session.loaded).toBe(true);
    expect(session.messageNextCursor).toBeNull();
    expect(session.messageTotalCount).toBe(2);
    expect(positionsOf(session.id)).toEqual([1, 2]);
    expect(session.pendingRequestId).toMatch(/^req-/);
  });

  test("PAG2-FE-21A② 五分支 A1:latest inflight → version++/pending/totalCount 立即 202", async () => {
    await seedLoadedConversation("c-1", 200);
    const latestHold = holdLatest("c-1");
    const refreshing = useChatStore.getState().refreshSessionMessages("c-1");
    await tick();
    const baseline = latestCalls().length;

    await useChatStore.getState().onUserInput("A1");
    await tick();
    expect(sessionOf("c-1").messageTotalCount).toBe(202); // 立即,不等 trailing
    expect(latestCalls().length).toBe(baseline); // 不并发第二个 HTTP

    // 旧 latest 返回:整体丢弃,send 的 user/assistant 不被覆盖(trailing 先拦截)
    const trailingHold = holdLatest("c-1");
    latestHold.release(() =>
      messagePageReply(
        seq(151, 200).map((p) =>
          message(`m-${p}`, "c-1", p % 2 === 1 ? "USER" : "ASSISTANT", `旧 ${p}`, {
            position: p,
          }),
        ),
        encodeMessageCursorOf(151),
        200,
      ),
    );
    await refreshing;
    await tick();
    expect(positionsOf("c-1")).toEqual(seq(151, 202));
    expect(
      sessionOf("c-1").messages.find(
        (m) => m.role === "user" && m.content === "A1",
      ),
    ).toBeTruthy();

    // trailing 返回 send 后最新页:两条在尾部、总序 asc 无重复、max 校准 202
    expect(trailingHold.call).not.toBeNull();
    trailingHold.release(() => latestMessagesReply("c-1"));
    await tick();
    expect(positionsOf("c-1")).toEqual(seq(151, 202));
    expect(sessionOf("c-1").messageTotalCount).toBe(202);
    const ids = sessionOf("c-1").messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("PAG2-FE-21A③ 五分支 A2:未载既有会话 inflight send → totalCount/loaded 不动,trailing bootstrap 建链", async () => {
    server.conversations = [conv("c-2", 1), conv("c-1", 2)];
    seedMessages("c-1", 200);
    await useChatStore.getState().bootstrap();
    await tick();

    const initialHold = holdLatest("c-1");
    useChatStore.getState().selectSession(1);
    await tick();
    expect(initialHold.call).not.toBeNull();

    await useChatStore.getState().onUserInput("A2");
    await tick();
    let session = sessionOf("c-1");
    expect(session.loaded).toBe(false); // 禁止提前宣称 chain
    expect(session.messageTotalCount).toBe(0); // 禁止 0+2 冒充
    expect(positionsOf("c-1")).toEqual([201, 202]);

    // 旧 initial stale 完全静默(trailing 先拦截再放行)
    const trailingHold = holdLatest("c-1");
    initialHold.release(() => latestMessagesReply("c-1"));
    await tick();
    expect(sessionOf("c-1").loaded).toBe(false);

    // trailing chainEstablished=false → bootstrap 由 meta.totalCount 权威建立
    expect(trailingHold.call).not.toBeNull();
    trailingHold.release(() => latestMessagesReply("c-1"));
    await tick();
    session = sessionOf("c-1");
    expect(session.loaded).toBe(true);
    expect(session.messageNextCursor).toBe(encodeMessageCursorOf(153));
    expect(session.messageTotalCount).toBe(202);
    expect(positionsOf("c-1")).toEqual(seq(153, 202));
  });

  test("PAG2-FE-21A④ 五分支 B:无 inflight 且 chain 已建立 → 恰 0 次新 GET,totalCount=max", async () => {
    await seedLoadedConversation("c-1", 200);
    const baseline = latestCalls().length;
    await useChatStore.getState().onUserInput("B");
    await tick();
    expect(latestCalls().length).toBe(baseline);
    const session = sessionOf("c-1");
    expect(session.loaded).toBe(true);
    expect(session.messageTotalCount).toBe(202);
    expect(positionsOf("c-1")).toEqual(seq(151, 202));
  });

  test("PAG2-FE-21A⑤ 五分支 C:existing unloaded 且无 inflight → bootstrap latest 建链", async () => {
    server.conversations = [conv("c-2", 1), conv("c-1", 2)];
    seedMessages("c-1", 200);
    await useChatStore.getState().bootstrap();
    await tick();

    // 先让 c-1 初次加载失败收场:loaded=false、slot 已释放
    const failHold = holdLatest("c-1");
    useChatStore.getState().selectSession(1);
    failHold.release(() => fail(500, "INTERNAL_ERROR", "boom"));
    await tick();
    expect(sessionOf("c-1").loaded).toBe(false);

    // C:send 成功 → 自动启动 bootstrap latest(loaded 保持 false 直到成功)
    const bootstrapHold = holdLatest("c-1");
    await useChatStore.getState().onUserInput("C");
    await tick();
    let session = sessionOf("c-1");
    expect(session.loaded).toBe(false);
    expect(session.messageTotalCount).toBe(0);
    expect(positionsOf("c-1")).toEqual([201, 202]);
    expect(bootstrapHold.call).not.toBeNull();

    bootstrapHold.release(() => latestMessagesReply("c-1"));
    await tick();
    session = sessionOf("c-1");
    expect(session.loaded).toBe(true);
    expect(session.messageTotalCount).toBe(202);
    expect(session.messageNextCursor).toBe(encodeMessageCursorOf(153));
    expect(positionsOf("c-1")).toEqual(seq(153, 202));
  });

  test("PAG2-FE-21A⑥⑨⑩ draft ensureConversation 成功但 POST 失败 → 空链+错误气泡;重发走 B", async () => {
    await useChatStore.getState().bootstrap();
    await tick();
    // ⑨ ensureConversation 已成功:draft=false、loaded=true(来源 B 合法空链)
    const postHold = holdPost();
    const sending = useChatStore.getState().onUserInput("会失败");
    await tick();
    let session = useChatStore.getState().sessions[0]!;
    expect(session.draft).toBe(false);
    expect(session.loaded).toBe(true);
    expect(session.messageNextCursor).toBeNull();
    expect(session.messageTotalCount).toBe(0);

    postHold.release(() => fail(500, "PROVIDER_LOGIN_REQUIRED", "not logged in"));
    await sending;
    await tick();
    session = useChatStore.getState().sessions[0]!;
    const bubble = session.messages[session.messages.length - 1]!;
    expect(bubble.isError).toBe(true);
    expect(bubble.errorCode).toBe("PROVIDER_LOGIN_REQUIRED");
    expect(bubble.position).toBeUndefined();
    expect(session.messageTotalCount).toBe(0);
    // displayedCount 基础:totalCount(0)+ transient(1)
    expect(
      session.messages.filter((m) => m.position === undefined),
    ).toHaveLength(1);

    // ⑩ 同会话再次 send 成功:无需 bootstrap GET,B:max(0,4)=4
    const baseline = latestCalls().length;
    await useChatStore.getState().onUserInput("重发成功");
    await tick();
    expect(latestCalls().length).toBe(baseline);
    session = useChatStore.getState().sessions[0]!;
    expect(session.messageTotalCount).toBe(4);
    expect(positionsOf(session.id)).toEqual([3, 4]);
    expect(session.pendingRequestId).toMatch(/^req-/);
  });

  test("PAG2-FE-22 pendingRequestId reconciliation:四终态 clear/active 保留/absence 保留/新发现 running", async () => {
    await seedLoadedConversation("c-1", 200);
    const withPending = () => {
      useChatStore.getState().updateTargetSession(sessionOf("c-1"), (target) => {
        target.pendingRequestId = "req-1";
        // ③ 的判定输入是「merge 后 streaming」:fresh STREAMING 会保留 local,
        // 因此本地 m-200 必须先处于 streaming 才能验证保留路径
        const m = target.messages.find((x) => x.id === "m-200");
        if (m) m.streaming = true;
      });
    };
    const freshWith = (
      requestStatus: BackendRequest["status"],
      messageStatus: BackendMessage["status"] = "COMPLETED",
    ) =>
      messagePageReply(
        seq(151, 200).map((p) =>
          p === 200
            ? message("m-200", "c-1", "ASSISTANT", "答案", {
                position: 200,
                status: messageStatus,
                request: {
                  id: "req-1",
                  status: requestStatus,
                  errorCode: null,
                  errorMessage: null,
                },
              })
            : message(`m-${p}`, "c-1", p % 2 === 1 ? "USER" : "ASSISTANT", `c${p}`, {
                position: p,
              }),
        ),
        encodeMessageCursorOf(151),
        200,
      );

    // ② currentPending 在 fresh 内 + 四终态逐一 → clear(TIMEOUT/SUCCESS 同样触发)
    for (const terminal of ["SUCCESS", "FAILED", "TIMEOUT", "CANCELLED"] as const) {
      withPending();
      const hold = holdLatest("c-1");
      const refreshing = useChatStore.getState().refreshSessionMessages("c-1");
      hold.release(() => freshWith(terminal, "COMPLETED"));
      await refreshing;
      await tick();
      expect(sessionOf("c-1").pendingRequestId).toBeUndefined();
    }

    // ③ 仍 active(PENDING/PROCESSING/CANCELLING)+ merge 后 streaming → 保留
    for (const active of ["PENDING", "PROCESSING", "CANCELLING"] as const) {
      withPending();
      const hold = holdLatest("c-1");
      const refreshing = useChatStore.getState().refreshSessionMessages("c-1");
      hold.release(() => freshWith(active, "STREAMING"));
      await refreshing;
      await tick();
      expect(sessionOf("c-1").pendingRequestId).toBe("req-1");
    }

    // ④ request 仍 active 但本地终态已落 → clear,不得重新保持/恢复
    withPending();
    useChatStore.getState().updateTargetSession(sessionOf("c-1"), (target) => {
      const m = target.messages.find((x) => x.id === "m-200")!;
      m.streaming = false;
      m.content = "本地终态";
    });
    const hold4 = holdLatest("c-1");
    const r4 = useChatStore.getState().refreshSessionMessages("c-1");
    hold4.release(() => freshWith("PROCESSING", "STREAMING"));
    await r4;
    await tick();
    expect(sessionOf("c-1").pendingRequestId).toBeUndefined();
    expect(
      sessionOf("c-1").messages.find((m) => m.id === "m-200")!.content,
    ).toBe("本地终态");

    // ⑤ fresh 未包含 currentPending → 保留(absence 不是 terminal proof)
    withPending();
    const hold5 = holdLatest("c-1");
    const r5 = useChatStore.getState().refreshSessionMessages("c-1");
    hold5.release(() =>
      messagePageReply(
        seq(151, 200).map((p) =>
          message(`m-${p}`, "c-1", p % 2 === 1 ? "USER" : "ASSISTANT", `c${p}`, {
            position: p,
          }),
        ),
        encodeMessageCursorOf(151),
        200,
      ),
    );
    await r5;
    await tick();
    expect(sessionOf("c-1").pendingRequestId).toBe("req-1");

    // ⑥ 无 pending + fresh running candidate + merged streaming → 置 pending + follow 恰 1 次
    useChatStore.getState().updateTargetSession(sessionOf("c-1"), (target) => {
      target.pendingRequestId = undefined;
      const m = target.messages.find((x) => x.id === "m-200")!;
      m.streaming = true;
      m.content = "流式中";
    });
    const sourcesBefore = FakeEventSource.instances.length;
    const hold6 = holdLatest("c-1");
    const r6 = useChatStore.getState().refreshSessionMessages("c-1");
    hold6.release(() => freshWith("PROCESSING", "STREAMING"));
    await r6;
    await tick();
    expect(sessionOf("c-1").pendingRequestId).toBe("req-1");
    expect(FakeEventSource.instances.length).toBe(sourcesBefore + 1);

    // ⑦ 无 pending + candidate 已 terminal → 不得从 stale fresh 重新创建
    useChatStore.getState().updateTargetSession(sessionOf("c-1"), (target) => {
      target.pendingRequestId = undefined;
    });
    const hold7 = holdLatest("c-1");
    const r7 = useChatStore.getState().refreshSessionMessages("c-1");
    hold7.release(() => freshWith("SUCCESS", "COMPLETED"));
    await r7;
    await tick();
    expect(sessionOf("c-1").pendingRequestId).toBeUndefined();
  });

  test("PAG2-FE-22A reconciliation 三能力:reload 恢复 / cancel 兜底清 / SSE 先完成不复活", async () => {
    // ① 页面 reload → latest fresh 发现 running → 恢复 pending + followRequest
    server.conversations = [conv("c-1", 1)];
    const seeded = seedMessages("c-1", 199);
    server.messages.set("c-1", [
      ...seeded,
      message("m-200", "c-1", "ASSISTANT", "生成中", {
        position: 200,
        status: "STREAMING",
        request: {
          id: "req-9",
          status: "PROCESSING",
          errorCode: null,
          errorMessage: null,
        },
      }),
    ]);
    await useChatStore.getState().bootstrap();
    await tick();
    expect(sessionOf("c-1").pendingRequestId).toBe("req-9");
    expect(
      FakeEventSource.instances.filter((s) => s.url.includes("req-9")),
    ).toHaveLength(1);

    // ③ SSE 已先完成 → stale HTTP 仍报 running → 不得复活
    lastSource().emit(
      "status",
      statusFrame("req-9", {
        status: "COMPLETED",
        requestStatus: "SUCCESS",
        errorCode: null,
        errorMessage: null,
      }),
    );
    await tick();
    expect(sessionOf("c-1").pendingRequestId).toBeUndefined();
    const staleHold = holdLatest("c-1");
    const refreshing = useChatStore.getState().refreshSessionMessages("c-1");
    staleHold.release(() =>
      messagePageReply(
        seq(151, 200).map((p) =>
          p === 200
            ? message("m-200", "c-1", "ASSISTANT", "生成中", {
                position: 200,
                status: "STREAMING",
                request: {
                  id: "req-9",
                  status: "PROCESSING",
                  errorCode: null,
                  errorMessage: null,
                },
              })
            : message(`m-${p}`, "c-1", p % 2 === 1 ? "USER" : "ASSISTANT", `c${p}`, {
                position: p,
              }),
        ),
        encodeMessageCursorOf(151),
        200,
      ),
    );
    await refreshing;
    await tick();
    expect(
      sessionOf("c-1").messages.find((m) => m.id === "m-200")!.streaming,
    ).toBe(false);
    expect(sessionOf("c-1").pendingRequestId).toBeUndefined();
    expect(
      FakeEventSource.instances.filter((s) => s.url.includes("req-9")),
    ).toHaveLength(1);

    // ② cancel REQUEST_NOT_CANCELLABLE → 回读 fresh 带回终态 → 清 pending
    // (pendingRequestId 只在 POST 响应后落位,捕获必须在 release 之后)
    const postHold = holdPost();
    const sending = useChatStore.getState().onUserInput("再来");
    await tick();
    postHold.release(() => postHold.committed);
    await sending;
    await tick();
    const pendingId = sessionOf("c-1").pendingRequestId!;
    expect(pendingId).toMatch(/^req-/);
    const stored = server.messages.get("c-1")!;
    const lastAssistant = stored[stored.length - 1]!;
    (lastAssistant.request as { status: string }).status = "SUCCESS";
    lastAssistant.status = "COMPLETED";
    const cancelRefresh = holdLatest("c-1");
    await useChatStore.getState().cancelRequest("c-1");
    await tick();
    expect(cancelRefresh.call).not.toBeNull();
    cancelRefresh.release(() => latestMessagesReply("c-1"));
    await tick();
    expect(sessionOf("c-1").pendingRequestId).toBeUndefined();
  });

  test("PAG2-FE-22B 两套 terminal 不混用:isRequestFinished 全枚举 + settled 行为 + 无手写 literal", async () => {
    await seedLoadedConversation("c-1", 200);

    // ① isRequestFinished 是 Request 终态唯一入口
    for (const status of ["SUCCESS", "FAILED", "TIMEOUT", "CANCELLED"] as const) {
      expect(isRequestFinished(status)).toBe(true);
    }
    for (const status of ["PENDING", "PROCESSING", "CANCELLING"] as const) {
      expect(isRequestFinished(status)).toBe(false);
    }

    // ② Message 终态入口(isMessageSettled 推导 streaming):五状态映射
    // fresh 用独立 id(position 201):m-200 在本地是 COMPLETED,按唯一 merge 规则
    // fresh.streaming ? local : fresh 会保留 local,无法观察 fresh 的状态映射
    const freshMessageStatusReply = (status: BackendMessage["status"]) =>
      messagePageReply(
        seq(151, 200)
          .map((p) =>
            message(`m-${p}`, "c-1", p % 2 === 1 ? "USER" : "ASSISTANT", `c${p}`, {
              position: p,
            }),
          )
          .concat([
            message("m-fresh", "c-1", "ASSISTANT", "答案", {
              position: 201,
              status,
            }),
          ]),
        encodeMessageCursorOf(151),
        201,
      );
    for (const status of ["PENDING", "STREAMING"] as const) {
      const hold = holdLatest("c-1");
      const refreshing = useChatStore.getState().refreshSessionMessages("c-1");
      hold.release(() => freshMessageStatusReply(status));
      await refreshing;
      await tick();
      expect(
        sessionOf("c-1").messages.find((m) => m.id === "m-fresh")!.streaming,
      ).toBe(true);
    }
    for (const status of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
      const hold = holdLatest("c-1");
      const refreshing = useChatStore.getState().refreshSessionMessages("c-1");
      hold.release(() => freshMessageStatusReply(status));
      await refreshing;
      await tick();
      const assistant = sessionOf("c-1").messages.find(
        (m) => m.id === "m-fresh",
      )!;
      expect(assistant.streaming).toBe(false);
      expect(assistant.isError).toBe(status === "FAILED");
    }

    // ③ 全 store 分页/reconciliation 路径无手写 Request terminal literal
    const source = readFileSync("app/store/chat.ts", "utf8");
    expect(source.includes('request.status === "COMPLETED"')).toBe(false);
  });

  test("PAG2-FE-23 transient 分类:loadOlder 保留/latest apply 清除/stale 不删/Header 真值", async () => {
    await seedLoadedConversation("c-1", 200);
    const transientOf = () =>
      sessionOf("c-1").messages.filter((m) => m.position === undefined).length;

    // send 失败 → position===undefined 的 error bubble 真实落在 session.messages
    const postHold = holdPost();
    const sending = useChatStore.getState().onUserInput("触发失败");
    postHold.release(() => fail(500, "INTERNAL_ERROR", "boom"));
    await sending;
    await tick();
    expect(transientOf()).toBe(1);

    // ① loadOlder prepend 只动 persisted:失败置 error,transient 原样保留
    const failHold = holdOlder("c-1");
    const older = useChatStore.getState().loadOlderMessages("c-1");
    failHold.release(() => fail(500, "INTERNAL_ERROR", "boom"));
    expect(await older).toEqual({ applied: false, prependedCount: 0 });
    await tick();
    expect(transientOf()).toBe(1);
    expect(sessionOf("c-1").messageHistoryError).toBe(true);

    // ③ stale latest response:version 已被第二次 refresh 超越 → 什么都不写,transient 不删
    const staleHold = holdLatest("c-1");
    const r1 = useChatStore.getState().refreshSessionMessages("c-1");
    const r2 = useChatStore.getState().refreshSessionMessages("c-1");
    const trailingHold = holdLatest("c-1");
    const stalePage = () =>
      messagePageReply(
        seq(151, 200).map((p) =>
          message(`m-${p}`, "c-1", p % 2 === 1 ? "USER" : "ASSISTANT", `旧 ${p}`, {
            position: p,
          }),
        ),
        encodeMessageCursorOf(151),
        200,
      );
    const snapshot = sessionOf("c-1");
    staleHold.release(stalePage);
    await r1;
    await tick();
    expect(sessionOf("c-1")).toBe(snapshot); // 引用不变 = stale 零写入
    expect(transientOf()).toBe(1);

    // ② trailing(当前 version)successful latest apply → transient 清除
    expect(trailingHold.call).not.toBeNull();
    trailingHold.release(stalePage);
    await r2;
    await tick();
    expect(transientOf()).toBe(0);
    expect(positionsOf("c-1")).toEqual(seq(151, 200));
    // REVIEW-29:latest refresh 不清 older 失败态
    expect(sessionOf("c-1").messageHistoryError).toBe(true);

    // ④ Header displayedCount 真值:chain 已建立 = totalCount + transientCount
    const postHold2 = holdPost();
    const sending2 = useChatStore.getState().onUserInput("再次失败");
    postHold2.release(() => fail(500, "INTERNAL_ERROR", "boom"));
    await sending2;
    await tick();
    expect(sessionOf("c-1").messageTotalCount).toBe(200);
    expect(transientOf()).toBe(1); // 200 + 1
  });

  test("PAG2-FE-24 原子 handoff/不重复 bump/无 pending 清理/stale 静默/current 失败/bootstrap 失败可重建/guard 挡并发", async () => {
    const consoleError = jest.spyOn(console, "error");
    const errCount = () => consoleError.mock.calls.length;
    await seedLoadedConversation("c-1", 200);
    const stalePage = () =>
      messagePageReply(
        seq(151, 200).map((p) =>
          message(`m-${p}`, "c-1", p % 2 === 1 ? "USER" : "ASSISTANT", `旧 ${p}`, {
            position: p,
          }),
        ),
        encodeMessageCursorOf(151),
        200,
      );
    const freshTailPage = () =>
      messagePageReply(
        seq(151, 199)
          .map((p) =>
            message(`m-${p}`, "c-1", p % 2 === 1 ? "USER" : "ASSISTANT", `c${p}`, {
              position: p,
            }),
          )
          .concat(
            message("m-200", "c-1", "ASSISTANT", "当前尾", { position: 200 }),
          ),
        encodeMessageCursorOf(151),
        200,
      );

    // ①④:双 refresh → 旧响应 stale failure 静默 → 原子 handoff
    const messagesBefore = sessionOf("c-1").messages;
    const trace: { loading: boolean; reapplied: boolean }[] = [];
    const unsubscribe = useChatStore.subscribe((state) => {
      const s = state.sessions.find((x) => x.id === "c-1");
      trace.push({
        loading: s?.loadingMessages ?? false,
        reapplied: !!s && s.messages !== messagesBefore,
      });
    });
    const holdA = holdLatest("c-1");
    const r1 = useChatStore.getState().refreshSessionMessages("c-1");
    const r2 = useChatStore.getState().refreshSessionMessages("c-1"); // bump + pending
    const trailingHold = holdLatest("c-1");
    const errorsBefore = errCount();
    holdA.release(() => fail(500, "INTERNAL_ERROR", "boom")); // ④ stale failure
    await r1;
    await tick();
    expect(errCount()).toBe(errorsBefore); // 静默:不 notifyError
    expect(sessionOf("c-1").loaded).toBe(true);
    expect(positionsOf("c-1")).toEqual(seq(151, 200));
    expect(sessionOf("c-1").messageNextCursor).toBe(encodeMessageCursorOf(151));
    expect(sessionOf("c-1").messageTotalCount).toBe(200);
    expect(sessionOf("c-1").messageHistoryError).toBe(false);

    // ⑦a:trailing 在飞 → 新 loadSessionMessages 被 guard 挡,无并发第二 HTTP
    expect(trailingHold.call).not.toBeNull();
    const latestBaseline = latestCalls().length;
    await useChatStore.getState().loadSessionMessages("c-1");
    expect(latestCalls().length).toBe(latestBaseline);

    // ②:trailing 以当前 version 启动 → 响应判为 latest 并落盘(重复 bump 会让其自判 stale)
    trailingHold.release(freshTailPage);
    await r2;
    await tick();
    unsubscribe();
    expect(
      sessionOf("c-1").messages.find((m) => m.id === "m-200")!.content,
    ).toBe("当前尾");
    const appliedIndex = trace.findIndex((t) => t.reapplied);
    expect(appliedIndex).toBeGreaterThan(-1);
    for (let i = 0; i <= appliedIndex; i++) {
      expect(trace[i].loading).toBe(true); // ①:trailing 结束前无 false 中间窗口
    }
    expect(trace[trace.length - 1].loading).toBe(false); // ③a:结束才落 false

    // ③b:无 pending → slot 已删 + loadingMessages=false;再 refresh 发出新 HTTP(不折叠 pending)
    const againHold = holdLatest("c-1");
    const r3 = useChatStore.getState().refreshSessionMessages("c-1");
    expect(againHold.call).not.toBeNull();
    againHold.release(freshTailPage);
    await r3;
    await tick();
    expect(sessionOf("c-1").loadingMessages).toBe(false);

    // ⑤:current refresh failure → messages/cursor/error/totalCount/loaded 全保留 + notifyError 恰 1 次
    const failHold = holdLatest("c-1");
    const failing = useChatStore.getState().refreshSessionMessages("c-1");
    const before = sessionOf("c-1");
    const errorsBeforeFail = errCount();
    failHold.release(() => fail(500, "INTERNAL_ERROR", "boom"));
    await failing;
    await tick();
    expect(errCount()).toBe(errorsBeforeFail + 1);
    expect(sessionOf("c-1").messages).toBe(before.messages);
    expect(sessionOf("c-1").messageNextCursor).toBe(before.messageNextCursor);
    expect(sessionOf("c-1").messageTotalCount).toBe(before.messageTotalCount);
    expect(sessionOf("c-1").loaded).toBe(before.loaded);
    expect(sessionOf("c-1").messageHistoryError).toBe(before.messageHistoryError);
    expect(sessionOf("c-1").loadingMessages).toBe(false);

    // ⑥:bootstrap failure(loaded=false)→ 继续 false、不建 cursor、本地 send result 保留 + notifyError,后续 refresh 可重建
    server.conversations.push(conv("c-9", 5));
    seedMessages("c-9", 200);
    await useChatStore.getState().reloadList();
    await tick();
    const c9Index = useChatStore
      .getState()
      .sessions.findIndex((s) => s.id === "c-9");
    const initialHold = holdLatest("c-9");
    useChatStore.getState().selectSession(c9Index);
    await tick();
    expect(initialHold.call).not.toBeNull();
    await useChatStore.getState().onUserInput("A2 send"); // A2:本地 pair + version bump + pending
    await tick();
    expect(sessionOf("c-9").loaded).toBe(false);
    expect(positionsOf("c-9")).toEqual([201, 202]);
    const requestIdC9 = sessionOf("c-9").pendingRequestId!;
    expect(requestIdC9).toMatch(/^req-/);
    const trailingFail = holdLatest("c-9");
    initialHold.release(() => fail(500, "INTERNAL_ERROR", "boom")); // stale:静默
    await tick();
    expect(trailingFail.call).not.toBeNull();
    const errorsBeforeBootstrap = errCount();
    trailingFail.release(() => fail(500, "INTERNAL_ERROR", "boom")); // current bootstrap failure
    await tick();
    expect(errCount()).toBe(errorsBeforeBootstrap + 1);
    let c9 = sessionOf("c-9");
    expect(c9.loaded).toBe(false);
    expect(c9.messageNextCursor).toBeNull();
    expect(positionsOf("c-9")).toEqual([201, 202]);
    expect(c9.pendingRequestId).toBe(requestIdC9);
    const rebuildHold = holdLatest("c-9");
    const rebuild = useChatStore.getState().refreshSessionMessages("c-9");
    expect(rebuildHold.call).not.toBeNull();
    rebuildHold.release(() => latestMessagesReply("c-9"));
    await rebuild;
    await tick();
    c9 = sessionOf("c-9");
    expect(c9.loaded).toBe(true);
    expect(c9.messageTotalCount).toBe(202);
    expect(c9.messageNextCursor).toBe(encodeMessageCursorOf(153));
    expect(c9.pendingRequestId).toBe(requestIdC9); // 同 request 只同步,不复活

    // ⑦b:unloaded initial stale → trailing 链路中 loadSessionMessages 被 guard 挡(全程恰 2 个 HTTP)
    server.conversations.push(conv("c-8", 6));
    seedMessages("c-8", 200);
    await useChatStore.getState().reloadList();
    await tick();
    const c8Index = useChatStore
      .getState()
      .sessions.findIndex((s) => s.id === "c-8");
    const c8Initial = holdLatest("c-8");
    useChatStore.getState().selectSession(c8Index);
    await tick();
    expect(c8Initial.call).not.toBeNull();
    const c8Refresh = useChatStore.getState().refreshSessionMessages("c-8");
    const c8Trailing = holdLatest("c-8");
    c8Initial.release(() => fail(500, "INTERNAL_ERROR", "boom")); // stale 静默 → handoff
    await tick();
    expect(c8Trailing.call).not.toBeNull();
    const c8Baseline = latestCalls().length;
    await useChatStore.getState().loadSessionMessages("c-8"); // loadingMessages=true → guard
    expect(latestCalls().length).toBe(c8Baseline);
    c8Trailing.release(() => latestMessagesReply("c-8"));
    await c8Refresh;
    await tick();
    expect(sessionOf("c-8").loaded).toBe(true);
    expect(positionsOf("c-8")).toEqual(seq(151, 200));
    expect(latestCalls().length).toBe(c8Baseline);
  });

  test("PAG2-FE-25 empty latest page 三分支:合法空链/authoritative reset/inconsistent 不 apply", async () => {
    const consoleError = jest.spyOn(console, "error");
    const errCount = () => consoleError.mock.calls.length;
    const emptyPage = () => messagePageReply([], null, 0);

    // ① chainEstablished=false + fresh=[] → 合法空链 bootstrap
    // (bootstrap 会自动加载 active 会话 → 首查 hold 必须先于 bootstrap 注册)
    server.conversations = [conv("c-7", 1)];
    const emptyHold = holdLatest("c-7");
    await useChatStore.getState().bootstrap();
    await tick();
    expect(emptyHold.call).not.toBeNull();
    emptyHold.release(emptyPage);
    await tick();
    let session = sessionOf("c-7");
    expect(session.loaded).toBe(true);
    expect(session.messages).toEqual([]);
    expect(session.messageNextCursor).toBeNull();
    expect(session.messageTotalCount).toBe(0);
    expect(session.messageHistoryError).toBe(false);
    expect(session.pendingRequestId).toBeUndefined();

    // ② chainEstablished=true + fresh=[] && totalCount=0 → 异常 authoritative reset
    const resetHold = holdLatest("c-7");
    const reset = useChatStore.getState().refreshSessionMessages("c-7");
    expect(resetHold.call).not.toBeNull();
    resetHold.release(emptyPage);
    await reset;
    await tick();
    session = sessionOf("c-7");
    expect(session.loaded).toBe(true);
    expect(session.messages).toEqual([]);
    expect(session.messageNextCursor).toBeNull();
    expect(session.messageTotalCount).toBe(0);
    expect(session.messageHistoryError).toBe(false);
    expect(session.pendingRequestId).toBeUndefined();

    // ③ fresh=[] && totalCount>0 → inconsistent:不 apply、notifyError、原 state 不动
    server.messages.set("c-7", [
      message("m-1", "c-7", "USER", "一", { position: 1 }),
      message("m-2", "c-7", "ASSISTANT", "二", { position: 2 }),
    ]);
    const fillHold = holdLatest("c-7");
    const fill = useChatStore.getState().refreshSessionMessages("c-7");
    fillHold.release(() => latestMessagesReply("c-7"));
    await fill;
    await tick();
    session = sessionOf("c-7");
    expect(positionsOf("c-7")).toEqual([1, 2]);
    expect(session.messageTotalCount).toBe(2);

    const stateBefore = sessionOf("c-7");
    const errorsBefore = errCount();
    const badHold = holdLatest("c-7");
    const bad = useChatStore.getState().refreshSessionMessages("c-7");
    badHold.release(() => messagePageReply([], null, 5));
    await bad;
    await tick();
    expect(errCount()).toBe(errorsBefore + 1);
    expect(sessionOf("c-7").messages).toBe(stateBefore.messages);
    expect(sessionOf("c-7").messageTotalCount).toBe(2);
    expect(sessionOf("c-7").messageNextCursor).toBe(
      stateBefore.messageNextCursor,
    );
    expect(sessionOf("c-7").loaded).toBe(true);
  });

  test("PAG2-FE-26 reconciliation 不重复 follow:POST-first 恰 1 次+trailing 同 request 不 reopen;首次 load 新发现恰 1 次", async () => {
    await seedLoadedConversation("c-1", 200);

    // ① POST-first:send reconciliation(S2)→ follow 恰 1 次
    // (pendingRequestId 只在 POST 响应后落位,捕获必须在 release 之后)
    const postHold = holdPost();
    const sending = useChatStore.getState().onUserInput("POST-first");
    await tick();
    postHold.release(() => postHold.committed);
    await sending;
    await tick();
    const requestId = sessionOf("c-1").pendingRequestId!;
    expect(requestId).toMatch(/^req-/);
    const followsOf = () =>
      FakeEventSource.instances.filter((s) => s.url.includes(requestId)).length;
    expect(followsOf()).toBe(1);

    // trailing latest:fresh 显示同一 request 仍 active → 只同步状态,不 close/reopen
    const refreshHold = holdLatest("c-1");
    const refreshing = useChatStore.getState().refreshSessionMessages("c-1");
    expect(refreshHold.call).not.toBeNull();
    refreshHold.release(() => latestMessagesReply("c-1"));
    await refreshing;
    await tick();
    expect(sessionOf("c-1").pendingRequestId).toBe(requestId);
    expect(followsOf()).toBe(1);

    // ② 页面首次 load:无 pending → fresh 发现 req-6 running → follow 恰 1 次
    server.conversations.push(conv("c-6", 5));
    seedMessages("c-6", 10);
    server.messages.get("c-6")!.push(
      message("m-11", "c-6", "ASSISTANT", "生成中", {
        position: 11,
        status: "STREAMING",
        request: {
          id: "req-6",
          status: "PROCESSING",
          errorCode: null,
          errorMessage: null,
        },
      }),
    );
    await useChatStore.getState().reloadList();
    await tick();
    const c6Index = useChatStore
      .getState()
      .sessions.findIndex((s) => s.id === "c-6");
    const c6Hold = holdLatest("c-6");
    useChatStore.getState().selectSession(c6Index);
    await tick();
    expect(c6Hold.call).not.toBeNull();
    c6Hold.release(() => latestMessagesReply("c-6"));
    await tick();
    expect(sessionOf("c-6").pendingRequestId).toBe("req-6");
    expect(
      FakeEventSource.instances.filter((s) => s.url.includes("req-6")),
    ).toHaveLength(1);
  });

  test("PAG2-FE-27 bootstrap 同 id overlay(①..⑤):fresh 建 chain,本地 SSE 较新内容不被倒退,不重复 follow", async () => {
    server.conversations = [conv("c-2", 1), conv("c-1", 2)];
    seedMessages("c-1", 200);
    await useChatStore.getState().bootstrap();
    await tick();

    // A2 场景:initial inflight → send(本地 pair + S2 follow)→ SSE 推进内容 → 旧 initial stale
    const initialHold = holdLatest("c-1");
    useChatStore.getState().selectSession(1);
    await tick();
    expect(initialHold.call).not.toBeNull();
    const postHold = holdPost();
    const sending = useChatStore.getState().onUserInput("A2 overlay");
    await tick();
    postHold.release(() => postHold.committed);
    await sending;
    await tick();
    const stored = server.messages.get("c-1")!;
    const userId = stored[stored.length - 2]!.id;
    const assistantId = stored[stored.length - 1]!.id;
    const requestId = sessionOf("c-1").pendingRequestId!;
    expect(requestId).toMatch(/^req-/);
    expect(
      FakeEventSource.instances.filter((s) => s.url.includes(requestId)),
    ).toHaveLength(1);
    lastSource().emit("snapshot", { content: "abcdefghij" });
    await tick();
    expect(
      sessionOf("c-1").messages.find((m) => m.id === assistantId)!.content,
    ).toBe("abcdefghij");

    // 旧 initial stale:静默,零写入(A2 handoff 的 trailing 先拦截再放行)
    const trailingHold = holdLatest("c-1");
    initialHold.release(() => latestMessagesReply("c-1"));
    await tick();
    expect(sessionOf("c-1").loaded).toBe(false);
    expect(sessionOf("c-1").pendingRequestId).toBe(requestId);
    expect(
      FakeEventSource.instances.filter((s) => s.url.includes(requestId)),
    ).toHaveLength(1);

    // trailing bootstrap:same assistant id / content="abcde" / STREAMING / request active
    expect(trailingHold.call).not.toBeNull();
    trailingHold.release(() =>
      messagePageReply(
        seq(153, 200)
          .map((p) =>
            message(`m-${p}`, "c-1", p % 2 === 1 ? "USER" : "ASSISTANT", `c${p}`, {
              position: p,
            }),
          )
          .concat([
            message(userId, "c-1", "USER", "A2 overlay", { position: 201 }),
            message(assistantId, "c-1", "ASSISTANT", "abcde", {
              position: 202,
              status: "STREAMING",
              request: {
                id: requestId,
                status: "PROCESSING",
                errorCode: null,
                errorMessage: null,
              },
            }),
          ]),
        encodeMessageCursorOf(153),
        202,
      ),
    );
    await tick();
    const session = sessionOf("c-1");
    expect(session.loaded).toBe(true); // ① fresh 建 chain
    expect(session.messageNextCursor).toBe(encodeMessageCursorOf(153)); // ②
    expect(session.messageTotalCount).toBe(202);
    const assistant = session.messages.find((m) => m.id === assistantId)!;
    expect(assistant.content).toBe("abcdefghij"); // ③ overlay:local streaming 内容保留
    expect(assistant.streaming).toBe(true); // ④
    expect(session.pendingRequestId).toBe(requestId); // ⑤ 不复活不重建
    expect(
      FakeEventSource.instances.filter((s) => s.url.includes(requestId)),
    ).toHaveLength(1);
    expect(positionsOf("c-1")).toEqual(seq(153, 202));
  });

  test("PAG2-FE-27⑥ local 已 COMPLETED + fresh stale STREAMING → terminal 不倒退", async () => {
    server.conversations = [conv("c-2", 1), conv("c-1", 2)];
    seedMessages("c-1", 200);
    await useChatStore.getState().bootstrap();
    await tick();

    const initialHold = holdLatest("c-1");
    useChatStore.getState().selectSession(1);
    await tick();
    const postHold = holdPost();
    const sending = useChatStore.getState().onUserInput("A2 terminal");
    await tick();
    postHold.release(() => postHold.committed);
    await sending;
    await tick();
    const stored = server.messages.get("c-1")!;
    const assistantId = stored[stored.length - 1]!.id;
    const requestId = sessionOf("c-1").pendingRequestId!;
    lastSource().emit("snapshot", { content: "abcdefghij" });
    lastSource().emit(
      "status",
      statusFrame(requestId, {
        status: "COMPLETED",
        requestStatus: "SUCCESS",
        errorCode: null,
        errorMessage: null,
      }),
    );
    await tick();
    expect(sessionOf("c-1").pendingRequestId).toBeUndefined();

    // trailing bootstrap 带 stale STREAMING:同 id overlay 保 local COMPLETED
    const trailingHold = holdLatest("c-1");
    initialHold.release(() => latestMessagesReply("c-1")); // stale 静默
    await tick();
    expect(trailingHold.call).not.toBeNull();
    trailingHold.release(() =>
      messagePageReply(
        seq(153, 200)
          .map((p) =>
            message(`m-${p}`, "c-1", p % 2 === 1 ? "USER" : "ASSISTANT", `c${p}`, {
              position: p,
            }),
          )
          .concat([
            message("msg-user-x", "c-1", "USER", "A2 terminal", {
              position: 201,
            }),
            message(assistantId, "c-1", "ASSISTANT", "abcde", {
              position: 202,
              status: "STREAMING",
              request: {
                id: requestId,
                status: "PROCESSING",
                errorCode: null,
                errorMessage: null,
              },
            }),
          ]),
        encodeMessageCursorOf(153),
        202,
      ),
    );
    await tick();
    const assistant = sessionOf("c-1").messages.find(
      (m) => m.id === assistantId,
    )!;
    expect(assistant.content).toBe("abcdefghij");
    expect(assistant.streaming).toBe(false);
    expect(assistant.isError).toBe(false);
    expect(sessionOf("c-1").pendingRequestId).toBeUndefined(); // merged terminal → clear
    expect(
      FakeEventSource.instances.filter((s) => s.url.includes(requestId)),
    ).toHaveLength(1); // 不重复 follow
    expect(sessionOf("c-1").loaded).toBe(true);
  });

  test("PAG2-FE-27⑦ 本地 send result + fresh=[] totalCount=0 → inconsistent 不 apply", async () => {
    const consoleError = jest.spyOn(console, "error");
    const errCount = () => consoleError.mock.calls.length;
    server.conversations = [conv("c-2", 1), conv("c-1", 2)];
    seedMessages("c-1", 200);
    await useChatStore.getState().bootstrap();
    await tick();

    const initialHold = holdLatest("c-1");
    useChatStore.getState().selectSession(1);
    await tick();
    const postHold = holdPost();
    const sending = useChatStore.getState().onUserInput("A2 empty");
    await tick();
    postHold.release(() => postHold.committed);
    await sending;
    await tick();
    const requestId = sessionOf("c-1").pendingRequestId!;
    expect(positionsOf("c-1")).toEqual([201, 202]);
    expect(
      FakeEventSource.instances.filter((s) => s.url.includes(requestId)),
    ).toHaveLength(1);

    const trailingHold = holdLatest("c-1");
    initialHold.release(() => latestMessagesReply("c-1")); // stale 静默
    await tick();
    expect(trailingHold.call).not.toBeNull();
    const errorsBefore = errCount();
    trailingHold.release(() => messagePageReply([], null, 0));
    await tick();
    expect(errCount()).toBe(errorsBefore + 1); // notifyError
    const session = sessionOf("c-1");
    expect(session.loaded).toBe(false); // loaded 保持 false
    expect(session.messageNextCursor).toBeNull();
    expect(positionsOf("c-1")).toEqual([201, 202]); // 本地 send result 保留
    expect(session.pendingRequestId).toBe(requestId); // SSE state 保留
    expect(
      FakeEventSource.instances.filter((s) => s.url.includes(requestId)),
    ).toHaveLength(1);
  });

  test("PAG2-FE-28 Case 0:空链 refresh 重建非空链,cursor=fresh.nextCursor,可继续 loadOlder", async () => {
    // 合法空 chain:bootstrap 空会话 → loaded=true / 0 条
    // (bootstrap 会自动加载 active 会话 → 首查 hold 必须先于 bootstrap 注册)
    server.conversations = [conv("c-5", 1)];
    const emptyHold = holdLatest("c-5");
    await useChatStore.getState().bootstrap();
    await tick();
    expect(emptyHold.call).not.toBeNull();
    emptyHold.release(() => messagePageReply([], null, 0));
    await tick();
    let session = sessionOf("c-5");
    expect(session.loaded).toBe(true);
    expect(session.messages).toEqual([]);

    // Backend 侧随后出现 100 条:manual refresh Case 0 重建非空链
    seedMessages("c-5", 100);
    const refreshHold = holdLatest("c-5");
    const refreshing = useChatStore.getState().refreshSessionMessages("c-5");
    expect(refreshHold.call).not.toBeNull();
    refreshHold.release(() => latestMessagesReply("c-5"));
    await refreshing;
    await tick();
    session = sessionOf("c-5");
    expect(positionsOf("c-5")).toEqual(seq(51, 100)); // ①
    expect(session.messageNextCursor).toBe(encodeMessageCursorOf(51)); // ② ≠ null
    expect(session.messageTotalCount).toBe(100); // ③
    expect(session.loaded).toBe(true);
    expect(session.messageHistoryError).toBe(false);

    // ④ 链可继续分页
    const result = await useChatStore.getState().loadOlderMessages("c-5");
    expect(result).toEqual({ applied: true, prependedCount: 50 });
    expect(positionsOf("c-5")).toEqual(seq(1, 100));
  });

  test("PAG2-FE-29① GET 先于 POST response 见 send pair:reconciliation 先行,id-upsert 不重复 totalCount 202", async () => {
    server.conversations = [conv("c-2", 1), conv("c-1", 2)];
    seedMessages("c-1", 200);
    await useChatStore.getState().bootstrap();
    await tick();

    const initialHold = holdLatest("c-1");
    useChatStore.getState().selectSession(1);
    await tick();
    expect(initialHold.call).not.toBeNull();

    // POST 事务先 commit(send pair 已进 DB),response 挂起
    const postHold = holdPost();
    const sending = useChatStore.getState().onUserInput("GET-first");
    await tick();

    // initial GET 先返回:fresh 已含 pair → pending + follow 恰 1 次
    initialHold.release(() => latestMessagesReply("c-1"));
    await tick();
    expect(sessionOf("c-1").loaded).toBe(true);
    expect(sessionOf("c-1").messageTotalCount).toBe(202);
    const requestId = sessionOf("c-1").pendingRequestId!;
    expect(requestId).toMatch(/^req-/);
    expect(
      FakeEventSource.instances.filter((s) => s.url.includes(requestId)),
    ).toHaveLength(1);

    // POST response 后到:同 id upsert,S1 不重复 follow,不额外 bootstrap GET
    postHold.release(() => postHold.committed);
    await sending;
    await tick();
    const stored = server.messages.get("c-1")!;
    const userId = stored[stored.length - 2]!.id;
    const assistantId = stored[stored.length - 1]!.id;
    const messages = sessionOf("c-1").messages;
    expect(messages.filter((m) => m.id === userId)).toHaveLength(1);
    expect(messages.filter((m) => m.id === assistantId)).toHaveLength(1);
    expect(sessionOf("c-1").messageTotalCount).toBe(202); // 不是 204
    expect(sessionOf("c-1").pendingRequestId).toBe(requestId); // S1 保持
    expect(
      FakeEventSource.instances.filter((s) => s.url.includes(requestId)),
    ).toHaveLength(1);
    const ids = messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(positionsOf("c-1")).toEqual(seq(153, 202));
    const latestAfter = latestCalls().length;
    await tick();
    expect(latestCalls().length).toBe(latestAfter); // 无额外 bootstrap GET
  });

  test("PAG2-FE-29② assistant stale 子场景:SSE 已推进的 content 不被 POST 旧 PENDING 倒退", async () => {
    server.conversations = [conv("c-2", 1), conv("c-1", 2)];
    seedMessages("c-1", 200);
    await useChatStore.getState().bootstrap();
    await tick();

    const initialHold = holdLatest("c-1");
    useChatStore.getState().selectSession(1);
    await tick();
    const postHold = holdPost();
    const sending = useChatStore.getState().onUserInput("GET-first");
    await tick();

    initialHold.release(() => latestMessagesReply("c-1"));
    await tick();
    const stored = server.messages.get("c-1")!;
    const assistantId = stored[stored.length - 1]!.id;
    const requestId = sessionOf("c-1").pendingRequestId!;

    // SSE 先把 A202 推进到 "abcdefghij";POST response 中的 A202 仍 PENDING/空 content
    lastSource().emit("snapshot", { content: "abcdefghij" });
    await tick();
    expect(
      sessionOf("c-1").messages.find((m) => m.id === assistantId)!.content,
    ).toBe("abcdefghij");

    postHold.release(() => postHold.committed);
    await sending;
    await tick();
    const assistant = sessionOf("c-1").messages.find(
      (m) => m.id === assistantId,
    )!;
    expect(assistant.content).toBe("abcdefghij");
    expect(assistant.streaming).toBe(true);
    expect(sessionOf("c-1").pendingRequestId).toBe(requestId);
    expect(
      FakeEventSource.instances.filter((s) => s.url.includes(requestId)),
    ).toHaveLength(1);
  });

  test("PAG2-FE-29③ GET 先于 send commit:普通 upsert,max(200,202)=202,无额外 GET 无重复", async () => {
    await seedLoadedConversation("c-1", 200);
    const latestBefore = latestCalls().length;

    const postHold = holdPost();
    const sending = useChatStore.getState().onUserInput("反向");
    await tick();
    postHold.release(() => postHold.committed);
    await sending;
    await tick();

    const stored = server.messages.get("c-1")!;
    const userId = stored[stored.length - 2]!.id;
    const assistantId = stored[stored.length - 1]!.id;
    const messages = sessionOf("c-1").messages;
    expect(messages.filter((m) => m.id === userId)).toHaveLength(1);
    expect(messages.filter((m) => m.id === assistantId)).toHaveLength(1);
    expect(sessionOf("c-1").messageTotalCount).toBe(202);
    expect(positionsOf("c-1")).toEqual(seq(151, 202));
    const ids = messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(latestCalls().length).toBe(latestBefore); // 无额外 bootstrap GET
  });

  test("PAG2-FE-30① stale POST PENDING 后到:terminal 不倒退、pending 不复活、不新增 follow", async () => {
    await seedLoadedConversation("c-1", 200);
    const postHold = holdPost();
    const sending = useChatStore.getState().onUserInput("晚到的 POST");
    await tick(); // 事务已 commit(201/202)

    // GET/SSE 先行:latest 回读看到 PENDING pair → pending + follow;SSE 随即完成
    const refreshHold = holdLatest("c-1");
    const refreshing = useChatStore.getState().refreshSessionMessages("c-1");
    expect(refreshHold.call).not.toBeNull();
    refreshHold.release(() => latestMessagesReply("c-1"));
    await refreshing;
    await tick();
    const stored = server.messages.get("c-1")!;
    const assistantId = stored[stored.length - 1]!.id;
    const requestId = sessionOf("c-1").pendingRequestId!;
    expect(requestId).toMatch(/^req-/);
    lastSource().emit("snapshot", { content: "SSE 权威回答" });
    lastSource().emit(
      "status",
      statusFrame(requestId, {
        status: "COMPLETED",
        requestStatus: "SUCCESS",
        errorCode: null,
        errorMessage: null,
      }),
    );
    await tick();
    let assistant = sessionOf("c-1").messages.find((m) => m.id === assistantId)!;
    expect(assistant.content).toBe("SSE 权威回答");
    expect(assistant.streaming).toBe(false);
    expect(sessionOf("c-1").pendingRequestId).toBeUndefined();

    // POST response 最后到达(request PENDING / assistant PENDING 空 content)
    const followsBefore = FakeEventSource.instances.filter((s) =>
      s.url.includes(requestId),
    ).length;
    postHold.release(() => postHold.committed);
    await sending;
    await tick();
    assistant = sessionOf("c-1").messages.find((m) => m.id === assistantId)!;
    expect(assistant.content).toBe("SSE 权威回答");
    expect(assistant.streaming).toBe(false);
    expect(assistant.isError).toBe(false);
    expect(sessionOf("c-1").pendingRequestId).toBeUndefined();
    expect(
      FakeEventSource.instances.filter((s) => s.url.includes(requestId)),
    ).toHaveLength(followsBefore);
  });

  test("PAG2-FE-30② deduplicated terminal:content 落位、streaming=false、不建 pending、不 follow", async () => {
    await seedLoadedConversation("c-1", 200);
    const dupHold = holdPost();
    const dupSend = useChatStore.getState().onUserInput("重放");
    await tick();
    dupHold.release(() =>
      reply(201, {
        data: {
          request: request("req-dup", "c-1", "m-dup-u", "m-dup-a", "SUCCESS"),
          userMessage: message("m-dup-u", "c-1", "USER", "重放", {
            position: 201,
          }),
          assistantMessage: message("m-dup-a", "c-1", "ASSISTANT", "done", {
            status: "COMPLETED",
            position: 202,
          }),
          deduplicated: true,
        },
      }),
    );
    await dupSend;
    await tick();
    const session = sessionOf("c-1");
    const assistant = session.messages.find((m) => m.id === "m-dup-a")!;
    expect(assistant.content).toBe("done");
    expect(assistant.streaming).toBe(false); // 无手工 streaming=true
    expect(session.pendingRequestId).toBeUndefined(); // terminal 不建 pending
    expect(FakeEventSource.instances).toHaveLength(0); // follow = 0
    expect(session.messageTotalCount).toBe(202);
    expect(positionsOf("c-1")).toEqual(seq(151, 202));
  });
});
