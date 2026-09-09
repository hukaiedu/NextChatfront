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
  BackendMessagePage,
  BackendModelOption,
  BackendRequest,
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
  /**
   * PAG-2:后端 position;persisted Backend Message 必有,local transient(persisted 前的
   * 本地占位 / send 失败 error bubble)允许 undefined。禁止 ?? 0 之类的兜底。
   */
  position?: number;
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

  // PAG-2 Message 分页四字段(§11):
  /** 更老一页游标;null = 已到最老/无更老历史 */
  messageNextCursor: string | null;
  /** loadOlderMessages 单飞闸门 */
  loadingOlderMessages: boolean;
  /** 加载更老历史失败(唯一置 true 路径 = loadOlder 当前 cursor 失败;Retry 重发同 cursor) */
  messageHistoryError: boolean;
  /** 会话 Message 后端总数(meta.totalCount 权威建立;send 经 Math.max 单调推进) */
  messageTotalCount: number;
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
    messageNextCursor: null,
    loadingOlderMessages: false,
    messageHistoryError: false,
    messageTotalCount: 0,
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
    // PAG-2:persisted Backend Message 的 position 原样写入(缺省即 invariant,不兜底)
    position: message.position,
  };
}

function isMessageSettled(status: BackendMessage["status"]): boolean {
  return (
    status === "COMPLETED" || status === "FAILED" || status === "CANCELLED"
  );
}

/**
 * PAG-2 唯一同 id Message 合并规则(全文档唯一,三入口共用:latest overlap 区合并 /
 * bootstrap 同 id overlay / send-result ASSISTANT upsert)。
 * 规则表(状态只允许向终态推进,不允许倒退):
 * - local 终态 + fresh PENDING/STREAMING → local(stale 后端快照不得倒退本地终态/流式内容)
 * - local streaming + fresh 非 settled → local(防 SSE delta 闪断)
 * - local streaming + fresh settled → fresh(向终态推进,合法)
 * - 其他 → fresh(后端权威)
 * ChatMessage 里 settled ⇔ streaming!==true(FAILED/CANCELLED/COMPLETED 均推导出 false),
 * 于是四行收敛为:fresh 未终态 → 保留 local,fresh 已终态 → 采用 fresh。
 */
export function mergeFreshMessageWithLocal(
  fresh: ChatMessage,
  local: ChatMessage,
): ChatMessage {
  return fresh.streaming ? local : fresh;
}

/**
 * PAG-2:send result 落位唯一 helper(REVIEW-36 id-upsert,替代 concat):
 * USER 本地不存在 → append,同 id 已存在 → 不重复插入;
 * ASSISTANT 本地不存在 → 插入(streaming 保持 toChatMessage 按 Backend status 推导,
 * 禁手工强制 true),同 id 已存在 → 复用上方唯一合并规则,POST 初始 PENDING 快照
 * 不得覆盖 GET/SSE 已得到的较新状态。
 */
export function applySendResultMessages(
  currentMessages: ChatMessage[],
  userMessage: ChatMessage,
  assistantMessage: ChatMessage,
): ChatMessage[] {
  const next = currentMessages.slice();
  if (!next.some((m) => m.id === userMessage.id)) {
    next.push(userMessage);
  }
  const assistantIndex = next.findIndex((m) => m.id === assistantMessage.id);
  if (assistantIndex < 0) {
    next.push(assistantMessage);
  } else {
    next[assistantIndex] = mergeFreshMessageWithLocal(
      assistantMessage,
      next[assistantIndex]!,
    );
  }
  return next;
}

/**
 * PAG-2:send 侧 Request tracking 条件性 reconciliation(REVIEW-37 唯一纯函数,S1/S2/S3)。
 * 判定必须基于 merge 后的 assistant(当前本地最新事实),不是 POST 返回的旧创建快照;
 * 只有「当前尚未 tracking 该 request + request active(isRequestFinished 唯一入口)+
 * merge 后 assistant streaming」才置 pending + follow(恰 1 次)。
 */
export function reconcileSendRequestTracking(
  currentPendingRequestId: string | undefined,
  request: BackendRequest,
  mergedAssistant: ChatMessage,
): { nextPendingRequestId: string | undefined; shouldFollowRequest: boolean } {
  const requestFinished = isRequestFinished(request.status);
  const assistantStillStreaming = mergedAssistant.streaming === true;

  // S1:当前 pending 已经是同一个 Request(GET/latest 已先发现并建立 SSE)
  if (currentPendingRequestId === request.id) {
    if (requestFinished || !assistantStillStreaming) {
      // request terminal,或 merge 后 assistant 已 terminal:不能复活 pending
      return { nextPendingRequestId: undefined, shouldFollowRequest: false };
    }
    // request active + merged assistant streaming:SSE 已在工作,绝不 close/reopen
    return { nextPendingRequestId: request.id, shouldFollowRequest: false };
  }

  // S2:当前没有 pending(正常「POST response 先到」路径)
  if (currentPendingRequestId === undefined) {
    if (requestFinished || !assistantStillStreaming) {
      // GET/SSE 已经先完成该 request,POST 旧 PENDING 快照后到:不得重新订阅
      return { nextPendingRequestId: undefined, shouldFollowRequest: false };
    }
    return { nextPendingRequestId: request.id, shouldFollowRequest: true };
  }

  // S3:当前 pending 是另一个 Request —— 不得因可能 stale / deduplicated 的 POST
  // response 关掉当前另一条正在工作的 SSE;不引入更复杂的冲突恢复机制
  console.warn(
    "[Chat] invariant: send response request 与当前 pending 不一致",
    currentPendingRequestId,
    request.id,
  );
  return {
    nextPendingRequestId: currentPendingRequestId,
    shouldFollowRequest: false,
  };
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
    messageNextCursor: null,
    loadingOlderMessages: false,
    messageHistoryError: false,
    messageTotalCount: 0,
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
  /** PAG-2:向上加载更老一页(§13);返回值仅供 caller cleanup / 测试 / 调试 */
  loadOlderMessages(
    sessionId: string,
  ): Promise<{ applied: boolean; prependedCount: number }>;
  /** PAG-2:Export 独立全量 snapshot(§27.1),不写回 ChatStore */
  prepareMessagesForExport(sessionId: string): Promise<ChatMessage[]>;
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

  // PAG-2 Message 分页(§12/§18):per-session ownership 闭包结构,非 zustand state。
  // 不引入 PAG-1 式全局 epoch —— Message 分页是 per-session 独立游标,粒度 = conversationId。
  const LATEST_MESSAGES_LIMIT = 50;
  /** freshness intent version,per conversation(§12) */
  const latestMessageVersions = new Map<string, number>();
  /** 当前 inflight latest HTTP(§12) */
  const latestMessageRequestSlots = new Map<
    string,
    { token: symbol; version: number }
  >();
  /** trailing refresh intent(§12) */
  const pendingLatestRefreshIds = new Set<string>();
  /** loadOlderMessages 归属(§13) */
  const olderMessageRequestTokens = new Map<string, symbol>();
  /** prepareMessagesForExport 归属(§27.1) */
  const exportMessageRequestTokens = new Map<string, symbol>();

  /** 清除结构的唯一入口(§18 REVIEW-12,禁止业务函数散落 map.delete) */
  function clearMessageRequestOwnership(sessionId: string): void {
    latestMessageVersions.delete(sessionId);
    latestMessageRequestSlots.delete(sessionId);
    pendingLatestRefreshIds.delete(sessionId);
    olderMessageRequestTokens.delete(sessionId);
    exportMessageRequestTokens.delete(sessionId);
  }

  function clearAllMessageRequestOwnership(): void {
    latestMessageVersions.clear();
    latestMessageRequestSlots.clear();
    pendingLatestRefreshIds.clear();
    olderMessageRequestTokens.clear();
    exportMessageRequestTokens.clear();
  }

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
        // §11 来源 B:新建会话 = 合法空 chain,六项写死
        messageNextCursor: null,
        loadingOlderMessages: false,
        messageHistoryError: false,
        messageTotalCount: 0,
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

  /**
   * §14.4:latest 侧 pendingRequestId reconciliation(merge 完成之后执行)。
   * 判定基于 merge 后 assistant + fresh 携带的 request 摘要;Request terminal 唯一入口
   * isRequestFinished,Message 终态用 isMessageSettled 推导的 streaming,两套不混用。
   * 只有「新发现 running Request」才 shouldFollowRequest=true(followRequest 非幂等)。
   */
  function reconcileLatestPendingRequest(
    currentPendingRequestId: string | undefined,
    mergedMessages: ChatMessage[],
    freshItems: BackendMessage[],
  ): {
    nextPendingRequestId: string | undefined;
    shouldFollowRequest: boolean;
    followMessageId?: string;
  } {
    if (currentPendingRequestId) {
      const freshAssistant = freshItems.find(
        (m) =>
          m.role === "ASSISTANT" && m.request?.id === currentPendingRequestId,
      );
      if (!freshAssistant?.request) {
        // fresh 未包含 currentPending:absence 不是 terminal proof,保留
        return {
          nextPendingRequestId: currentPendingRequestId,
          shouldFollowRequest: false,
        };
      }
      if (isRequestFinished(freshAssistant.request.status)) {
        // fresh 明确带回终态(SUCCESS/FAILED/TIMEOUT/CANCELLED):clear
        return { nextPendingRequestId: undefined, shouldFollowRequest: false };
      }
      // 仍 active:merge 后 assistant streaming → 保留,绝不 close/reopen
      const mergedAssistant = mergedMessages.find(
        (m) => m.id === freshAssistant.id,
      );
      if (mergedAssistant?.streaming === true) {
        return {
          nextPendingRequestId: currentPendingRequestId,
          shouldFollowRequest: false,
        };
      }
      // 本地终态已先落盘:不得重新保持/恢复
      return { nextPendingRequestId: undefined, shouldFollowRequest: false };
    }

    const candidate = freshItems.find(
      (m) =>
        m.role === "ASSISTANT" &&
        m.request &&
        !isRequestFinished(m.request.status),
    );
    if (!candidate?.request) {
      return { nextPendingRequestId: undefined, shouldFollowRequest: false };
    }
    const mergedCandidate = mergedMessages.find((m) => m.id === candidate.id);
    if (mergedCandidate?.streaming === true) {
      // 新发现 running → 恢复 pending + follow 恰 1 次
      return {
        nextPendingRequestId: candidate.request.id,
        shouldFollowRequest: true,
        followMessageId: candidate.id,
      };
    }
    // merge 后 candidate 已 terminal:不得从 stale fresh 重新创建
    return { nextPendingRequestId: undefined, shouldFollowRequest: false };
  }

  /**
   * §14:latest 响应 apply(chainEstablished 分支 + 三段 merge + empty 边界)。
   * 调用前置条件:responseIsLatest === true(§12);本函数只做 apply,不做 stale 判定。
   */
  function applyLatestPage(sessionId: string, page: BackendMessagePage): void {
    const current = get().sessions.find((s) => s.id === sessionId);
    if (!current || current.draft) return;
    const chainEstablished = current.loaded === true;
    const fresh = page.items;

    // §14.5 ③:空 items 与正 totalCount 自相矛盾 → 不 apply
    if (fresh.length === 0 && page.totalCount > 0) {
      notifyError(new Error("Inconsistent message page response"));
      return;
    }

    let nextMessages: ChatMessage[];
    let nextCursor: string | null;
    let nextTotalCount: number;
    let nextHistoryError: boolean;

    if (!chainEstablished) {
      // §14.2 bootstrap latest:fresh 建 chain + 同 id overlay
      const currentPersisted = current.messages.filter(
        (m) => m.position !== undefined,
      );
      if (fresh.length === 0) {
        // §14.5 ①:本地已有 persisted send result 而后端 0 条 → inconsistent
        if (currentPersisted.length > 0) {
          notifyError(new Error("Inconsistent empty bootstrap page"));
          return;
        }
        nextMessages = [];
        nextCursor = null;
        nextTotalCount = 0;
        nextHistoryError = false;
      } else {
        // send-result presence invariant(REVIEW-30):pending 对应 assistant 必在最新页
        const currentPendingId = current.pendingRequestId;
        if (
          currentPendingId &&
          !fresh.some(
            (m) => m.role === "ASSISTANT" && m.request?.id === currentPendingId,
          )
        ) {
          notifyError(new Error("Inconsistent bootstrap page"));
          return;
        }
        const localById = new Map(
          currentPersisted.map((m) => [m.id, m] as const),
        );
        nextMessages = fresh.map((backendMessage) => {
          const freshMessage = toChatMessage(backendMessage);
          const local = localById.get(freshMessage.id);
          return local
            ? mergeFreshMessageWithLocal(freshMessage, local)
            : freshMessage;
        });
        nextCursor = page.nextCursor;
        nextTotalCount = page.totalCount;
        nextHistoryError = false;
      }
    } else {
      // §14.3 chainEstablished=true 三分类
      const currentPersisted = current.messages.filter(
        (m) => m.position !== undefined,
      );
      if (fresh.length === 0) {
        // §14.5 ②:异常 authoritative reset(meta.totalCount 必为 0,③ 已拦截 >0)
        nextMessages = [];
        nextCursor = null;
        nextTotalCount = page.totalCount;
        nextHistoryError = false;
      } else if (currentPersisted.length === 0) {
        // Case 0:合法空链重建为非空
        nextMessages = fresh.map(toChatMessage);
        nextCursor = page.nextCursor;
        nextTotalCount = Math.max(current.messageTotalCount, page.totalCount);
        nextHistoryError = false;
      } else {
        const freshPositions = fresh.map((m) => m.position);
        const freshMin = Math.min(...freshPositions);
        const freshMax = Math.max(...freshPositions);
        const localMax = Math.max(
          ...currentPersisted.map((m) => m.position as number),
        );
        if (freshMin > localMax + 1) {
          // Case 2:gap fallback,整组替换重建连续链
          nextMessages = fresh.map(toChatMessage);
          nextCursor = page.nextCursor;
          nextTotalCount = Math.max(current.messageTotalCount, page.totalCount);
          nextHistoryError = false;
        } else {
          // Case 1:overlap / adjacent 三段 merge
          const localById = new Map(
            currentPersisted.map((m) => [m.id, m] as const),
          );
          const older = currentPersisted.filter(
            (m) => (m.position as number) < freshMin,
          );
          const newer = currentPersisted.filter(
            (m) => (m.position as number) > freshMax,
          );
          const overlap = fresh.map((backendMessage) => {
            const freshMessage = toChatMessage(backendMessage);
            const local = localById.get(freshMessage.id);
            return local
              ? mergeFreshMessageWithLocal(freshMessage, local)
              : freshMessage;
          });
          nextMessages = [...older, ...overlap, ...newer];
          // older 游标与 latest 无关,refresh 只看最新页 → 保持旧值(REVIEW-11)
          nextCursor = current.messageNextCursor;
          nextTotalCount = Math.max(current.messageTotalCount, page.totalCount);
          // 普通 latest refresh 不清 older 失败态(REVIEW-29)
          nextHistoryError = current.messageHistoryError;
        }
      }
    }

    const hadPending = current.pendingRequestId !== undefined;
    const reconciliation = reconcileLatestPendingRequest(
      current.pendingRequestId,
      nextMessages,
      fresh,
    );
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        return {
          ...s,
          messages: nextMessages,
          loaded: true,
          messageNextCursor: nextCursor,
          messageTotalCount: nextTotalCount,
          messageHistoryError: nextHistoryError,
          pendingRequestId: reconciliation.nextPendingRequestId,
          ...(hadPending && reconciliation.nextPendingRequestId === undefined
            ? { cancelling: false }
            : {}),
        };
      }),
    }));
    if (
      reconciliation.shouldFollowRequest &&
      reconciliation.nextPendingRequestId &&
      reconciliation.followMessageId
    ) {
      get().followRequest(
        sessionId,
        reconciliation.nextPendingRequestId,
        reconciliation.followMessageId,
      );
    }
  }

  /**
   * §12:latest HTTP 内核(initial / refresh / trailing 共用)。
   * stale(成功或失败)完全静默;finally 原子 handoff(ownsLatestSlot 才有权收尾)。
   */
  async function runLatestMessagesHttp(
    sessionId: string,
    token: symbol,
    requestVersion: number,
  ): Promise<void> {
    const responseIsLatest = () =>
      latestMessageVersions.get(sessionId) === requestVersion &&
      latestMessageRequestSlots.get(sessionId)?.token === token &&
      !!get().sessions.find((s) => s.id === sessionId && !s.draft);
    try {
      let page: BackendMessagePage;
      try {
        page = await listMessages(sessionId, { limit: LATEST_MESSAGES_LIMIT });
      } catch (error) {
        if (responseIsLatest()) {
          notifyError(error);
        }
        return;
      }
      if (!responseIsLatest()) return; // stale:完全不写 state
      applyLatestPage(sessionId, page);
    } finally {
      if (latestMessageRequestSlots.get(sessionId)?.token === token) {
        if (pendingLatestRefreshIds.has(sessionId)) {
          // 原子 handoff:旧 slot → trailing 新 slot 一步替换,loadingMessages 恒 true
          pendingLatestRefreshIds.delete(sessionId);
          const trailingToken = Symbol("latest");
          latestMessageRequestSlots.set(sessionId, {
            token: trailingToken,
            version: latestMessageVersions.get(sessionId) ?? requestVersion,
          });
          void runLatestMessagesHttp(
            sessionId,
            trailingToken,
            latestMessageVersions.get(sessionId) ?? requestVersion,
          );
        } else {
          latestMessageRequestSlots.delete(sessionId);
          set((state) => ({
            sessions: state.sessions.map((s) =>
              s.id === sessionId ? { ...s, loadingMessages: false } : s,
            ),
          }));
        }
      }
    }
  }

  /**
   * §12.1:send 成功 = latest 快照失效事件,五分支(D 优先于 inflight 判定)。
   * loaded / totalCount / latest slot 的唯一 owner;send 结果落位不在此函数。
   */
  function handleLatestAfterSend(
    sessionId: string,
    options: {
      wasDraft: boolean;
      chainWasEstablishedAtApply: boolean;
      assistantPosition: number;
    },
  ): void {
    const advanceTotalCount = () => {
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                messageTotalCount: Math.max(
                  s.messageTotalCount,
                  options.assistantPosition,
                ),
              }
            : s,
        ),
      }));
    };

    // D:草稿首次成功 send,历史 = 本次 user + assistant,完整已知
    if (options.wasDraft) {
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                loaded: true,
                messageNextCursor: null,
                messageTotalCount: Math.max(
                  s.messageTotalCount,
                  options.assistantPosition,
                ),
              }
            : s,
        ),
      }));
      return;
    }

    if (latestMessageRequestSlots.has(sessionId)) {
      // A1/A2:旧 response 从 send success 一刻起 stale;intent 由 pending 承载
      const version = (latestMessageVersions.get(sessionId) ?? 0) + 1;
      latestMessageVersions.set(sessionId, version);
      pendingLatestRefreshIds.add(sessionId);
      if (options.chainWasEstablishedAtApply) {
        advanceTotalCount(); // A1:立即同步,不等 trailing
      }
      // A2:totalCount 不变(禁止 0+2 冒充),loaded 保持 false
      return;
    }

    if (options.chainWasEstablishedAtApply) {
      advanceTotalCount(); // B:send result 已是权威新尾部,不额外 GET
      return;
    }

    // C:existing unloaded → 启动 bootstrap latest(loaded 保持 false 直到成功)
    void get().loadSessionMessages(sessionId);
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
                // PAG-2 §20:列表权威刷新不得丢会话 Message 分页进度
                messageNextCursor: current.messageNextCursor,
                loadingOlderMessages: current.loadingOlderMessages,
                messageHistoryError: current.messageHistoryError,
                messageTotalCount: current.messageTotalCount,
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
      clearAllMessageRequestOwnership();
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

    /** 打开会话:未加载过就拉最新一页,并续接仍在执行的 Request(§八/§12) */
    async loadSessionMessages(sessionId: string) {
      const session = get().sessions.find((s) => s.id === sessionId);
      if (
        !session ||
        session.draft ||
        session.loaded ||
        session.loadingMessages
      )
        return;

      const version = (latestMessageVersions.get(sessionId) ?? 0) + 1;
      latestMessageVersions.set(sessionId, version);
      const token = Symbol("latest");
      latestMessageRequestSlots.set(sessionId, { token, version });
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, loadingMessages: true } : s,
        ),
      }));
      await runLatestMessagesHttp(sessionId, token, version);
    },

    /** 手动刷新:authoritative refresh intent(§12),顺带续接仍在执行的 Request */
    async refreshSessionMessages(sessionId: string) {
      const session = get().sessions.find((s) => s.id === sessionId);
      if (!session || session.draft) return;

      // 第一件事就是 bump:version 增加的这一刻,一切在飞 latest response 已经 stale
      const nextVersion = (latestMessageVersions.get(sessionId) ?? 0) + 1;
      latestMessageVersions.set(sessionId, nextVersion);
      if (latestMessageRequestSlots.has(sessionId)) {
        // 不并发第二个 HTTP,intent 由 pending 承载(trailing)
        pendingLatestRefreshIds.add(sessionId);
        return;
      }
      const token = Symbol("latest");
      latestMessageRequestSlots.set(sessionId, { token, version: nextVersion });
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, loadingMessages: true } : s,
        ),
      }));
      await runLatestMessagesHttp(sessionId, token, nextVersion);
    },

    /** PAG-2 §13:向上加载更老一页;guard 五条件即单飞闸门 */
    async loadOlderMessages(sessionId) {
      const session = get().sessions.find((s) => s.id === sessionId);
      if (
        !session ||
        session.draft ||
        !session.loaded ||
        session.loadingOlderMessages ||
        session.messageNextCursor === null
      ) {
        return { applied: false, prependedCount: 0 };
      }
      const token = Symbol("older");
      const requestedCursor = session.messageNextCursor;
      olderMessageRequestTokens.set(sessionId, token);
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, loadingOlderMessages: true } : s,
        ),
      }));
      const writeGuardOk = () => {
        const current = get().sessions.find((s) => s.id === sessionId);
        return (
          !!current &&
          !current.draft &&
          olderMessageRequestTokens.get(sessionId) === token &&
          current.loadingOlderMessages === true &&
          current.messageNextCursor === requestedCursor
        );
      };
      try {
        let page: BackendMessagePage;
        try {
          page = await listMessages(sessionId, {
            limit: LATEST_MESSAGES_LIMIT,
            cursor: requestedCursor,
          });
        } catch {
          // 失败(检查通过时):唯一 messageHistoryError=true 路径,其余全不动,不 toast
          if (writeGuardOk()) {
            set((state) => ({
              sessions: state.sessions.map((s) =>
                s.id === sessionId ? { ...s, messageHistoryError: true } : s,
              ),
            }));
          }
          return { applied: false, prependedCount: 0 };
        }
        // 写盘前五重检查,任一不满足 → 整体丢弃
        if (!writeGuardOk()) return { applied: false, prependedCount: 0 };
        const items = page.items.map(toChatMessage);
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  messages: [...items, ...s.messages],
                  messageNextCursor: page.nextCursor,
                  messageTotalCount: Math.max(
                    s.messageTotalCount,
                    page.totalCount,
                  ),
                  messageHistoryError: false,
                }
              : s,
          ),
        }));
        return { applied: true, prependedCount: items.length };
      } finally {
        // 仅当归属仍是自己才收尾,否则说明已有新请求接管
        if (olderMessageRequestTokens.get(sessionId) === token) {
          olderMessageRequestTokens.delete(sessionId);
          set((state) => ({
            sessions: state.sessions.map((s) =>
              s.id === sessionId ? { ...s, loadingOlderMessages: false } : s,
            ),
          }));
        }
      }
    },

    /** PAG-2 §27.1:Export 独立全量 snapshot;完全不写 ChatStore */
    async prepareMessagesForExport(sessionId) {
      const session = get().sessions.find((s) => s.id === sessionId);
      if (!session || session.draft || !session.loaded) {
        throw new Error("会话尚未加载完成,无法导出");
      }
      const token = Symbol("export");
      exportMessageRequestTokens.set(sessionId, token);
      const tokenOwned = () =>
        exportMessageRequestTokens.get(sessionId) === token;
      try {
        const pages: ChatMessage[][] = [];
        let snapshotTotalCount = 0;
        let cursor: string | null = null;
        let firstPage = true;
        while (true) {
          const page = await listMessages(sessionId, {
            limit: LATEST_MESSAGES_LIMIT,
            cursor,
          });
          // 每页写 accumulator 前检查 token:Modal 已关 / session 重建 → 中止
          if (!tokenOwned()) {
            throw new Error("导出已取消");
          }
          if (firstPage) {
            snapshotTotalCount = page.totalCount;
            firstPage = false;
          }
          pages.push(page.items.map(toChatMessage));
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
        }
        // 页序 = 最新页在前;reverse 后按 position asc 拼接,同 id 去重
        const accumulator: ChatMessage[] = [];
        const seenIds = new Set<string>();
        for (const pageItems of pages.slice().reverse()) {
          for (const message of pageItems) {
            if (seenIds.has(message.id)) continue;
            seenIds.add(message.id);
            accumulator.push(message);
          }
        }
        if (accumulator.length !== snapshotTotalCount) {
          throw new Error("导出快照不一致,请重试");
        }
        return accumulator;
      } finally {
        if (tokenOwned()) {
          exportMessageRequestTokens.delete(sessionId);
        }
      }
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
        clearAllMessageRequestOwnership();
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

      // 跨 await 只保存 identity,不保存 position —— 网络往返期间列表可被
      // reload/浮顶重排/switchListStatus 改写,调用时 index 不再可信(PAG-1 FIX-01)
      const targetId = session.id;

      if (!session.draft) {
        closeStream(targetId);
        try {
          await deleteConversation(targetId);
        } catch (error) {
          notifyError(error);
          return;
        }
      }

      set((state) => {
        // apply 时在最新 state 上按 targetId 重定位
        const removeIndex = state.sessions.findIndex((s) => s.id === targetId);
        if (removeIndex < 0) {
          // target 已不在当前列表(await 期间被权威刷新/切状态移除):
          // 本地 no-op,绝不按旧 index 误删当前列表中的其他项
          return {};
        }
        // current selection identity 也必须在 apply 时读取:DELETE 等待期间
        // 用户可能主动切换 selection,不得被发起时的快照覆盖
        const currentId = state.sessions[state.currentSessionIndex]?.id;
        const sessions = state.sessions.slice();
        sessions.splice(removeIndex, 1);
        if (!sessions.length && state.listStatus === "ACTIVE")
          sessions.push(createDraftSession());
        // identity-first:删除非当前前项时原当前会话左移,纯 clamp 会漂到右邻项
        // (FINDING-02);删的是当前项则原位下一项 / 最后项前一项
        let next: number;
        if (currentId !== undefined && currentId !== targetId) {
          const found = sessions.findIndex((s) => s.id === currentId);
          next =
            found >= 0
              ? found
              : Math.max(
                  0,
                  Math.min(state.currentSessionIndex, sessions.length - 1),
                );
        } else if (currentId === targetId) {
          next = Math.max(0, Math.min(removeIndex, sessions.length - 1));
        } else {
          next = Math.max(
            0,
            Math.min(state.currentSessionIndex, sessions.length - 1),
          );
        }
        return { sessions, currentSessionIndex: next };
      });
      clearMessageRequestOwnership(targetId);
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
      clearMessageRequestOwnership(session.id);
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
      clearMessageRequestOwnership(session.id);
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
     * PAG-2 §12.1:send 成功路径按 11 步 apply(第 1~10 步无 await)。
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

      // REVIEW-26/35:入口只捕获草稿两项;chain 状态在 POST 返回后读 apply 时刻真值
      const wasDraft = session.draft === true;
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

      const existing = get().sessions.find((s) => s.id === conversationId);
      if (existing?.pendingRequestId) {
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

        // §12.1 第 1 步:POST 返回后、写本地前重读 apply 时刻状态
        const targetBeforeSendApply = get().sessions.find(
          (s) => s.id === conversationId,
        );
        if (!targetBeforeSendApply) {
          // 会话在 POST 在飞期间被删除:沿用现有生命周期处理
          return;
        }
        // 第 2/3 步:同一时刻捕获 chain 与 pending
        const chainWasEstablishedAtApply =
          targetBeforeSendApply.loaded === true;
        const pendingRequestIdAtApply = targetBeforeSendApply.pendingRequestId;

        // 第 4 步:streaming 保持 toChatMessage 按 Backend status 推导,禁手工强制 true
        const userMessage = toChatMessage(result.userMessage);
        const assistantMessage = toChatMessage(result.assistantMessage);
        // 第 5 步:id-upsert(禁 concat)
        const nextMessages = applySendResultMessages(
          targetBeforeSendApply.messages,
          userMessage,
          assistantMessage,
        );
        // 第 6 步:判定基于 merge 后 assistant,不是 POST 旧创建快照
        const mergedAssistant = nextMessages.find(
          (m) => m.id === result.assistantMessage.id,
        )!;
        // 第 7 步:S1/S2/S3 条件性 reconciliation
        const reconciliation = reconcileSendRequestTracking(
          pendingRequestIdAtApply,
          result.request,
          mergedAssistant,
        );
        // 第 8 步:一次 Zustand update(loaded 不在此处置位,owner 是五分支)
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === conversationId
              ? {
                  ...s,
                  draft: false,
                  messages: nextMessages,
                  lastUpdate: Date.now(),
                  pendingRequestId: reconciliation.nextPendingRequestId,
                  ...(draftModelKey !== undefined
                    ? { preferredModelKey: draftModelKey }
                    : {}),
                }
              : s,
          ),
        }));

        // 第 9 步:五分支(D/A1/A2/B/C)接管 loaded / totalCount / latest slot
        handleLatestAfterSend(conversationId, {
          wasDraft,
          chainWasEstablishedAtApply,
          assistantPosition: result.assistantMessage.position,
        });
        // 第 10 步:只有新发现需要追踪的 running Request 才 follow(恰 1 次)
        if (reconciliation.shouldFollowRequest) {
          get().followRequest(
            conversationId,
            result.request.id,
            mergedAssistant.id,
          );
        }
        // 第 11 步
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
      clearAllMessageRequestOwnership();
      await indexedDBStorage.clear();
      localStorage.clear();
      location.reload();
    },
  };

  return { ...DEFAULT_CHAT_STATE, ...actions };
});
