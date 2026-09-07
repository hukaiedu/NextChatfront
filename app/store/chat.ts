import { safeLocalStorage, trimTopic } from "../utils";
import { indexedDBStorage } from "@/app/utils/indexedDB-storage";
import { nanoid } from "nanoid";
import { create } from "zustand";
import { showToast } from "../components/ui-lib";
import { StoreKey } from "../constant";
import Locale from "../locales";
import type { MessageRole, RequestMessage } from "../client/api";
import { ModelType } from "./config";
import { createEmptyMask, Mask } from "./mask";
import {
  BackendApiError,
  BackendMessage,
  BackendModelOption,
  ConversationStatus,
  RequestStatusFrame,
  cancelRequest as cancelBackendRequest,
  createConversation,
  deleteConversation,
  isRequestFinished,
  listConversations,
  listMessages,
  listProviderModels,
  newIdempotencyKey,
  patchConversation,
  sendMessage,
  subscribeRequestEvents,
} from "../client/backend-api";
import {
  closeAllStreams,
  closeStream,
  forgetStream,
  trackStream,
} from "./active-streams";

const localStorage = safeLocalStorage();

/** 后端只有 Gemini Web 一条通道,UI 不再选择模型 / Provider */
export const BACKEND_MODEL_LABEL = "Gemini Web" as ModelType;

export type ChatMessageTool = {
  id: string;
  index?: number;
  type?: string;
  function?: {
    name: string;
    arguments?: string;
  };
  content?: string;
  isError?: boolean;
  errorMsg?: string;
};

export type ChatMessage = RequestMessage & {
  date: string;
  streaming?: boolean;
  isError?: boolean;
  /** 后端 Request 的错误码,失败气泡按它给提示 */
  errorCode?: string;
  id: string;
  model?: ModelType;
  tools?: ChatMessageTool[];
  audio_url?: string;
  isMcpResponse?: boolean;
};

export function createMessage(override: Partial<ChatMessage>): ChatMessage {
  return {
    id: nanoid(),
    date: new Date().toLocaleString(),
    role: "user",
    content: "",
    ...override,
  };
}

export interface ChatStat {
  tokenCount: number;
  wordCount: number;
  charCount: number;
}

export interface ChatSession {
  /** 已落库的会话 = 后端 Conversation.id;本地草稿 = draft-<nanoid> */
  id: string;
  topic: string;

  messages: ChatMessage[];
  stat: ChatStat;
  lastUpdate: number;
  clearContextIndex?: number;

  mask: Mask;

  /** 尚未提交到后端的临时会话(第一次发送时才建 Conversation) */
  draft?: boolean;
  /** 消息是否已从后端加载过(未加载的会话点开时才拉) */
  loaded?: boolean;
  loadingMessages?: boolean;
  conversationStatus?: ConversationStatus;
  /** 该会话当前仍在执行中的 Request id */
  pendingRequestId?: string;
  /** 正在等待后端确认停止(CANCELLING 期间按钮 disabled) */
  cancelling?: boolean;
  /** M4:会话模型偏好(null = 默认模型);后端 Conversation 是唯一持久化来源 */
  preferredModelKey?: string | null;
}

let _defaultTopic: string | undefined;
let _botHello: ChatMessage | undefined;

/**
 * locales↔chat 循环若以 locales 为入口(如 prerender 包实测),模块求值期读
 * Locale 会 TDZ;改为调用期求值,任何模块求值顺序下都安全。
 */
export function getDefaultTopic(): string {
  return (_defaultTopic ??= Locale.Store.DefaultTopic);
}

export function getBotHello(): ChatMessage {
  return (_botHello ??= createMessage({
    role: "assistant",
    content: Locale.Store.BotHello,
  }));
}

/** 后端错误码 → 中文提示;未列出的直接展示后端 message */
const ERROR_TEXT: Record<string, string> = {
  CONVERSATION_NOT_FOUND: "会话不存在",
  CONVERSATION_DELETED: "会话已删除",
  CONVERSATION_ARCHIVED: "会话已归档,请先恢复后再发送",
  CONVERSATION_REQUEST_IN_PROGRESS: "这个会话还有回答在进行中,请先等它完成",
  PROVIDER_LOGIN_REQUIRED: "Gemini 未登录,请在服务端浏览器里重新登录",
  PROVIDER_BUSY: "浏览器正忙,稍后再试",
  PROVIDER_NAVIGATION_FAILED: "连不上 Gemini,请稍后重试",
  PROVIDER_RESPONSE_TIMEOUT: "Gemini 回答超时",
  PROVIDER_CANCELLATION_UNCONFIRMED:
    "无法确认 Gemini 已停止生成,浏览器正在重建",
  PROVIDER_BROWSER_CRASHED: "浏览器崩溃,正在自动恢复",
  PROVIDER_PAGE_CLOSED: "Gemini 页面被关闭,请重试",
  PROVIDER_CONVERSATION_UNAVAILABLE: "Gemini 会话已失效,请新建会话",
  SERVER_RESTARTED_DURING_PROCESSING: "服务重启导致回答中断,请重新发送",
  SERVER_RESTARTED_DURING_CANCELLING: "服务重启时正在停止生成,请重新发送",
  BROWSER_NOT_RUNNING: "服务端浏览器未运行,请在浏览器状态面板中重启",
  BROWSER_LAUNCH_FAILED: "服务端浏览器启动失败,请查看后端日志",
  BROWSER_RESTART_CONFLICT: "有回答正在生成,请先停止生成再重启浏览器",
  BROWSER_RESTART_FAILED: "服务端浏览器重启失败,请查看后端日志",
  BROWSER_RESTART_TIMEOUT: "服务端浏览器重启超时,请稍后刷新状态",
  NETWORK_ERROR: "连不上后端服务",
};

export function errorTextForCode(code?: string | null): string {
  if (!code) return "回答失败";
  return ERROR_TEXT[code] ?? code;
}

export function backendErrorMessage(error: unknown): string {
  if (error instanceof BackendApiError) {
    return ERROR_TEXT[error.code] ?? `${error.code}: ${error.message}`;
  }
  if (error instanceof Error && ERROR_TEXT[error.name]) {
    return ERROR_TEXT[error.name];
  }
  return error instanceof Error ? error.message : String(error);
}

function notifyError(error: unknown) {
  console.error("[Chat] 请求失败", error);
  showToast(backendErrorMessage(error));
}

function createBackendMask(): Mask {
  const mask = createEmptyMask();
  return {
    ...mask,
    name: BACKEND_MODEL_LABEL,
    modelConfig: { ...mask.modelConfig, model: BACKEND_MODEL_LABEL },
  };
}

function emptyStat(): ChatStat {
  return { tokenCount: 0, wordCount: 0, charCount: 0 };
}

export function createDraftSession(): ChatSession {
  return {
    id: `draft-${nanoid()}`,
    topic: getDefaultTopic(),
    messages: [],
    stat: emptyStat(),
    lastUpdate: Date.now(),
    mask: createBackendMask(),
    draft: true,
    loaded: true,
    conversationStatus: "ACTIVE",
  };
}

/**
 * 首屏拉列表期间 currentSession() 返回这个占位会话。
 * 它不在 sessions 数组里,所以 updateTargetSession 会按 id 找不到而空转,
 * 不会把数据写进一个不存在的会话。
 */
let _placeholderSession: ChatSession | undefined;
/** 惰性占位会话:与 getDefaultTopic 同理,避免模块求值期经 createDraftSession 触达 Locale */
function getPlaceholderSession(): ChatSession {
  return (_placeholderSession ??= createDraftSession());
}

/** M4-FIX-02:每个会话最多一个在途的模型偏好 PATCH,防止快速连点导致乱序写入 */
const modelSavingSessionIds = new Set<string>();

/** 后端 role 是大写枚举,NextChat 用小写 */
function toChatRole(role: BackendMessage["role"]): MessageRole {
  return role === "USER" ? "user" : "assistant";
}

/**
 * 状态映射(第 7 阶段 §六):
 * PENDING / STREAMING → streaming(加载 / 逐字),COMPLETED → 完成,FAILED → 错误。
 * 不引入第二套状态,复用 NextChat 的 streaming + isError 两个标记。
 */
function toChatMessage(message: BackendMessage): ChatMessage {
  const failed = message.status === "FAILED";
  const request = message.request ?? null;
  return {
    id: message.id,
    role: toChatRole(message.role),
    content: message.content,
    date: new Date(message.createdAt).toLocaleString(),
    streaming:
      message.role === "ASSISTANT" && !isMessageSettled(message.status),
    isError: message.role === "ASSISTANT" && failed,
    errorCode: failed ? request?.errorCode ?? undefined : undefined,
    model: BACKEND_MODEL_LABEL,
  };
}

function isMessageSettled(status: BackendMessage["status"]): boolean {
  return (
    status === "COMPLETED" || status === "FAILED" || status === "CANCELLED"
  );
}

function applyStatusToMessage(
  message: ChatMessage,
  frame: RequestStatusFrame,
  session?: ChatSession,
): void {
  if (frame.requestStatus === "CANCELLING") {
    message.streaming = true;
    if (session) session.cancelling = true;
    return;
  }
  if (frame.status) {
    message.streaming = !isMessageSettled(frame.status);
    message.isError = frame.status === "FAILED";
  }
  if (frame.requestStatus === "CANCELLED") {
    message.streaming = false;
    message.isError = false;
    if (session) session.cancelling = false;
  }
  if (isRequestFinished(frame.requestStatus)) {
    message.streaming = false;
    if (session) session.cancelling = false;
  }
  if (
    frame.requestStatus === "FAILED" ||
    frame.requestStatus === "TIMEOUT" ||
    frame.status === "FAILED"
  ) {
    message.isError = true;
    message.errorCode = frame.errorCode ?? message.errorCode;
  }
}

function toChatSession(conversation: {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  preferredModelKey?: string | null;
}): ChatSession {
  return {
    id: conversation.id,
    topic: conversation.title,
    messages: [],
    stat: emptyStat(),
    lastUpdate: new Date(conversation.updatedAt).getTime(),
    mask: createBackendMask(),
    draft: false,
    loaded: false,
    conversationStatus:
      conversation.status === "ARCHIVED" ? "ARCHIVED" : "ACTIVE",
    preferredModelKey: conversation.preferredModelKey ?? null,
  };
}

interface ChatState {
  sessions: ChatSession[];
  currentSessionIndex: number;
  lastInput: string;
  /** 会话列表是否已完成首次加载 */
  ready: boolean;
  loadingList: boolean;
  /** 当前列表展示 ACTIVE 还是 ARCHIVED */
  listStatus: ConversationStatus;
  /** PAG-1:下一页游标;null = 无更多(与后端 nextCursor 语义一致) */
  listNextCursor: string | null;
  /** PAG-1:加载更多 inflight */
  loadingMoreList: boolean;
  /** PAG-1:第一页/权威列表刷新失败(重试入口 = reloadList) */
  listReloadError: boolean;
  /** PAG-1:加载更多失败(重试入口 = loadMoreConversations) */
  listMoreError: boolean;
  /** M4:Provider 模型目录(全局共享,与会话无关)与加载状态 */
  modelCatalog: BackendModelOption[];
  modelCatalogStatus: "idle" | "loading" | "ready" | "error";
}

interface ChatActions {
  bootstrap(): Promise<void>;
  reloadList(): Promise<void>;
  /** PAG-1:加载下一页(追加型) */
  loadMoreConversations(): Promise<void>;
  switchListStatus(status: ConversationStatus): Promise<void>;
  loadSessionMessages(sessionId: string): Promise<void>;
  refreshSessionMessages(sessionId: string): Promise<void>;
  selectSession(index: number): void;
  nextSession(delta: number): void;
  newSession(mask?: Mask): void;
  moveSession(from: number, to: number): void;
  deleteSession(index: number): Promise<void>;
  archiveSession(index: number): Promise<void>;
  restoreSession(index: number): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  currentSession(): ChatSession;
  updateTargetSession(
    targetSession: ChatSession,
    updater: (session: ChatSession) => void,
  ): void;
  setLastInput(lastInput: string): void;
  onUserInput(content: string, attachImages?: string[]): Promise<void>;
  followRequest(
    conversationId: string,
    requestId: string,
    messageId: string,
  ): void;
  cancelRequest(conversationId: string): Promise<void>;
  /** M4:拉模型目录;已 ready 且非 force 时不重复请求 */
  loadModels(force?: boolean): Promise<void>;
  /**
   * M4:设置会话模型偏好(key 为 null = 默认模型)。
   * 草稿选非 null → ensureConversation → PATCH;草稿选 null → no-op。
   * 乐观更新,失败回滚到原值;在途 Request / 同会话正在保存时拒绝(FIX-02)。
   */
  setSessionModel(sessionId: string, key: string | null): Promise<void>;
  /** M4-FIX-02:指定会话是否正在保存模型偏好 */
  isModelSaving(sessionId: string): boolean;
  clearAllData(): Promise<void>;
}

export type ChatStore = ChatState & ChatActions;

const DEFAULT_CHAT_STATE: ChatState = {
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
  modelCatalog: [],
  modelCatalogStatus: "idle",
};

export const useChatStore = create<ChatStore>()((set, get) => {
  // PAG-1 分页并发模型(闭包,非 zustand state,避免多余渲染订阅)
  /** authoritative invalidation epoch(列表真相版本,PAG-REVIEW-12):每次权威
   * 失效事件到达时立即递增 —— reloadList 入口第一条语句、先于 same-status
   * 判断,即使该调用将被折叠为 trailing 也不例外 */
  let listGeneration = 0;
  /** 第一页 inflight 登记:同 status 单飞、跨 status 让路(PAG-REVIEW-01) */
  let initialLoad: { status: ConversationStatus; generation: number } | null =
    null;
  /** trailing reload 登记(PAG-REVIEW-09):同 status reload 在途期间到达的
   * 后续权威刷新折叠为最多 1 次 trailing,由 ownsInitialSlot 的请求收尾消费 */
  let pendingReloadStatus: ConversationStatus | null = null;

  /** 按 id 改某条消息:订阅回调可能在会话切换 / 删除之后才到达 */
  function patchMessage(
    sessionId: string,
    messageId: string,
    updater: (message: ChatMessage) => void,
  ) {
    const state = get();
    const session = state.sessions.find((s) => s.id === sessionId);
    const message = session?.messages.find((m) => m.id === messageId);
    if (!session || !message) return;
    updater(message);
    // messages 必须换成新数组才会触发渲染
    set({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, messages: s.messages.slice() } : s,
      ),
    });
  }

  function setPendingRequest(conversationId: string, requestId?: string) {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === conversationId ? { ...s, pendingRequestId: requestId } : s,
      ),
    }));
  }

  /** 草稿会话在第一次发送时才真正建到后端 */
  async function ensureConversation(
    session: ChatSession,
    text: string,
  ): Promise<string> {
    if (!session.draft) return session.id;

    const created = await createConversation(
      trimTopic(text) || getDefaultTopic(),
    );
    set((state) => {
      const index = state.sessions.findIndex((s) => s.id === session.id);
      const replaced: ChatSession = {
        ...createDraftSession(),
        id: created.id,
        topic: created.title,
        draft: false,
        loaded: true,
        lastUpdate: new Date(created.updatedAt).getTime(),
        preferredModelKey: created.preferredModelKey ?? null,
      };
      if (index < 0) {
        return {
          sessions: [replaced, ...state.sessions],
          currentSessionIndex: 0,
        };
      }
      const sessions = state.sessions.slice();
      sessions[index] = replaced;
      return { sessions, currentSessionIndex: index };
    });
    return created.id;
  }

  const actions: ChatActions = {
    /** 首屏:会话列表来自后端,顺带清掉第 7 阶段之前残留的本地聊天数据 */
    async bootstrap() {
      if (get().ready || get().loadingList) return;
      try {
        // 旧版本把 Conversation / Message 存在 IndexedDB,必须抹掉,
        // 否则本地脏数据看起来像是盖住了后端真相
        await indexedDBStorage.removeItem(StoreKey.Chat);
        localStorage.removeItem(StoreKey.Chat);
      } catch (error) {
        console.warn("[Chat] 清理本地聊天数据失败", error);
      }
      await get().reloadList();
    },

    /** 重新拉列表(权威):入口即权威失效 —— 立即递增 epoch 并废弃旧分页进度 */
    async reloadList() {
      const status = get().listStatus;
      // PAG-REVIEW-12:入口第一件事 —— 权威失效 epoch 立即递增。
      // 必须在 same-status 判断之前:即使本次刷新将被折叠为 trailing,
      // 旧快照也从这一刻起失效。
      const requestedGeneration = ++listGeneration;
      // PAG-REVIEW-13:权威失效到达那一刻立即废弃旧分页进度(不等新请求成功)
      set({
        listNextCursor: null,
        loadingMoreList: false,
        listMoreError: false,
      });

      if (initialLoad?.status === status) {
        // 同 status 单飞:折叠为 trailing,不丢弃(PAG-REVIEW-09);
        // generation 已在上方递增 → 旧 initial 响应已立即 stale(PAG-REVIEW-12)
        pendingReloadStatus = status;
        return;
      }

      initialLoad = { status, generation: requestedGeneration };
      set({ loadingList: true, listReloadError: false });

      // 双守卫(PAG-REVIEW-12,独立判定、禁止合并回单一 isCurrent):
      // responseIsLatest —— 该响应能否写 UI(仍是最新权威 epoch 且 status 未切走)
      const responseIsLatest = () =>
        requestedGeneration === listGeneration && get().listStatus === status;
      // ownsInitialSlot —— 该请求完成时能否收尾 initial slot
      // (释放槽位 + 消费 pending + 触发 trailing)
      const ownsInitialSlot = () =>
        initialLoad?.status === status &&
        initialLoad.generation === requestedGeneration;

      const consumePending = () => {
        initialLoad = null;
        if (pendingReloadStatus === status) {
          pendingReloadStatus = null;
          void get().reloadList(); // trailing:入口会再次递增 epoch(正常)
        }
      };

      try {
        const { items, nextCursor } = await listConversations(status);
        if (!ownsInitialSlot()) return; // 跨 status stale:完全退出,不触碰任何状态
        if (responseIsLatest()) {
          set((state) => {
            const drafts = state.sessions.filter((s) => s.draft);
            const merged = items.map((conversation) => {
              const fresh = toChatSession(conversation);
              const current = state.sessions.find((s) => s.id === fresh.id);
              if (!current) return fresh;
              // 保留已加载的消息与在途状态,只更新顺序和后端标题
              return {
                ...fresh,
                messages: current.messages,
                loaded: current.loaded,
                loadingMessages: current.loadingMessages,
                pendingRequestId: current.pendingRequestId,
                conversationStatus: current.conversationStatus,
                topic: current.topic || fresh.topic,
              };
            });
            const sessions = [...drafts, ...merged];
            if (!sessions.length && status === "ACTIVE") {
              sessions.push(createDraftSession());
            }
            const activeId = state.sessions[state.currentSessionIndex]?.id;
            const index = sessions.findIndex((s) => s.id === activeId);
            return {
              sessions,
              currentSessionIndex: index >= 0 ? index : 0,
              ready: true,
              loadingList: false,
              listNextCursor: nextCursor,
            };
          });
        }
        // ownsInitialSlot=true 但 responseIsLatest=false(同 status 在途期间被更晚
        // 权威事件超越)→ 响应不写 UI,只收尾:释放 slot → 消费 pending → trailing
        consumePending();
        if (responseIsLatest()) {
          const active = get().sessions[get().currentSessionIndex];
          if (active) void get().loadSessionMessages(active.id);
        }
      } catch (error) {
        if (!ownsInitialSlot()) return; // 跨 status stale 失败同样完全退出
        if (responseIsLatest()) {
          // 已有 sessions 保留(graceful degradation);旧 cursor 已在入口废弃
          set({ loadingList: false, listReloadError: true });
          notifyError(error);
        }
        // 旧 epoch 的失败不写错误 UI:trailing 本身就是自然 retry
        consumePending(); // 失败也消费 pending(PAG-REVIEW-09)
      }
    },

    /** PAG-1:加载下一页(追加型)。stale 响应整体丢弃;失败保留 sessions 与 cursor */
    async loadMoreConversations() {
      const {
        listNextCursor,
        loadingMoreList,
        loadingList,
        listStatus,
        ready,
      } = get();
      if (!ready || loadingList || loadingMoreList || listNextCursor === null)
        return;
      const generation = listGeneration;
      const status = listStatus;
      const cursor = listNextCursor;
      set({ loadingMoreList: true, listMoreError: false });
      try {
        const { items, nextCursor } = await listConversations(status, cursor);
        // 权威失效事件到达(reloadList 入口递增 epoch)后,旧 loadMore 整体丢弃
        if (generation !== listGeneration || get().listStatus !== status)
          return;
        set((state) => {
          const fresh = items
            .filter((c) => !state.sessions.some((s) => s.id === c.id))
            .map(toChatSession);
          return {
            sessions: [...state.sessions, ...fresh],
            listNextCursor: nextCursor,
            loadingMoreList: false,
          };
        });
      } catch {
        if (generation !== listGeneration) return;
        set({ loadingMoreList: false, listMoreError: true });
      }
    },

    /** 会话列表在 ACTIVE / ARCHIVED 之间切换(§七) */
    async switchListStatus(status: ConversationStatus) {
      if (get().listStatus === status && get().ready) return;
      closeAllStreams();
      set({
        listStatus: status,
        sessions: [],
        currentSessionIndex: 0,
        ready: false,
        // PAG-REVIEW-07:分页状态与 listStatus 同步切换
        // (loadingList 不在此 set —— 由 reloadList 并发模型独占控制)
        listNextCursor: null,
        loadingMoreList: false,
        listReloadError: false,
        listMoreError: false,
      });
      await get().reloadList();
    },

    /** 打开会话:未加载过就拉消息,并续接仍在执行的 Request(§八) */
    async loadSessionMessages(sessionId: string) {
      const session = get().sessions.find((s) => s.id === sessionId);
      if (
        !session ||
        session.draft ||
        session.loaded ||
        session.loadingMessages
      )
        return;

      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, loadingMessages: true } : s,
        ),
      }));

      try {
        const messages = await listMessages(sessionId);
        const running = messages.find(
          (m) =>
            m.role === "ASSISTANT" &&
            m.request &&
            !isRequestFinished(m.request.status),
        );
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  messages: messages.map(toChatMessage),
                  loaded: true,
                  loadingMessages: false,
                  pendingRequestId: running?.request?.id,
                }
              : s,
          ),
        }));
        if (running?.request) {
          get().followRequest(sessionId, running.request.id, running.id);
        }
      } catch (error) {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, loadingMessages: false } : s,
          ),
        }));
        notifyError(error);
      }
    },

    /** 手动刷新:重新拉后端历史,顺带续接可能仍在执行的 Request */
    async refreshSessionMessages(sessionId: string) {
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId
            ? { ...s, loaded: false, loadingMessages: false }
            : s,
        ),
      }));
      await get().loadSessionMessages(sessionId);
    },

    selectSession(index: number) {
      set({ currentSessionIndex: index });
      const session = get().sessions[index];
      if (session) void get().loadSessionMessages(session.id);
    },

    nextSession(delta: number) {
      const n = get().sessions.length;
      if (!n) return;
      const limit = (x: number) => (x + n) % n;
      get().selectSession(limit(get().currentSessionIndex + delta));
    },

    newSession(mask?: Mask) {
      const session = createDraftSession();
      if (mask) {
        session.mask = {
          ...mask,
          modelConfig: { ...mask.modelConfig, model: BACKEND_MODEL_LABEL },
        };
        session.topic = mask.name;
      }
      // 正在看归档列表时,草稿必须落在「进行中」列表,否则会在下次 reloadList 时消失
      if (get().listStatus !== "ACTIVE") {
        set((state) => ({
          listStatus: "ACTIVE",
          ready: false,
          currentSessionIndex: 0,
          sessions: [session],
        }));
        void get().reloadList();
        return;
      }
      set((state) => ({
        currentSessionIndex: 0,
        sessions: [session, ...state.sessions],
      }));
    },

    /** 拖动排序只是本次浏览的顺序,后端没有排序字段 */
    moveSession(from: number, to: number) {
      set((state) => {
        const sessions = [...state.sessions];
        const session = sessions.splice(from, 1)[0];
        sessions.splice(to, 0, session);
        const old = state.currentSessionIndex;
        let index = old;
        if (old === from) index = to;
        else if (from < old && to >= old) index = old - 1;
        else if (from > old && to <= old) index = old + 1;
        return { sessions, currentSessionIndex: index };
      });
    },

    /** 后端软删除不可恢复,所以没有 5 秒撤销(§十) */
    async deleteSession(index: number) {
      const session = get().sessions.at(index);
      if (!session) return;

      if (!session.draft) {
        closeStream(session.id);
        try {
          await deleteConversation(session.id);
        } catch (error) {
          notifyError(error);
          return;
        }
      }

      set((state) => {
        const sessions = state.sessions.slice();
        sessions.splice(index, 1);
        if (!sessions.length && get().listStatus === "ACTIVE")
          sessions.push(createDraftSession());
        const next = Math.max(
          0,
          Math.min(state.currentSessionIndex, sessions.length - 1),
        );
        return { sessions, currentSessionIndex: next };
      });
      const current = get().sessions[get().currentSessionIndex];
      if (current) void get().loadSessionMessages(current.id);
      // PAG-REVIEW-10:删除 = authoritative invalidation,权威回第一页
      void get().reloadList();
    },

    async archiveSession(index: number) {
      const session = get().sessions.at(index);
      if (!session || session.draft) return;
      try {
        await patchConversation(session.id, { status: "ARCHIVED" });
      } catch (error) {
        notifyError(error);
        return;
      }
      closeStream(session.id);
      set((state) => {
        const sessions = state.sessions.filter((s) => s.id !== session.id);
        if (!sessions.length) sessions.push(createDraftSession());
        const next = Math.max(
          0,
          Math.min(state.currentSessionIndex, sessions.length - 1),
        );
        return { sessions, currentSessionIndex: next };
      });
      // PAG-REVIEW-10:归档 = authoritative invalidation,权威回第一页
      void get().reloadList();
    },

    /** 归档列表里点「恢复」:PATCH 回 ACTIVE 并从当前列表移除 */
    async restoreSession(index: number) {
      const session = get().sessions.at(index);
      if (!session || session.draft) return;
      try {
        await patchConversation(session.id, { status: "ACTIVE" });
      } catch (error) {
        notifyError(error);
        return;
      }
      set((state) => ({
        sessions: state.sessions.filter((s) => s.id !== session.id),
      }));
      // PAG-REVIEW-10:恢复 = authoritative invalidation,权威回第一页
      void get().reloadList();
    },

    async renameSession(sessionId: string, title: string) {
      const value = trimTopic(title);
      const session = get().sessions.find((s) => s.id === sessionId);
      if (!session || !value) return;
      get().updateTargetSession(session, (target) => {
        target.topic = value;
      });
      if (session.draft) return;
      try {
        await patchConversation(sessionId, { title: value });
      } catch (error) {
        notifyError(error);
      }
    },

    currentSession() {
      const { sessions, currentSessionIndex } = get();
      if (!sessions.length) return getPlaceholderSession();
      if (currentSessionIndex < 0 || currentSessionIndex >= sessions.length) {
        const index = Math.min(
          sessions.length - 1,
          Math.max(0, currentSessionIndex),
        );
        set({ currentSessionIndex: index });
        return sessions[index];
      }
      return sessions[currentSessionIndex];
    },

    updateTargetSession(
      targetSession: ChatSession,
      updater: (session: ChatSession) => void,
    ) {
      set((state) => {
        const index = state.sessions.findIndex(
          (s) => s.id === targetSession.id,
        );
        if (index < 0) return {};
        const sessions = state.sessions.slice();
        const session = { ...sessions[index] };
        updater(session);
        sessions[index] = session;
        return { sessions };
      });
    },

    setLastInput(lastInput: string) {
      set({ lastInput });
    },

    /**
     * 发送流程(§五):输入 → Conversation(草稿才建)→ POST messages
     * → requestId + assistantMessageId → SSE delta → 完成。
     * 上下文由后端 Gemini 会话负责,前端不再拼历史消息。
     */
    async onUserInput(content: string, attachImages?: string[]) {
      const text = content.trim();
      if (!text) return;
      if (attachImages?.length) {
        showToast(ERROR_TEXT.PROVIDER_BUSY);
        return;
      }

      let session = get().currentSession();
      if (session === getPlaceholderSession()) {
        get().newSession();
        session = get().currentSession();
      }
      if (session.conversationStatus === "ARCHIVED") {
        showToast(ERROR_TEXT.CONVERSATION_ARCHIVED);
        return;
      }

      // FIX-05:ensureConversation 会替换 draft,提前捕获偏好
      const wasDraft = session.draft;
      const draftModelKey = wasDraft
        ? session.preferredModelKey ?? undefined
        : undefined;

      const conversationId = await ensureConversation(session, text).catch(
        (error) => {
          notifyError(error);
          return null;
        },
      );
      if (!conversationId) return;

      const pending = get().sessions.find((s) => s.id === conversationId);
      if (pending?.pendingRequestId) {
        showToast(ERROR_TEXT.CONVERSATION_REQUEST_IN_PROGRESS);
        return;
      }

      try {
        const result = await sendMessage(
          conversationId,
          text,
          newIdempotencyKey(),
          draftModelKey,
        );
        const userMessage = toChatMessage(result.userMessage);
        const assistantMessage = toChatMessage(result.assistantMessage);
        assistantMessage.streaming = true;

        get().updateTargetSession(
          { id: conversationId } as ChatSession,
          (target) => {
            target.draft = false;
            target.loaded = true;
            target.messages = target.messages.concat([
              userMessage,
              assistantMessage,
            ]);
            target.lastUpdate = Date.now();
            target.pendingRequestId = result.request.id;
            if (draftModelKey !== undefined) {
              target.preferredModelKey = draftModelKey;
            }
          },
        );

        get().followRequest(
          conversationId,
          result.request.id,
          assistantMessage.id,
        );
        void get().reloadList();
      } catch (error) {
        notifyError(error);
        get().updateTargetSession(
          { id: conversationId } as ChatSession,
          (target) => {
            target.messages = target.messages.concat(
              createMessage({
                role: "assistant",
                content: "",
                isError: true,
                errorCode:
                  error instanceof BackendApiError
                    ? error.code
                    : "NETWORK_ERROR",
                model: BACKEND_MODEL_LABEL,
              }),
            );
          },
        );
      }
    },

    /** 订阅(或重新订阅)一条 Request 的回答流 */
    followRequest(conversationId, requestId, messageId) {
      closeStream(conversationId);
      const subscription = subscribeRequestEvents(requestId, {
        onContent(text) {
          patchMessage(conversationId, messageId, (message) => {
            message.content = text;
            message.streaming = true;
          });
        },
        onStatus(frame) {
          const session = get().sessions.find((s) => s.id === conversationId);
          patchMessage(conversationId, messageId, (message) => {
            applyStatusToMessage(message, frame, session);
          });
        },
        onError(error) {
          patchMessage(conversationId, messageId, (message) => {
            message.streaming = false;
            message.isError = true;
            message.errorCode = error.code;
          });
        },
        onFinish(final) {
          forgetStream(conversationId);
          patchMessage(conversationId, messageId, (message) => {
            message.streaming = false;
            if (
              final.status === "FAILED" ||
              final.requestStatus === "TIMEOUT"
            ) {
              message.isError = true;
            }
            if (final.requestStatus === "CANCELLED") {
              message.isError = false;
            }
          });
          set((state) => ({
            sessions: state.sessions.map((s) =>
              s.id === conversationId
                ? { ...s, pendingRequestId: undefined, cancelling: false }
                : s,
            ),
          }));
          // 终态以数据库为准:内容帧漏收时回读一次,别把空气泡留给用户
          const settled = get()
            .sessions.find((s) => s.id === conversationId)
            ?.messages.find((m) => m.id === messageId);
          if (
            (final.status === "COMPLETED" ||
              final.requestStatus === "CANCELLED") &&
            settled &&
            !settled.content
          ) {
            void get().refreshSessionMessages(conversationId);
          }
          void get().reloadList();
        },
      });
      trackStream(conversationId, subscription);
    },

    async cancelRequest(conversationId) {
      const session = get().sessions.find((s) => s.id === conversationId);
      if (!session?.pendingRequestId) return;
      try {
        await cancelBackendRequest(session.pendingRequestId);
      } catch (error) {
        if (
          error instanceof BackendApiError &&
          error.code === "REQUEST_NOT_CANCELLABLE"
        ) {
          void get().refreshSessionMessages(conversationId);
          return;
        }
        notifyError(error);
      }
    },

    async loadModels(force?: boolean) {
      const { modelCatalogStatus } = get();
      if (modelCatalogStatus === "loading") return;
      if (modelCatalogStatus === "ready" && !force) return;
      set({ modelCatalogStatus: "loading" });
      try {
        const catalog = await listProviderModels();
        set({ modelCatalog: catalog.models, modelCatalogStatus: "ready" });
      } catch (error) {
        console.error("[Chat] 模型目录加载失败", error);
        // FIX-07:PROVIDER_NOT_READY(Scheduler 持锁)重置为 idle 允许重试,其他错误仍为 error
        if (
          error instanceof BackendApiError &&
          error.code === "PROVIDER_NOT_READY"
        ) {
          set({ modelCatalogStatus: "idle" });
        } else {
          set({ modelCatalogStatus: "error" });
        }
      }
    },

    async setSessionModel(sessionId, key) {
      const session = get().sessions.find((s) => s.id === sessionId);
      if (!session || session.pendingRequestId) return;
      if (modelSavingSessionIds.has(sessionId)) return;
      const previous = session.preferredModelKey ?? null;
      if (previous === key) return;

      // FIX-05:Draft 仅本地更新,首次发送时才建 Conversation
      if (session.draft) {
        get().updateTargetSession(
          { id: sessionId } as ChatSession,
          (target) => {
            target.preferredModelKey = key;
          },
        );
        return;
      }

      modelSavingSessionIds.add(sessionId);
      get().updateTargetSession({ id: sessionId } as ChatSession, (target) => {
        target.preferredModelKey = key;
      });
      try {
        const updated = await patchConversation(sessionId, {
          preferredModelKey: key,
        });
        get().updateTargetSession(
          { id: sessionId } as ChatSession,
          (target) => {
            target.preferredModelKey = updated.preferredModelKey ?? null;
          },
        );
      } catch (error) {
        notifyError(error);
        get().updateTargetSession(
          { id: sessionId } as ChatSession,
          (target) => {
            target.preferredModelKey = previous;
          },
        );
      } finally {
        modelSavingSessionIds.delete(sessionId);
      }
    },

    isModelSaving(sessionId) {
      return modelSavingSessionIds.has(sessionId);
    },

    async clearAllData() {
      closeAllStreams();
      await indexedDBStorage.clear();
      localStorage.clear();
      location.reload();
    },
  };

  return { ...DEFAULT_CHAT_STATE, ...actions };
});
