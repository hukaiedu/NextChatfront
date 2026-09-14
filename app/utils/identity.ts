import { useAuthStore } from "../store/auth";
import { useChatStore } from "../store/chat";

/**
 * V1.4 U4 §20/§43/§44:真正换主体时的统一收尾。
 *
 * 三步缺一不可:
 * 1. 清本地身份(closeAllStreams + identityEpoch++);
 * 2. 清聊天视图(resetForIdentity,只清不发);
 * 3. 整页换文档 —— 未提交输入、消息缓存、组件内 state 只能靠换文档彻底消失。
 *
 * 为什么在组件层而不是 auth store 里:store/auth 不得依赖 chat store
 * (test/v13c-auth.test.ts AUTH-GUARD-01 是静态守卫),编排天然是页面的事。
 */
export function leaveIdentityAndReload(path = "/"): void {
  const auth = useAuthStore.getState();
  // logout / revoke-all 的 action 已经清过一次;这里兜住「外部身份进来」的登录路径
  if (auth.status !== "unknown") auth.clearIdentity();
  useChatStore.getState().resetForIdentity();
  window.location.replace(path);
}
