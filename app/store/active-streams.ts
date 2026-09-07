import type { RequestEventSubscription } from "../client/backend-api";

/**
 * 活跃 SSE 订阅注册表(按会话 id 索引)。
 * 独立成轻量模块:auth 登出/全局 401 关流只依赖这里,
 * 不反向依赖完整 ChatStore(避免 store ↔ store 初始化耦合)。
 */
const streams = new Map<string, RequestEventSubscription>();

export function trackStream(
  conversationId: string,
  subscription: RequestEventSubscription,
): void {
  streams.set(conversationId, subscription);
}

/** 订阅自然结束后的登记清理(不 close,流已终结) */
export function forgetStream(conversationId: string): void {
  streams.delete(conversationId);
}

export function closeStream(conversationId: string): void {
  streams.get(conversationId)?.close();
  streams.delete(conversationId);
}

/** §8.1-B:登出/全局 401 关闭全部活跃 SSE;后端 Request 不取消 */
export function closeAllStreams(): void {
  streams.forEach((subscription) => subscription.close());
  streams.clear();
}

export function activeStreamCount(): number {
  return streams.size;
}
