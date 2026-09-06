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
};

function resetServer() {
  server.conversations = [];
  server.messages = new Map();
  server.sendSeq = 0;
  calls.length = 0;
  FakeEventSource.instances = [];
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
    const status = new URLSearchParams(listMatch[1]).get("status");
    return reply(200, {
      data: server.conversations.filter((c) => c.status === status),
      meta: { nextCursor: null },
    });
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
      calls.push({
        url,
        method,
        body: parsed,
        headers: (init.headers ?? {}) as Record<string, string>,
      });
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
});
