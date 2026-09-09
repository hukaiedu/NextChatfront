import { jest } from "@jest/globals";
// chat store 必须先于组件导入:组件经 store/index 形成循环依赖,
// 先完成 chat.ts 求值可避免 Locale 未初始化
import { ChatSession, useChatStore } from "../app/store/chat";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ModelSelectorButton } from "../app/components/model-selector";
import { StoreKey } from "../app/constant";
import { createEmptyMask } from "../app/store/mask";
import Locale from "../app/locales";
import { indexedDBStorage } from "../app/utils/indexedDB-storage";
import type {
  BackendConversation,
  BackendMessage,
  BackendModelOption,
  ConversationStatus,
} from "../app/client/backend-api";

/**
 * M4 验收用例(§二十六):模型选择器 = 会话偏好 PATCH + 目录读取。
 * FIX-05:已持久化会话发送不带 modelKey;Draft 明确选模型后首发带 modelKey。
 * 套路与 backend-chat-store.test.ts 相同:不 mock API Client,从最外层伪造 HTTP。
 */

const STAMP = "2026-09-05T00:00:00.000Z";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function conversation(
  id: string,
  title: string,
  preferredModelKey: string | null = null,
  status: ConversationStatus | "DELETED" = "ACTIVE",
): BackendConversation {
  return {
    id,
    title,
    status,
    provider: "gemini",
    providerConversationUrl: null,
    preferredModelKey,
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: null,
  };
}

function message(
  id: string,
  conversationId: string,
  role: BackendMessage["role"],
  content: string,
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
  };
}

const MODELS: BackendModelOption[] = [
  { key: "kA", label: "模型甲", selected: false, disabled: false },
  { key: "kB", label: "模型乙", selected: true, disabled: false },
  { key: "kOff", label: "模型丙(停用)", selected: false, disabled: true },
];

interface RecordedCall {
  url: string;
  method: string;
  body?: any;
}

const calls: RecordedCall[] = [];
const server = {
  conversations: [] as BackendConversation[],
  messages: new Map<string, BackendMessage[]>(),
  models: MODELS,
  /** 打开的会话 id;null = 没有活动会话 */
  openConversationId: null as string | null,
  failModels: false as false | "GENERIC" | "PROVIDER_NOT_READY",
  failPatch: false,
  failCreate: false,
};

function resetServer() {
  server.conversations = [];
  server.messages = new Map();
  server.models = MODELS;
  server.openConversationId = null;
  server.failModels = false;
  server.failPatch = false;
  server.failCreate = false;
  calls.length = 0;
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
  if (url === "/backend-api/provider/models" && method === "GET") {
    if (server.failModels === "GENERIC") {
      return fail(500, "INTERNAL_ERROR", "internal error");
    }
    if (server.failModels === "PROVIDER_NOT_READY") {
      return fail(500, "PROVIDER_NOT_READY", "provider not ready");
    }
    return reply(200, { data: { models: server.models, currentModelKey: "kB" } });
  }

  if (url === "/backend-api/conversations" && method === "POST") {
    if (server.failCreate) {
      return fail(500, "INTERNAL_ERROR", "create failed");
    }
    const id = `conv-${server.conversations.length + 1}`;
    const conv = conversation(id, body?.title ?? "默认话题");
    server.conversations.push(conv);
    return reply(201, { data: conv });
  }

  const listMatch = /^\/backend-api\/conversations\?(.*)$/.exec(url);
  if (listMatch && method === "GET") {
    const status = new URLSearchParams(listMatch[1]).get("status");
    return reply(200, {
      data: server.conversations.filter((c) => c.status === status),
      meta: { nextCursor: null },
    });
  }

  const itemMatch = /^\/backend-api\/conversations\/([^/?]+)$/.exec(url);
  if (itemMatch) {
    const id = itemMatch[1];
    const index = server.conversations.findIndex((c) => c.id === id);
    if (index < 0) return fail(404, "CONVERSATION_NOT_FOUND", "not found");
    const target = server.conversations[index];

    if (method === "GET") return reply(200, { data: target });
    if (method === "PATCH") {
      if (server.failPatch) {
        return fail(500, "PROVIDER_NOT_READY", "patch failed");
      }
      server.conversations[index] = {
        ...target,
        ...(body?.title !== undefined ? { title: body.title } : {}),
        ...(body?.status !== undefined ? { status: body.status } : {}),
        ...(body?.preferredModelKey !== undefined
          ? { preferredModelKey: body.preferredModelKey ?? null }
          : {}),
      };
      return reply(200, { data: server.conversations[index] });
    }
  }

  const messagesMatch =
    /^\/backend-api\/conversations\/([^/?]+)\/messages$/.exec(url);
  if (messagesMatch && method === "POST") {
    const id = messagesMatch[1];
    // FIX-05:模拟后端 M1 契约:POST messages 带 modelKey 时同事务写入 Conversation.preferredModelKey
    if (body?.modelKey !== undefined) {
      const convIndex = server.conversations.findIndex((c) => c.id === id);
      if (convIndex >= 0) {
        server.conversations[convIndex] = {
          ...server.conversations[convIndex],
          preferredModelKey: body.modelKey ?? null,
        };
      }
    }
    const userMessage = message(`msg-user-${calls.length}`, id, "USER", body?.content ?? "");
    const assistantMessage = message(
      `msg-assistant-${calls.length}`,
      id,
      "ASSISTANT",
      "",
    );
    server.messages.set(id, [userMessage, assistantMessage]);
    return reply(202, {
      data: {
        request: {
          id: `req-${calls.length}`,
          conversationId: id,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
          status: "PENDING",
          errorCode: null,
          errorMessage: null,
          createdAt: STAMP,
          updatedAt: STAMP,
        },
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
    modelCatalog: [],
    modelCatalogStatus: "idle",
  });
}

function seedSession(overrides: Partial<ChatSession> & { id: string }): ChatSession {
  const { id, ...rest } = overrides;
  const session: ChatSession = {
    topic: id,
    messages: [],
    stat: { tokenCount: 0, wordCount: 0, charCount: 0 },
    lastUpdate: Date.now(),
    mask: createEmptyMask(),
    draft: false,
    loaded: true,
    conversationStatus: "ACTIVE",
    preferredModelKey: null,
    messageNextCursor: null,
    loadingOlderMessages: false,
    messageHistoryError: false,
    messageTotalCount: 0,
    ...rest,
    id,
  };
  const state = useChatStore.getState();
  useChatStore.setState({
    sessions: [...state.sessions, session],
    currentSessionIndex: state.sessions.length,
  });
  return session;
}

function modelCalls(): RecordedCall[] {
  return calls.filter((c) => c.url === "/backend-api/provider/models");
}

function patchCalls(): RecordedCall[] {
  return calls.filter((c) => c.method === "PATCH");
}

function localStorageDump(): string {
  const parts: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key) parts.push(key, String(localStorage.getItem(key)));
  }
  return parts.join("\n");
}

beforeEach(async () => {
  resetServer();
  resetStore();
  localStorage.clear();
  await indexedDBStorage.removeItem(StoreKey.Chat);
  // onUserInput 成功后会 followRequest 订阅 SSE;jsdom 没有 EventSource,给个空桩
  (globalThis as any).EventSource = class {
    close() {}
    addEventListener() {}
  };
  (globalThis as any).fetch = jest.fn(
    async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      const method = String(init.method ?? "GET").toUpperCase();
      const parsed =
        typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body: parsed });
      return route(url, method, parsed);
    },
  );
});

describe("M4:模型目录加载(§六/§十六/§十七)", () => {
  test("M4-01 loadModels 首次拉取 GET /provider/models,目录与状态进 store", async () => {
    await useChatStore.getState().loadModels();

    expect(modelCalls()).toHaveLength(1);
    const state = useChatStore.getState();
    expect(state.modelCatalogStatus).toBe("ready");
    expect(state.modelCatalog.map((m) => m.key)).toEqual(["kA", "kB", "kOff"]);
    expect(state.modelCatalog.find((m) => m.key === "kOff")?.disabled).toBe(
      true,
    );
  });

  test("M4-02 ready 后重复调用不再请求;force=true 才重新拉取", async () => {
    await useChatStore.getState().loadModels();
    await useChatStore.getState().loadModels();
    await useChatStore.getState().loadModels();
    expect(modelCalls()).toHaveLength(1);

    await useChatStore.getState().loadModels(true);
    expect(modelCalls()).toHaveLength(2);
  });

  test("M4-03 加载失败 → error 状态;重试成功恢复 ready", async () => {
    server.failModels = "GENERIC";
    await useChatStore.getState().loadModels();
    expect(useChatStore.getState().modelCatalogStatus).toBe("error");
    expect(useChatStore.getState().modelCatalog).toEqual([]);

    server.failModels = false;
    await useChatStore.getState().loadModels(true);
    expect(useChatStore.getState().modelCatalogStatus).toBe("ready");
    expect(useChatStore.getState().modelCatalog).toHaveLength(3);
  });
});

describe("M4:会话偏好保存(§九/§十/§十三/§十五)", () => {
  test("M4-04 选择模型 → PATCH body 恰为 {preferredModelKey:key},成功后以后端为准", async () => {
    server.conversations = [conversation("c-1", "会话一", null)];
    seedSession({ id: "c-1" });

    await useChatStore.getState().setSessionModel("c-1", "kA");

    const patch = patchCalls();
    expect(patch).toHaveLength(1);
    expect(patch[0].url).toBe("/backend-api/conversations/c-1");
    expect(patch[0].body).toEqual({ preferredModelKey: "kA" });
    expect(useChatStore.getState().sessions[0].preferredModelKey).toBe("kA");
    expect(server.conversations[0].preferredModelKey).toBe("kA");
  });

  test("M4-05 默认模型 → PATCH 显式 null,绝不伪造'默认'键", async () => {
    server.conversations = [conversation("c-1", "会话一", "kA")];
    seedSession({ id: "c-1", preferredModelKey: "kA" });

    await useChatStore.getState().setSessionModel("c-1", null);

    const patch = patchCalls();
    expect(patch).toHaveLength(1);
    expect(patch[0].body).toEqual({ preferredModelKey: null });
    expect(useChatStore.getState().sessions[0].preferredModelKey).toBeNull();
    expect(server.conversations[0].preferredModelKey).toBeNull();
  });

  test("M4-06 PATCH 失败 → 回滚到原偏好(§十三)", async () => {
    server.conversations = [conversation("c-1", "会话一", "kA")];
    seedSession({ id: "c-1", preferredModelKey: "kA" });
    server.failPatch = true;

    await useChatStore.getState().setSessionModel("c-1", "kB");

    expect(useChatStore.getState().sessions[0].preferredModelKey).toBe("kA");
    expect(server.conversations[0].preferredModelKey).toBe("kA");
  });

  test("M4-07 busy 会话拒绝保存,0 次请求(§十五)", async () => {
    server.conversations = [conversation("c-1", "会话一", "kA")];
    seedSession({ id: "c-1", preferredModelKey: "kA", pendingRequestId: "req-1" });

    await useChatStore.getState().setSessionModel("c-1", "kB");

    expect(patchCalls()).toHaveLength(0);
    expect(useChatStore.getState().sessions[0].preferredModelKey).toBe("kA");
  });
});

describe("M4-FIX-01:草稿会话模型选择", () => {
  test("M4-13 草稿打开选择器可看到目录(按钮不再 disabled)", () => {
    seedSession({ id: "draft-x", draft: true });
    useChatStore.setState({ modelCatalog: MODELS, modelCatalogStatus: "ready" });

    render(<ModelSelectorButton />);

    const button = screen.getByText(Locale.Chat.ModelSelector.Default).closest("button");
    expect(button).not.toBeDisabled();
    fireEvent.click(button!);
    expect(screen.getByText("模型甲")).toBeInTheDocument();
    expect(screen.getByText("模型乙")).toBeInTheDocument();
  });

  test("M4-14 草稿选 A → 仅本地更新,0 后端请求(FIX-05)", async () => {
    seedSession({ id: "draft-x", draft: true });

    await useChatStore.getState().setSessionModel("draft-x", "kA");

    const createCalls = calls.filter((c) => c.method === "POST" && c.url === "/backend-api/conversations");
    expect(createCalls).toHaveLength(0);
    expect(patchCalls()).toHaveLength(0);
    const sessions = useChatStore.getState().sessions;
    const session = sessions.find((s) => s.id === "draft-x");
    expect(session?.draft).toBe(true);
    expect(session?.preferredModelKey).toBe("kA");
  });

  test("M4-15 草稿选 A → 首发 → body 带 modelKey(FIX-05)", async () => {
    seedSession({ id: "draft-x", draft: true });

    await useChatStore.getState().setSessionModel("draft-x", "kA");
    // 确认仍为 draft
    expect(useChatStore.getState().sessions.find((s) => s.id === "draft-x")?.draft).toBe(true);

    await useChatStore.getState().onUserInput("你好");
    await tick();

    // createConversation 应被调用(ensureConversation)
    const createCalls = calls.filter((c) => c.method === "POST" && c.url === "/backend-api/conversations");
    expect(createCalls).toHaveLength(1);
    // sendMessage 应带 modelKey
    const send = calls.find(
      (c) => c.method === "POST" && c.url.includes("/messages"),
    );
    expect(send).toBeDefined();
    expect(send?.body).toEqual({ content: "你好", modelKey: "kA" });
    // 禁止 PATCH
    expect(patchCalls()).toHaveLength(0);
  });

  test("M4-16 draft 选 A 后首发 ensureConversation 失败 → 不 sendMessage(FIX-05)", async () => {
    seedSession({ id: "draft-x", draft: true });
    await useChatStore.getState().setSessionModel("draft-x", "kA");
    // 偏好已设
    expect(useChatStore.getState().sessions.find((s) => s.id === "draft-x")?.preferredModelKey).toBe("kA");

    server.failCreate = true;
    await useChatStore.getState().onUserInput("你好");
    await tick();

    // 不应有 sendMessage 调用
    const sendCalls = calls.filter((c) => c.method === "POST" && c.url.includes("/messages"));
    expect(sendCalls).toHaveLength(0);
    // PATCH 也不应有
    expect(patchCalls()).toHaveLength(0);
  });
});

describe("M4-FIX-02:模型偏好保存防连点", () => {
  test("M4-17 第一次 PATCH 未完成时第二次被拒;完成后 saving=false", async () => {
    server.conversations = [conversation("c-1", "会话一")];
    seedSession({ id: "c-1" });

    // 用延迟的 fetch 模拟慢 PATCH
    let resolvePatch: (() => void) | undefined;
    const origFetch = globalThis.fetch as jest.Mock;
    (globalThis as any).fetch = jest.fn(async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      const method = String(init.method ?? "GET").toUpperCase();
      const parsed = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body: parsed });
      if (method === "PATCH" && url.includes("/conversations/c-1")) {
        return new Promise<any>((resolve) => {
          resolvePatch = () => resolve(route(url, method, parsed));
        });
      }
      return route(url, method, parsed);
    });

    const first = useChatStore.getState().setSessionModel("c-1", "kA");
    await tick();
    expect(useChatStore.getState().isModelSaving("c-1")).toBe(true);

    // 第二次应被拒
    await useChatStore.getState().setSessionModel("c-1", "kB");
    expect(patchCalls()).toHaveLength(1);

    // 完成第一次
    resolvePatch!();
    await first;
    expect(useChatStore.getState().isModelSaving("c-1")).toBe(false);
    expect(useChatStore.getState().sessions[0].preferredModelKey).toBe("kA");

    (globalThis as any).fetch = origFetch;
  });

  test("M4-18 conv A saving 不影响 conv B", async () => {
    server.conversations = [
      conversation("c-1", "会话一"),
      conversation("c-2", "会话二"),
    ];
    seedSession({ id: "c-1" });
    seedSession({ id: "c-2" });

    let resolvePatch: (() => void) | undefined;
    const origFetch = globalThis.fetch as jest.Mock;
    (globalThis as any).fetch = jest.fn(async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      const method = String(init.method ?? "GET").toUpperCase();
      const parsed = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body: parsed });
      if (method === "PATCH" && url.includes("/conversations/c-1")) {
        return new Promise<any>((resolve) => {
          resolvePatch = () => resolve(route(url, method, parsed));
        });
      }
      return route(url, method, parsed);
    });

    const first = useChatStore.getState().setSessionModel("c-1", "kA");
    await tick();

    // c-2 不受影响
    await useChatStore.getState().setSessionModel("c-2", "kB");
    const c2Patches = patchCalls().filter((c) => c.url.includes("/c-2"));
    expect(c2Patches).toHaveLength(1);
    expect(c2Patches[0].body).toEqual({ preferredModelKey: "kB" });

    resolvePatch!();
    await first;

    (globalThis as any).fetch = origFetch;
  });
});

describe("M4-FIX-05:Draft 模型选择语义(§五)", () => {
  test("M4-21 draft 选 model-a → 0 后端请求,session.draft=true,preferredModelKey=model-a", async () => {
    seedSession({ id: "draft-x", draft: true });

    await useChatStore.getState().setSessionModel("draft-x", "kA");

    expect(calls).toHaveLength(0);
    const session = useChatStore.getState().sessions.find((s) => s.id === "draft-x");
    expect(session?.draft).toBe(true);
    expect(session?.preferredModelKey).toBe("kA");
  });

  test("M4-22 draft model-a 不发送 → Backend Conversation 数量不变", async () => {
    seedSession({ id: "draft-x", draft: true });
    const beforeCount = server.conversations.length;

    await useChatStore.getState().setSessionModel("draft-x", "kA");
    await tick();

    expect(server.conversations.length).toBe(beforeCount);
    const createCalls = calls.filter((c) => c.method === "POST" && c.url === "/backend-api/conversations");
    expect(createCalls).toHaveLength(0);
    expect(patchCalls()).toHaveLength(0);
  });

  test("M4-23 draft model-a → 首发 → create(title=消息) + POST {content,modelKey:model-a},禁止 PATCH", async () => {
    seedSession({ id: "draft-x", draft: true });
    await useChatStore.getState().setSessionModel("draft-x", "kA");

    await useChatStore.getState().onUserInput("测试消息");
    await tick();

    const createCalls = calls.filter((c) => c.method === "POST" && c.url === "/backend-api/conversations");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].body?.title).toBe("测试消息");

    const send = calls.find((c) => c.method === "POST" && c.url.includes("/messages"));
    expect(send).toBeDefined();
    expect(send?.body).toEqual({ content: "测试消息", modelKey: "kA" });

    expect(patchCalls()).toHaveLength(0);
  });

  test("M4-24 draft 首发后本地 preferredModelKey 保持为选中键", async () => {
    seedSession({ id: "draft-x", draft: true });
    await useChatStore.getState().setSessionModel("draft-x", "kA");

    await useChatStore.getState().onUserInput("你好");
    await tick();

    const sessions = useChatStore.getState().sessions;
    const updated = sessions.find((s) => !s.draft);
    expect(updated?.preferredModelKey).toBe("kA");
  });

  test("M4-25 draft null/default → 首发 → body 只有 {content},不含 modelKey", async () => {
    seedSession({ id: "draft-x", draft: true });

    await useChatStore.getState().onUserInput("你好");
    await tick();

    const send = calls.find((c) => c.method === "POST" && c.url.includes("/messages"));
    expect(send).toBeDefined();
    expect(send?.body).toEqual({ content: "你好" });
    expect("modelKey" in (send?.body ?? {})).toBe(false);
  });

  test("M4-26 已持久化会话 preference=model-a → 普通发送 → body 只有 {content}", async () => {
    server.conversations = [conversation("c-1", "会话一", "kA")];
    await useChatStore.getState().bootstrap();
    await tick();

    await useChatStore.getState().onUserInput("你好");
    await tick();

    const send = calls.find(
      (c) => c.method === "POST" && c.url === "/backend-api/conversations/c-1/messages",
    );
    expect(send).toBeDefined();
    expect(send?.body).toEqual({ content: "你好" });
    expect("modelKey" in (send?.body ?? {})).toBe(false);
  });
});

describe("M4:偏好持久化与会话切换(§二十/§二十一)", () => {
  test("M4-08 会话切换偏好不串:改动 c-1 不影响 c-2", async () => {
    server.conversations = [
      conversation("c-1", "会话一", "kA"),
      conversation("c-2", "会话二", "kB"),
    ];
    await useChatStore.getState().bootstrap();
    await tick();

    await useChatStore.getState().setSessionModel("c-1", "kC");

    const sessions = useChatStore.getState().sessions;
    expect(sessions.find((s) => s.id === "c-1")?.preferredModelKey).toBe("kC");
    expect(sessions.find((s) => s.id === "c-2")?.preferredModelKey).toBe("kB");
  });

  test("M4-09 后端是唯一持久化来源:列表刷新以后端为准,localStorage 无偏好", async () => {
    server.conversations = [conversation("c-1", "会话一", "kServer")];
    await useChatStore.getState().bootstrap();
    await tick();
    expect(useChatStore.getState().sessions[0].preferredModelKey).toBe(
      "kServer",
    );

    server.conversations[0] = conversation("c-1", "会话一", null);
    await useChatStore.getState().reloadList();
    expect(useChatStore.getState().sessions[0].preferredModelKey).toBeNull();

    expect(localStorageDump()).not.toContain("kServer");
  });

  test("M4-10 已持久化会话发送 body 只有 content,不带 modelKey(§五)", async () => {
    server.conversations = [conversation("c-1", "会话一", "kA")];
    await useChatStore.getState().bootstrap();
    await tick();

    await useChatStore.getState().onUserInput("你好");
    await tick();

    const send = calls.find(
      (c) => c.method === "POST" && c.url === "/backend-api/conversations/c-1/messages",
    );
    expect(send).toBeDefined();
    expect(send?.body).toEqual({ content: "你好" });
    expect("modelKey" in (send?.body ?? {})).toBe(false);
  });
});

describe("M4:选择器 UI(§十一/§十二/§十七)", () => {
  test("M4-11 陈旧偏好键:按钮显示「当前模型不可用」,打开选择器不自动 PATCH", async () => {
    seedSession({ id: "c-1", preferredModelKey: "gone" });
    useChatStore.setState({ modelCatalog: MODELS, modelCatalogStatus: "ready" });

    render(<ModelSelectorButton />);

    expect(
      screen.getByText(Locale.Chat.ModelSelector.Unavailable),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText(Locale.Chat.ModelSelector.Unavailable));
    await tick();

    expect(patchCalls()).toHaveLength(0);
  });

  test("M4-12 disabled 模型项可见但不可选;busy 时整个按钮禁用(§十一/§十五)", async () => {
    server.conversations = [conversation("c-1", "会话一")];
    seedSession({ id: "c-1" });
    useChatStore.setState({ modelCatalog: MODELS, modelCatalogStatus: "ready" });

    render(<ModelSelectorButton />);
    fireEvent.click(screen.getByText(Locale.Chat.ModelSelector.Default));

    // disabled 项可见,点击不触发 PATCH
    const disabledItem = screen.getByText("模型丙(停用)");
    expect(disabledItem).toBeInTheDocument();
    fireEvent.click(disabledItem);
    await tick();
    expect(patchCalls()).toHaveLength(0);

    // 可选项点击 → PATCH 正确的键
    fireEvent.click(screen.getByText("模型甲"));
    await tick();
    expect(patchCalls()).toHaveLength(1);
    expect(patchCalls()[0].body).toEqual({ preferredModelKey: "kA" });

    // busy 后按钮禁用(此时标签已是刚选的「模型甲」)
    act(() => {
      useChatStore.setState({
        sessions: useChatStore.getState().sessions.map((s) =>
          s.id === "c-1" ? { ...s, pendingRequestId: "req-1" } : s,
        ),
      });
    });
    const button = screen.getByText("模型甲").closest("button");
    expect(button).toBeDisabled();
  });
});

describe("M4-FIX-07:生成中刷新不打 error", () => {
  test("M4-27 preferred=model-a, pendingRequestId 存在, catalog=idle, mount → GET /models = 0", async () => {
    seedSession({ id: "c-1", preferredModelKey: "kA", pendingRequestId: "req-1" });

    render(<ModelSelectorButton />);
    await tick();

    expect(modelCalls()).toHaveLength(0);
    expect(useChatStore.getState().modelCatalogStatus).toBe("idle");
  });

  test("M4-28 随后 pendingRequestId 清除 → GET /models = 1, label 正确解析", async () => {
    seedSession({ id: "c-1", preferredModelKey: "kA", pendingRequestId: "req-1" });
    useChatStore.setState({ modelCatalogStatus: "idle" });

    render(<ModelSelectorButton />);
    await tick();
    expect(modelCalls()).toHaveLength(0);

    // 清除 pendingRequestId → 触发补拉
    act(() => {
      useChatStore.setState({
        sessions: useChatStore.getState().sessions.map((s) =>
          s.id === "c-1" ? { ...s, pendingRequestId: undefined } : s,
        ),
      });
    });
    await tick();

    expect(modelCalls()).toHaveLength(1);
    expect(useChatStore.getState().modelCatalogStatus).toBe("ready");
  });

  test("M4-29 PROVIDER_NOT_READY → idle(允许重试),其他错误 → error", async () => {
    // PROVIDER_NOT_READY → idle
    server.failModels = "PROVIDER_NOT_READY";
    await useChatStore.getState().loadModels();
    expect(useChatStore.getState().modelCatalogStatus).toBe("idle");

    // 其他错误 → error(模拟非 PROVIDER_NOT_READY 的失败)
    const origFetch = globalThis.fetch as jest.Mock;
    (globalThis as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: { code: "INTERNAL_ERROR", message: "boom", requestId: "r" } }),
    }));
    await useChatStore.getState().loadModels(true);
    expect(useChatStore.getState().modelCatalogStatus).toBe("error");

    (globalThis as any).fetch = origFetch;
  });
});
