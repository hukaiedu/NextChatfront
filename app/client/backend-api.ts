/**
 * personChat 后端 API 客户端(第 7 阶段)。
 *
 * 浏览器只和同源 `/backend-api/*` 说话,由 next.config.mjs 代理到后端 `/api/*`,
 * 所以这里不需要 CORS、也不需要上游 Provider 的任何鉴权头。
 */

const PREFIX = "/backend-api";

export type ConversationStatus = "ACTIVE" | "ARCHIVED";
export type BackendMessageRole = "USER" | "ASSISTANT";
/** Assistant Message 的状态机(与后端 Message.status 一一对应) */
export type BackendMessageStatus =
  | "PENDING"
  | "STREAMING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";
export type BackendRequestStatus =
  | "PENDING"
  | "PROCESSING"
  | "CANCELLING"
  | "SUCCESS"
  | "FAILED"
  | "TIMEOUT"
  | "CANCELLED";

export interface BackendConversation {
  id: string;
  title: string;
  status: ConversationStatus | "DELETED";
  provider: string;
  providerConversationUrl: string | null;
  /** M4:会话维度的模型偏好;null = 未指定(默认模型) */
  preferredModelKey: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** M4:GET /api/provider/models 返回的目录项(字段与后端 GeminiModelOption 对应) */
export interface BackendModelOption {
  key: string;
  label: string;
  /** 页面当前选中的模型(页面状态,与会话偏好无关) */
  selected: boolean;
  disabled: boolean;
}

export interface BackendModelCatalog {
  models: BackendModelOption[];
  currentModelKey: string | null;
}

/** 后端 Playwright 浏览器实例的生命周期状态 */
export type BackendBrowserState =
  | "RUNNING"
  | "STARTING"
  | "RESTARTING"
  | "STOPPED"
  | "FAILED";

export interface BackendBrowserError {
  code: string;
  message?: string | null;
  /** 该错误发生时间(ISO) */
  at?: string | null;
}

/**
 * GET /api/browser/status 的负载。
 *
 * 除 `state` 外全部可选:后端字段缺失时 UI 显示占位符,而不是整块面板报错。
 */
export interface BackendBrowserStatus {
  state: BackendBrowserState;
  /** "chromium" / "chrome" / "msedge" */
  browserType?: string | null;
  headless?: boolean | null;
  /** 持久化 Profile 目录,相对后端工作目录 */
  profileDir?: string | null;
  /** 本次浏览器启动时间(ISO) */
  startedAt?: string | null;
  uptimeMs?: number | null;
  /** Gemini 登录态;null = 后端未探测 */
  providerLoggedIn?: boolean | null;
  /** 正在 PENDING / PROCESSING / CANCELLING 的 Request 数 */
  activeRequests?: number | null;
  lastError?: BackendBrowserError | null;
  /** 后端生成该快照的时间(ISO),用于判断数据新鲜度 */
  observedAt?: string | null;
}

export interface BackendRequestBrief {
  id: string;
  status: BackendRequestStatus;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface BackendMessage {
  id: string;
  conversationId: string;
  role: BackendMessageRole;
  content: string;
  status: BackendMessageStatus;
  position: number;
  createdAt: string;
  updatedAt: string;
  /** 只有 ASSISTANT 消息带;USER 消息固定 null */
  request?: BackendRequestBrief | null;
}

export interface BackendRequest {
  id: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  status: BackendRequestStatus;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SendMessageResult {
  request: BackendRequest;
  userMessage: BackendMessage;
  assistantMessage: BackendMessage;
  deduplicated: boolean;
}

/** 后端统一错误信封 `{ error: { code, message, requestId } }` */
export class BackendApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    /** 429 限流响应 Retry-After 头的秒数;其余场景 undefined */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "BackendApiError";
  }
}

/**
 * 全局 401 回调(SEC-1 §11.2):业务 API 收到 AUTH_REQUIRED 时触发。
 * 由 auth store 经 setUnauthorizedHandler 注册,避免 store ↔ client 循环依赖。
 */
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

/** 仅业务 API 的 401 触发全局登出;auth 端点自身(如登录密码错)不触发(§11.2) */
function notifyUnauthorizedIfNeeded(
  path: string,
  status: number,
  code: string | undefined,
): void {
  if (status === 401 && code === "AUTH_REQUIRED" && !path.startsWith("/auth")) {
    unauthorizedHandler?.();
  }
}

export const REQUEST_ACTIVE_STATUSES: BackendRequestStatus[] = [
  "PENDING",
  "PROCESSING",
  "CANCELLING",
];

export function isRequestFinished(status: BackendRequestStatus): boolean {
  return !REQUEST_ACTIVE_STATUSES.includes(status);
}

export function newIdempotencyKey(): string {
  const cryptoRef = typeof crypto !== "undefined" ? crypto : undefined;
  if (typeof cryptoRef?.randomUUID === "function") {
    return `web-${cryptoRef.randomUUID()}`;
  }
  return `web-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

async function call<T>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const response = await fetch(`${PREFIX}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (
      payload as { error?: { code?: string; message?: string } } | null
    )?.error;
    notifyUnauthorizedIfNeeded(path, response.status, error?.code);
    throw new BackendApiError(
      error?.code ?? "NETWORK_ERROR",
      error?.message ?? `Request failed with status ${response.status}`,
      response.status,
      response.status === 429
        ? Number(response.headers?.get?.("Retry-After")) || undefined
        : undefined,
    );
  }

  return (payload as { data: T }).data;
}

export async function listConversations(
  status: ConversationStatus = "ACTIVE",
  cursor?: string | null,
): Promise<{ items: BackendConversation[]; nextCursor: string | null }> {
  const query = new URLSearchParams({ status, limit: "50" });
  if (cursor) query.set("cursor", cursor);
  const response = await fetch(`${PREFIX}/conversations?${query.toString()}`);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (
      payload as { error?: { code?: string; message?: string } } | null
    )?.error;
    notifyUnauthorizedIfNeeded("/conversations", response.status, error?.code);
    throw new BackendApiError(
      error?.code ?? "NETWORK_ERROR",
      error?.message ?? `Request failed with status ${response.status}`,
      response.status,
    );
  }
  const body = payload as {
    data: BackendConversation[];
    meta?: { nextCursor?: string | null };
  };
  return { items: body.data ?? [], nextCursor: body.meta?.nextCursor ?? null };
}

export function createConversation(
  title?: string,
): Promise<BackendConversation> {
  return call<BackendConversation>("/conversations", {
    method: "POST",
    body: title ? { title } : {},
  });
}

export function getConversation(id: string): Promise<BackendConversation> {
  return call<BackendConversation>(`/conversations/${encodeURIComponent(id)}`);
}

export function patchConversation(
  id: string,
  patch: {
    title?: string;
    status?: ConversationStatus;
    /** M4:显式 null = 清除偏好;undefined = 不动偏好(与后端 PATCH 语义一致) */
    preferredModelKey?: string | null;
  },
): Promise<BackendConversation> {
  return call<BackendConversation>(`/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
  });
}

export function deleteConversation(id: string): Promise<void> {
  return call<void>(`/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function listMessages(
  conversationId: string,
): Promise<BackendMessage[]> {
  return call<BackendMessage[]>(
    `/conversations/${encodeURIComponent(conversationId)}/messages`,
  );
}

export function sendMessage(
  conversationId: string,
  content: string,
  idempotencyKey: string,
  modelKey?: string,
): Promise<SendMessageResult> {
  return call<SendMessageResult>(
    `/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      body: {
        content,
        ...(modelKey !== undefined ? { modelKey } : {}),
      },
      headers: { "Idempotency-Key": idempotencyKey },
    },
  );
}

/** POST /api/requests/:id/cancel(prd §8.9) */
export function cancelRequest(requestId: string): Promise<BackendRequest> {
  return call<BackendRequest>(
    `/requests/${encodeURIComponent(requestId)}/cancel`,
    { method: "POST" },
  );
}

/** GET /api/provider/models(M4);Provider 非就绪时抛 BackendApiError */
export function listProviderModels(): Promise<BackendModelCatalog> {
  return call<BackendModelCatalog>("/provider/models");
}

/** GET /api/browser/status:服务端浏览器实例状态快照 */
export function getBrowserStatus(): Promise<BackendBrowserStatus> {
  return call<BackendBrowserStatus>("/browser/status");
}

/**
 * POST /api/browser/restart:重启服务端浏览器并返回重启后的状态。
 * 后端可能耗时较长(关旧实例 + 起新实例 + 打开 Gemini 页面)。
 */
export function restartBrowser(): Promise<BackendBrowserStatus> {
  return call<BackendBrowserStatus>("/browser/restart", { method: "POST" });
}

/** GET /api/auth/session 的负载(§四);disabled 模式恒 authenticated:true */
export interface AuthSessionInfo {
  authenticated: boolean;
  /** Session 过期时间(ISO);未认证或 disabled 模式为 null */
  expiresAt: string | null;
}

/** GET /api/auth/session:永不 401,启动探测与 SSE 重连探测共用 */
export function getAuthSession(): Promise<AuthSessionInfo> {
  return call<AuthSessionInfo>("/auth/session");
}

/** POST /api/auth/login:密码错 → 401,限流 → 429(信封 code + retryAfterSeconds) */
export function login(password: string): Promise<AuthSessionInfo> {
  return call<AuthSessionInfo>("/auth/login", {
    method: "POST",
    body: { password },
  });
}

/** POST /api/auth/logout:幂等 204,清 Session Cookie */
export function logout(): Promise<void> {
  return call<void>("/auth/logout", { method: "POST" });
}

/** 后端 SSE 帧的 data 负载 */
export interface RequestStatusFrame {
  requestId: string;
  /** Assistant Message 状态;会话还没写入时为 null */
  status: BackendMessageStatus | null;
  requestStatus: BackendRequestStatus;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface RequestEventHandlers {
  /** 当前完整文本(内部已把 delta 累加好,调用方只管覆盖渲染) */
  onContent(text: string): void;
  onStatus?(frame: RequestStatusFrame): void;
  /** 执行失败:带后端 errorCode */
  onError?(error: { code: string; message: string }): void;
  /** 终态(COMPLETED / FAILED / TIMEOUT)后连接已关闭 */
  onFinish?(final: {
    status: BackendMessageStatus | null;
    requestStatus: BackendRequestStatus;
  }): void;
}

export interface RequestEventSubscription {
  close(): void;
}

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

/**
 * §8.3:transport error 后的 session probe。多个 SSE 同时断开时共享同一次探测
 * (in-flight 合并);探测自身网络失败返回 null(第三态:不修改认证状态)。
 */
let authProbeInFlight: Promise<AuthSessionInfo | null> | null = null;

function probeAuthSession(): Promise<AuthSessionInfo | null> {
  authProbeInFlight ??= getAuthSession()
    .catch(() => null)
    .finally(() => {
      authProbeInFlight = null;
    });
  return authProbeInFlight;
}

/**
 * 订阅一条 Request 的回答流。
 *
 * 用 EventSource 而不是手写 fetch:浏览器原生带断线重连。但重连语义要自己收口 ——
 * 后端一进入终态就会主动结束响应,若不显式 close,EventSource 会不停重连一个已完成的
 * Request。内容累加以「本连接已发前缀」为基准:delta 是该前缀的后缀增量,重连首帧则是
 * 整段 snapshot(后端不重放历史 delta),它可能滞后于已渲染文本,只当作新前缀采用。
 */
export function subscribeRequestEvents(
  requestId: string,
  handlers: RequestEventHandlers,
): RequestEventSubscription {
  let closedByClient = false;
  let finished = false;
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  /** 本连接上服务端已给出的完整文本:delta 是它的后缀增量,必须按它拼接 */
  let sent = "";
  /** 已经渲染给 UI 的文本:重连首帧快照可能滞后,不拿它回退已显示的内容 */
  let shown = "";

  const readData = <T>(event: Event): T | null => {
    const raw = (event as MessageEvent).data;
    if (typeof raw !== "string") return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };

  const accept = (full: string) => {
    sent = full;
    if (full === shown) return;
    if (shown.length > full.length && shown.startsWith(full)) return;
    shown = full;
    handlers.onContent(full);
  };

  const finish = (final: {
    status: BackendMessageStatus | null;
    requestStatus: BackendRequestStatus;
  }) => {
    if (finished) return;
    finished = true;
    closeSource();
    handlers.onFinish?.(final);
  };

  const closeSource = () => {
    source?.close();
    source = null;
  };

  const scheduleReconnect = () => {
    if (closedByClient || finished) return;
    closeSource();
    const delay =
      RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    attempt += 1;
    retryTimer = setTimeout(open, delay);
  };

  function open() {
    if (closedByClient || finished) return;
    // 新连接上服务端按「本连接已发文本」重新推导前缀,首帧必是整段快照
    sent = "";
    source = new EventSource(
      `${PREFIX}/requests/${encodeURIComponent(requestId)}/events`,
    );

    source.addEventListener("delta", (event) => {
      const frame = readData<{ content: string }>(event);
      if (!frame) return;
      attempt = 0;
      accept(sent + frame.content);
    });

    source.addEventListener("snapshot", (event) => {
      const frame = readData<{ content: string }>(event);
      if (!frame) return;
      attempt = 0;
      accept(frame.content);
    });

    source.addEventListener("status", (event) => {
      const frame = readData<RequestStatusFrame>(event);
      if (!frame) return;
      attempt = 0;
      handlers.onStatus?.(frame);
      if (isRequestFinished(frame.requestStatus)) {
        finish({
          status: frame.status,
          requestStatus: frame.requestStatus,
        });
      }
    });

    // 后端的 `error` 事件名会被 EventSource 派发成同名 MessageEvent;
    // 传输层错误则是普通 Event(没有 data),两者要分开处理。
    source.addEventListener("error", (event) => {
      const frame = readData<{ code?: string; message?: string }>(event);
      if (frame) {
        handlers.onError?.({
          code: frame.code ?? "INTERNAL_ERROR",
          message: frame.message ?? "Request failed",
        });
        finish({ status: "FAILED", requestStatus: "FAILED" });
        return;
      }
      // 传输层错误(含 401 拒绝——EventSource 不暴露状态码,§8.2/§8.3):
      // 先探测 session,三态——失效则停连并全局登出;有效或探测失败则维持既有重连。
      void probeAuthSession().then((session) => {
        if (closedByClient || finished) return;
        if (session && !session.authenticated) {
          closedByClient = true;
          if (retryTimer) clearTimeout(retryTimer);
          closeSource();
          unauthorizedHandler?.();
          return;
        }
        if (source?.readyState === EventSource.CLOSED) {
          // 服务端已结束响应(多为终态后主动 close):重连一次读最终状态即可自愈
          scheduleReconnect();
        }
      });
    });
  }

  open();

  return {
    close() {
      closedByClient = true;
      if (retryTimer) clearTimeout(retryTimer);
      closeSource();
    },
  };
}
