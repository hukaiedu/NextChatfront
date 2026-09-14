"use client";

import { ReactNode, useEffect, useRef } from "react";

import { AuthStatus, AuthUserType, useAuthStore } from "../store/auth";
import { useChatStore } from "../store/chat";
import Locale from "../locales";
import styles from "./auth-gate.module.scss";

/**
 * V1.3-C §5/§6:会话引导门(取代 V1.2 的密码门)。
 *
 * 普通用户打开 `/` 不再看到任何密码表单:探测 session,没有有效身份就自动
 * 创建匿名身份,然后直接进入聊天(§5)。
 *
 * - unknown / bootstrapping → 占位(避免白屏与旧密码框闪一下)
 * - authenticated           → 透传 children
 * - blocked                 → DISABLED 等确定性拒绝;中性提示 + 手动 Retry(§10)
 * - error                   → 网络/5xx;提示 + 手动 Retry(§11)
 *
 * 同时承担 §45 的多标签页身份刷新:tab 重新可见时轻量探测一次 session。
 */
export function AuthGate(props: { children?: ReactNode }) {
  const status = useAuthStore((state) => state.status);
  const bootstrap = useAuthStore((state) => state.bootstrap);
  const retryBootstrap = useAuthStore((state) => state.retryBootstrap);
  const refreshIdentity = useAuthStore((state) => state.refreshIdentity);

  useEffect(() => {
    // single-flight 在 store 内保证:StrictMode 双 effect 不会发两次 anonymous(§12/§13)
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        refreshIdentity();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refreshIdentity]);

  /**
   * §45/§46 FIX-02:身份边界。Cookie 在全 Tab 间共享,所以本 Tab 的内存身份可能
   * 已被另一个 Tab 换掉(ANONYMOUS ↔ ADMIN)、或整个 Session 已被吊销。
   * 光比 userType 不够:新旧匿名身份 userType 相同,且 React 会把「失效 → 重建」
   * 合并成一次渲染 —— 所以要连 identityEpoch 一起比。
   */
  const identityEpoch = useAuthStore((state) => state.identityEpoch);
  const userType = useAuthStore((state) => state.userType);
  const seenIdentity = useRef<{
    status: AuthStatus;
    userType: AuthUserType | null;
    epoch: number;
  } | null>(null);
  useEffect(() => {
    const previous = seenIdentity.current;
    seenIdentity.current = { status, userType, epoch: identityEpoch };
    // 首次登记(含 StrictMode 重挂)不动作:此刻 store 里的数据就属于当前身份
    if (!previous) return;

    const lost =
      previous.status === "authenticated" && status !== "authenticated";
    // 身份被就地换掉:children 一直挂着,没人会重新触发 bootstrap
    const swapped =
      previous.status === "authenticated" &&
      status === "authenticated" &&
      (previous.userType !== userType || previous.epoch !== identityEpoch);
    if (!lost && !swapped) return;

    /**
     * §47:唯一的例外是「本 Tab 自己刚刚注册成功」—— User.id 没变,聊天还是那一屏数据,
     * 重置反而把用户正在看的会话抹掉。标记必须在这里一次性消费掉(§18),
     * 于是旁观 Tab 的 ANONYMOUS→REGISTERED(§48)、登录他人、被顶号仍走下面的重置。
     */
    const flagged = useAuthStore.getState().consumeSameSubjectTransition();
    if (
      flagged &&
      previous.userType === "ANONYMOUS" &&
      userType === "REGISTERED"
    ) {
      return;
    }

    useChatStore.getState().resetForIdentity();
    // lost 时 children 已卸载,回来的那次挂载由 useLoadData 拉 —— 不在此处重复请求
    if (swapped) void useChatStore.getState().bootstrap();
  }, [status, userType, identityEpoch]);

  if (status === "authenticated") {
    return <>{props.children}</>;
  }

  if (status === "blocked" || status === "error") {
    return (
      <div className={styles["auth-gate"]}>
        <div className={styles["form"]} role="alert">
          <div className={styles["title"]}>
            {status === "blocked"
              ? Locale.Bootstrap.Blocked
              : Locale.Bootstrap.Error}
          </div>
          <button
            className={styles["submit"]}
            type="button"
            onClick={retryBootstrap}
          >
            {Locale.Bootstrap.Retry}
          </button>
        </div>
      </div>
    );
  }

  // unknown / bootstrapping
  return (
    <div className={styles["auth-gate"]} aria-busy="true">
      <div className={styles["title"]}>{Locale.Bootstrap.Loading}</div>
    </div>
  );
}
