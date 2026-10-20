"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import ReloadIcon from "../icons/reload.svg";
import {
  AdminProviderState,
  AdminProviderStatus,
  PROVIDER_STATUS_POLL_INTERVAL_MS,
  checkAdminProvider,
  getAdminProviderStatus,
  restartAdminProvider,
  revokeAllAdminSessions,
} from "../client/admin-api";
import {
  AuthSessionInfo,
  BackendApiError,
  getAuthSession,
} from "../client/backend-api";
import { useAuthStore } from "../store/auth";
import { IconButton } from "../components/button";
import { List, ListItem, showConfirm, showToast } from "../components/ui-lib";
import Locale from "../locales";
import styles from "./admin.module.scss";

/**
 * V1.3-C §20/§21:管理控制台。
 *
 * 守卫只做 GET /auth/session 探测(§46 真相来自后端),不走匿名 bootstrap(§17):
 * 打开 /admin 不该顺带建一个访客身份。非 ADMIN 一律回 /admin/login。
 */
function AdminConsolePage() {
  const router = useRouter();
  const clearIdentity = useAuthStore((state) => state.clearIdentity);
  const logout = useAuthStore((state) => state.logout);
  const authStatus = useAuthStore((state) => state.status);
  const authUserType = useAuthStore((state) => state.userType);
  const [identity, setIdentity] = useState<AuthSessionInfo | null>(null);
  const [busy, setBusy] = useState<"revoke" | "logout" | null>(null);

  const pageAlive = useRef(true);
  const pageLifecycle = useRef(0);
  const reprobeInFlight = useRef(false);
  const reprobeGeneration = useRef(0);
  const leftConsole = useRef(false);
  const actionConfirm = useRef<number | null>(null);
  const actionConfirmSeq = useRef(0);
  const storeObservedAdmin = useRef(false);

  useEffect(() => {
    pageLifecycle.current += 1;
    pageAlive.current = true;
    actionConfirm.current = null;
    return () => {
      pageAlive.current = false;
    };
  }, []);

  const convergeToLogin = useCallback(() => {
    if (leftConsole.current) return;
    leftConsole.current = true;
    setIdentity(null);
    // The global 401 handler may already have cleared the store.
    if (useAuthStore.getState().status === "authenticated") clearIdentity();
    router.replace("/admin/login");
  }, [clearIdentity, router]);

  useEffect(() => {
    let alive = true;
    void getAuthSession()
      .then((session) => {
        if (!alive) return;
        if (session.authenticated && session.userType === "ADMIN") {
          setIdentity(session);
        } else {
          convergeToLogin();
        }
      })
      .catch(() => {
        if (alive) convergeToLogin();
      });
    return () => {
      alive = false;
    };
  }, [convergeToLogin]);

  // The store is authoritative for the rest of the app. Once it has observed
  // an ADMIN identity, any later non-ADMIN state must close this console
  // immediately, even if the 15s provider poll has not fired yet.
  useEffect(() => {
    if (authStatus === "authenticated" && authUserType === "ADMIN") {
      storeObservedAdmin.current = true;
      return;
    }
    if (!identity || !storeObservedAdmin.current) return;
    convergeToLogin();
  }, [authStatus, authUserType, identity, convergeToLogin]);

  /**
   * FIX-02B:Cookie 在全 Tab 间共享,另一个 Tab 的 logout / revoke-all 会让本 Tab
   * 的管理员身份失效。页面重新活跃时轻量复核一次 —— 不轮询、不建匿名身份。
   * Unmount invalidates the in-flight probe so it cannot clear identity or
   * navigate after the console is gone; the generation also protects
   * StrictMode double effects.
   */
  useEffect(() => {
    let alive = true;
    const reprobe = () => {
      if (document.visibilityState !== "visible") return;
      if (reprobeInFlight.current || leftConsole.current) return;
      reprobeInFlight.current = true;
      const generation = ++reprobeGeneration.current;
      void getAuthSession()
        .then((session) => {
          if (
            !alive ||
            generation !== reprobeGeneration.current ||
            leftConsole.current
          ) {
            return;
          }
          if (session.authenticated && session.userType === "ADMIN") {
            setIdentity(session);
            return;
          }
          convergeToLogin();
        })
        .catch(() => {
          // 网络抖动不把管理员踢出:下次再活跃时重新复核
        })
        .finally(() => {
          if (alive && generation === reprobeGeneration.current) {
            reprobeInFlight.current = false;
          }
        });
    };
    document.addEventListener("visibilitychange", reprobe);
    window.addEventListener("focus", reprobe);
    return () => {
      alive = false;
      reprobeGeneration.current += 1;
      reprobeInFlight.current = false;
      document.removeEventListener("visibilitychange", reprobe);
      window.removeEventListener("focus", reprobe);
    };
  }, [convergeToLogin]);

  const onRevokeAll = async () => {
    if (busy || actionConfirm.current !== null) return;
    const lifecycle = pageLifecycle.current;
    const confirmId = ++actionConfirmSeq.current;
    actionConfirm.current = confirmId;
    let confirmed = false;
    try {
      confirmed = await showConfirm(
        Locale.AdminConsole.Sessions.RevokeAllConfirm,
      );
    } catch {
      return;
    } finally {
      if (actionConfirm.current === confirmId) actionConfirm.current = null;
    }
    if (
      !confirmed ||
      leftConsole.current ||
      !pageAlive.current ||
      pageLifecycle.current !== lifecycle
    ) {
      return;
    }
    setBusy("revoke");
    try {
      const { revoked } = await revokeAllAdminSessions();
      if (!pageAlive.current || pageLifecycle.current !== lifecycle) return;
      // 后端删库成功即已清 Cookie:清本地身份但不重新引导(§42)
      clearIdentity();
      setIdentity(null);
      showToast(Locale.AdminConsole.Sessions.RevokeAllSuccess(revoked));
      router.replace("/admin/login");
    } catch (error) {
      if (!pageAlive.current || pageLifecycle.current !== lifecycle) return;
      console.error("[Admin] 吊销全部登录状态失败", error);
      if (isSessionLostError(error)) {
        // Session 其实已经失效/降权:同样按已登出收口,不再重试
        clearIdentity();
        setIdentity(null);
        router.replace("/admin/login");
        return;
      }
      showToast(Locale.AdminConsole.Sessions.RevokeAllFailed);
      setBusy(null);
    }
  };

  const onLogout = async () => {
    if (busy || actionConfirm.current !== null) return;
    const lifecycle = pageLifecycle.current;
    const confirmId = ++actionConfirmSeq.current;
    actionConfirm.current = confirmId;
    let confirmed = false;
    try {
      confirmed = await showConfirm(Locale.AdminConsole.Logout.Confirm);
    } catch {
      return;
    } finally {
      if (actionConfirm.current === confirmId) actionConfirm.current = null;
    }
    if (
      !confirmed ||
      leftConsole.current ||
      !pageAlive.current ||
      pageLifecycle.current !== lifecycle
    ) {
      return;
    }
    setBusy("logout");
    if (await logout()) {
      if (!pageAlive.current || pageLifecycle.current !== lifecycle) return;
      setIdentity(null);
      router.replace("/admin/login");
      return;
    }
    if (!pageAlive.current || pageLifecycle.current !== lifecycle) return;
    showToast(Locale.AdminConsole.Logout.Failed);
    setBusy(null);
  };

  if (!identity) {
    return <div className={styles.console} aria-busy="true" />;
  }

  const userType = identity.userType ?? "ANONYMOUS";

  return (
    <div className={styles.console}>
      <div className={styles.inner}>
        <div className={styles.header}>
          <div className={styles.title}>{Locale.AdminConsole.Title}</div>
          <IconButton
            aria={Locale.AdminConsole.BackToChat}
            text={Locale.AdminConsole.BackToChat}
            bordered
            onClick={() => router.push("/")}
          />
        </div>
        <div className={styles.sections}>
          <List>
            <ListItem title={Locale.AdminConsole.Session.Title}>
              <div className={styles.value}>
                {Locale.AdminConsole.Session.UserType[userType]}
              </div>
            </ListItem>
            <ListItem title={Locale.AdminConsole.Session.ExpiresAt}>
              <div className={styles.value}>
                {identity.expiresAt
                  ? new Date(identity.expiresAt).toLocaleString()
                  : Locale.AdminConsole.Provider.Empty}
              </div>
            </ListItem>
          </List>

          <AdminProviderSection onSessionLost={convergeToLogin} />

          <List>
            <ListItem
              title={Locale.AdminConsole.Sessions.RevokeAll}
              subTitle={Locale.AdminConsole.Sessions.RevokeAllTip}
            >
              <div className={styles.actions}>
                <IconButton
                  aria={Locale.AdminConsole.Sessions.RevokeAll}
                  text={Locale.AdminConsole.Sessions.RevokeAll}
                  bordered
                  type="danger"
                  disabled={busy !== null}
                  onClick={onRevokeAll}
                />
              </div>
            </ListItem>
            <ListItem
              title={Locale.AdminConsole.Logout.Title}
              subTitle={Locale.AdminConsole.Logout.Tip}
            >
              <div className={styles.actions}>
                <IconButton
                  aria={Locale.AdminConsole.Logout.Title}
                  text={Locale.AdminConsole.Logout.Title}
                  bordered
                  disabled={busy !== null}
                  onClick={onLogout}
                />
              </div>
            </ListItem>
          </List>
        </div>
      </div>
    </div>
  );
}

const PROVIDER_STATE_LABEL: Record<AdminProviderState, string> = {
  READY: Locale.AdminConsole.Provider.State.READY,
  BUSY: Locale.AdminConsole.Provider.State.BUSY,
  LOGIN_REQUIRED: Locale.AdminConsole.Provider.State.LOGIN_REQUIRED,
};

/** Admin 面显示后端公开错误码(§36):运维需要的是拒绝原因,不是 Public 的通用文案 */
function providerErrorText(
  error: unknown,
  action: "load" | "check" | "restart",
): string {
  if (!(error instanceof BackendApiError)) {
    return Locale.AdminConsole.Provider.NetworkFailed;
  }
  if (action === "restart") {
    // 409:已有重启或活动请求;只提示稍后重试,不做任何自动重试
    if (
      error.code === "PROVIDER_RESTART_CONFLICT" ||
      error.status === 409
    ) {
      return Locale.AdminConsole.Provider.RestartConflict;
    }
    // 504 只表示 HTTP 等待超时,后台可能仍在重启;不得提示“已停止”
    if (error.code === "PROVIDER_RESTART_TIMEOUT" || error.status === 504) {
      return Locale.AdminConsole.Provider.RestartTimeout;
    }
    return Locale.AdminConsole.Provider.RestartFailed(error.code);
  }
  if (action === "check") {
    return Locale.AdminConsole.Provider.CheckFailed(error.code);
  }
  return Locale.AdminConsole.Provider.ActionFailed(error.code);
}

function providerAuthCheckText(status: AdminProviderStatus | null): string {
  const result = status?.authCheck?.result ?? "NOT_CHECKED";
  return Locale.AdminConsole.Provider.CheckResult[result];
}

function needsCredentialImport(status: AdminProviderStatus | null): boolean {
  return (
    status?.status === "LOGIN_REQUIRED" ||
    status?.authCheck?.result === "LOGIN_REQUIRED" ||
    status?.authCheck?.failureCode === "PROVIDER_LOGIN_REQUIRED"
  );
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === "AbortError"
  );
}

function isSessionLostError(error: unknown): boolean {
  return (
    error instanceof BackendApiError &&
    (error.status === 401 ||
      (error.status === 403 && error.code === "AUTH_FORBIDDEN"))
  );
}

/**
 * Provider 运维面板:状态 + 检查连接/凭据 + 重启 Python Worker。
 * 只调用 canonical /admin/provider/*;浏览器运行时相关入口已随本轮退役。
 */
function AdminProviderSection({
  onSessionLost,
}: {
  onSessionLost: () => void;
}) {
  const [status, setStatus] = useState<AdminProviderStatus | null>(null);
  const [busy, setBusy] = useState<"load" | "check" | "restart" | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const lifecycleRef = useRef(0);
  const restartConfirmRef = useRef<number | null>(null);
  const restartConfirmSeqRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (silent: boolean) => {
      if (busyRef.current) return;
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      try {
        const next = await getAdminProviderStatus(controller.signal);
        // A superseded/aborted request must not overwrite a newer state.
        if (!mountedRef.current || requestRef.current !== controller) return;
        setStatus(next);
      } catch (error) {
        if (!mountedRef.current || isAbortError(error)) return;
        if (requestRef.current !== controller) return;
        if (isSessionLostError(error)) {
          onSessionLost();
          return;
        }
        if (!silent) showToast(providerErrorText(error, "load"));
      } finally {
        if (requestRef.current === controller) requestRef.current = null;
      }
    },
    [onSessionLost],
  );

  const run = useCallback(
    async (
      action: "load" | "check" | "restart",
      call: (signal: AbortSignal) => Promise<AdminProviderStatus>,
    ) => {
      if (!mountedRef.current || busyRef.current) return;
      busyRef.current = true;
      setBusy(action);
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      let reloadAfter = false;
      try {
        const next = await call(controller.signal);
        if (!mountedRef.current || requestRef.current !== controller) return;
        // 重启响应不含 authCheck:旧检查结果已随 Worker 重启失效
        setStatus(
          action === "restart" ? { ...next, authCheck: undefined } : next,
        );
        if (action === "restart") {
          showToast(Locale.AdminConsole.Provider.RestartSuccess);
        }
      } catch (error) {
        if (!mountedRef.current || isAbortError(error)) return;
        if (requestRef.current !== controller) return;
        if (isSessionLostError(error)) {
          onSessionLost();
          return;
        }
        showToast(providerErrorText(error, action));
        // 409/504 后只回读一次状态;绝不自动重试重启
        reloadAfter = action === "restart";
      } finally {
        if (requestRef.current === controller) {
          requestRef.current = null;
          if (mountedRef.current) {
            busyRef.current = false;
            setBusy(null);
          }
        }
      }
      if (reloadAfter && mountedRef.current && requestRef.current === null) {
        void load(true);
      }
    },
    [load, onSessionLost],
  );

  useEffect(() => {
    // 每次 setup 生成新的生命周期标识:StrictMode 重放后旧异步确认自动失效
    lifecycleRef.current += 1;
    mountedRef.current = true;
    restartConfirmRef.current = null;
    void load(true);
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      if (busyRef.current) return;
      void load(true);
    }, PROVIDER_STATUS_POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      restartConfirmRef.current = null;
      clearInterval(timer);
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [load]);

  const onRestart = async () => {
    if (
      !mountedRef.current ||
      busyRef.current ||
      restartConfirmRef.current !== null
    ) {
      return;
    }
    const lifecycle = lifecycleRef.current;
    const confirmId = restartConfirmSeqRef.current + 1;
    restartConfirmSeqRef.current = confirmId;
    restartConfirmRef.current = confirmId;
    let confirmed = false;
    try {
      confirmed = await showConfirm(
        Locale.AdminConsole.Provider.RestartConfirm,
      );
    } finally {
      // 只释放本次确认的占位;取消/关闭后允许重新操作
      if (restartConfirmRef.current === confirmId) {
        restartConfirmRef.current = null;
      }
    }
    if (!confirmed) return;
    // 页面已卸载或生命周期已重放:旧确认结果一律失效
    if (!mountedRef.current || lifecycleRef.current !== lifecycle) return;
    await run("restart", restartAdminProvider);
  };

  const credentialRequired = needsCredentialImport(status);

  return (
    <List>
      <ListItem
        title={Locale.AdminConsole.Provider.Title}
        subTitle={Locale.AdminConsole.Provider.SubTitle}
      >
        <div className={styles.value}>
          {status
            ? PROVIDER_STATE_LABEL[status.status]
            : Locale.AdminConsole.Provider.Unknown}
        </div>
      </ListItem>
      <ListItem
        className={styles.providerRow}
        title={Locale.AdminConsole.Provider.Check}
        subTitle={Locale.AdminConsole.Provider.CheckTip}
      >
        <div className={styles.diagnostic}>
          <div role="status" aria-live="polite" className={styles.value}>
            {providerAuthCheckText(status)}
          </div>
          {status?.authCheck?.checkedAt && (
            <div className={styles.value}>
              {status.authCheck.modelCount !== null
                ? Locale.AdminConsole.Provider.CheckDetails(
                    status.authCheck.modelCount,
                    new Date(status.authCheck.checkedAt).toLocaleString(),
                  )
                : Locale.AdminConsole.Provider.CheckTime(
                    new Date(status.authCheck.checkedAt).toLocaleString(),
                  )}
            </div>
          )}
          {status?.authCheck?.failureCode && (
            <div className={styles.value}>
              {Locale.AdminConsole.Provider.CheckFailureCode(
                status.authCheck.failureCode,
              )}
            </div>
          )}
          <IconButton
            aria={Locale.AdminConsole.Provider.Check}
            text={Locale.AdminConsole.Provider.Check}
            bordered
            disabled={busy !== null}
            onClick={() => void run("check", checkAdminProvider)}
          />
        </div>
      </ListItem>
      {credentialRequired && (
        <ListItem
          className={styles.providerRow}
          title={Locale.AdminConsole.Provider.CredentialTitle}
          subTitle={Locale.AdminConsole.Provider.CredentialTip}
        >
          <code className={styles.command}>
            {Locale.AdminConsole.Provider.CredentialCommand}
          </code>
        </ListItem>
      )}
      <ListItem
        className={styles.providerRow}
        title={Locale.AdminConsole.Provider.Actions}
        subTitle={Locale.AdminConsole.Provider.ActionsTip}
      >
        <div className={styles.actions}>
          <IconButton
            aria={Locale.AdminConsole.Provider.Refresh}
            icon={<ReloadIcon />}
            bordered
            disabled={busy !== null}
            title={Locale.AdminConsole.Provider.Refresh}
            onClick={() => void run("load", getAdminProviderStatus)}
          />
          <IconButton
            aria={Locale.AdminConsole.Provider.Restart}
            text={Locale.AdminConsole.Provider.Restart}
            type="danger"
            bordered
            disabled={busy !== null}
            onClick={() => void onRestart()}
          />
        </div>
      </ListItem>
    </List>
  );
}

export default AdminConsolePage;
