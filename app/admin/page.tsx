"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import ReloadIcon from "../icons/reload.svg";
import {
  AdminProviderState,
  AdminProviderStatus,
  getAdminProviderStatus,
  openAdminProvider,
  restartAdminProvider,
  revokeAllAdminSessions,
} from "../client/admin-api";
import {
  AuthSessionInfo,
  BackendApiError,
  getAuthSession,
} from "../client/backend-api";
import { useAuthStore } from "../store/auth";
import { AdminBrowserPanel } from "../components/browser-status";
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
  const [identity, setIdentity] = useState<AuthSessionInfo | null>(null);
  const [busy, setBusy] = useState<"revoke" | "logout" | null>(null);

  useEffect(() => {
    let alive = true;
    void getAuthSession()
      .then((session) => {
        if (!alive) return;
        if (session.authenticated && session.userType === "ADMIN") {
          setIdentity(session);
        } else {
          router.replace("/admin/login");
        }
      })
      .catch(() => {
        if (alive) router.replace("/admin/login");
      });
    return () => {
      alive = false;
    };
  }, [router]);

  /**
   * FIX-02B:Cookie 在全 Tab 间共享,另一个 Tab 的 logout / revoke-all 会让本 Tab
   * 的管理员身份失效。页面重新活跃时轻量复核一次 —— 不轮询、不建匿名身份。
   */
  const reprobeInFlight = useRef(false);
  const leftConsole = useRef(false);
  useEffect(() => {
    const reprobe = () => {
      if (document.visibilityState !== "visible") return;
      if (reprobeInFlight.current || leftConsole.current) return;
      reprobeInFlight.current = true;
      void getAuthSession()
        .then((session) => {
          if (session.authenticated && session.userType === "ADMIN") {
            setIdentity(session);
            return;
          }
          leftConsole.current = true;
          // 身份已不属于管理员:清本地身份,回登录页,绝不自动建匿名身份(§9)
          clearIdentity();
          router.replace("/admin/login");
        })
        .catch(() => {
          // 网络抖动不把管理员踢出:下次再活跃时重新复核
        })
        .finally(() => {
          reprobeInFlight.current = false;
        });
    };
    document.addEventListener("visibilitychange", reprobe);
    window.addEventListener("focus", reprobe);
    return () => {
      document.removeEventListener("visibilitychange", reprobe);
      window.removeEventListener("focus", reprobe);
    };
  }, [clearIdentity, router]);

  const onRevokeAll = async () => {
    if (busy) return;
    if (!(await showConfirm(Locale.AdminConsole.Sessions.RevokeAllConfirm))) {
      return;
    }
    setBusy("revoke");
    try {
      const { revoked } = await revokeAllAdminSessions();
      // 后端删库成功即已清 Cookie:清本地身份但不重新引导(§42)
      clearIdentity();
      showToast(Locale.AdminConsole.Sessions.RevokeAllSuccess(revoked));
      router.replace("/admin/login");
    } catch (error) {
      console.error("[Admin] 吊销全部登录状态失败", error);
      if (error instanceof BackendApiError && error.status === 401) {
        // Session 其实已经失效:同样按已登出收口,不再重试
        clearIdentity();
        router.replace("/admin/login");
        return;
      }
      showToast(Locale.AdminConsole.Sessions.RevokeAllFailed);
      setBusy(null);
    }
  };

  const onLogout = async () => {
    if (busy) return;
    if (!(await showConfirm(Locale.AdminConsole.Logout.Confirm))) return;
    setBusy("logout");
    if (await logout()) {
      router.replace("/admin/login");
      return;
    }
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
                  : Locale.Browser.Empty}
              </div>
            </ListItem>
          </List>

          <AdminBrowserPanel />

          <AdminProviderSection />

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
  STOPPED: Locale.AdminConsole.Provider.State.STOPPED,
  STARTING: Locale.AdminConsole.Provider.State.STARTING,
  LOGIN_REQUIRED: Locale.AdminConsole.Provider.State.LOGIN_REQUIRED,
  READY: Locale.AdminConsole.Provider.State.READY,
  BUSY: Locale.AdminConsole.Provider.State.BUSY,
  ERROR: Locale.AdminConsole.Provider.State.ERROR,
};

/** Admin 面显示后端原始错误码(§36):运维需要的是拒绝原因,不是 Public 的通用文案 */
function providerErrorText(error: unknown): string {
  return error instanceof BackendApiError
    ? `${error.code}: ${error.message}`
    : String(error);
}

/**
 * Provider 运维面板:状态 + 打开 + 重启(canonical /admin/provider/*)。
 * 状态是服务端事实,进面板读一次,操作后直接用后端返回值刷新,不额外轮询
 * (浏览器面板已有自己的轮询,两个面板不叠两份定时器)。
 */
function AdminProviderSection() {
  const [status, setStatus] = useState<AdminProviderStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    let alive = true;
    void getAdminProviderStatus()
      .then((next) => {
        if (alive) setStatus(next);
      })
      .catch((error) => {
        if (alive) showToast(providerErrorText(error));
      });
    return () => {
      alive = false;
    };
  }, []);

  const run = async (
    call: () => Promise<AdminProviderStatus>,
    successText?: string,
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      setStatus(await call());
      if (successText) showToast(successText);
    } catch (error) {
      console.error("[Admin] Provider 操作失败", error);
      showToast(providerErrorText(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const onRestart = async () => {
    if (!(await showConfirm(Locale.AdminConsole.Provider.RestartConfirm))) {
      return;
    }
    await run(
      restartAdminProvider,
      Locale.AdminConsole.Provider.RestartSuccess,
    );
  };

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
        title={Locale.AdminConsole.Provider.Actions}
        subTitle={Locale.AdminConsole.Provider.ActionsTip}
      >
        <div className={styles.actions}>
          <IconButton
            aria={Locale.Browser.Actions.Refresh}
            icon={<ReloadIcon />}
            bordered
            disabled={busy}
            title={Locale.Browser.Actions.Refresh}
            onClick={() => void run(getAdminProviderStatus)}
          />
          <IconButton
            aria={Locale.AdminConsole.Provider.Open}
            text={Locale.AdminConsole.Provider.Open}
            bordered
            disabled={busy}
            onClick={() =>
              void run(
                openAdminProvider,
                Locale.AdminConsole.Provider.OpenSuccess,
              )
            }
          />
          <IconButton
            aria={Locale.AdminConsole.Provider.Restart}
            text={Locale.AdminConsole.Provider.Restart}
            type="danger"
            bordered
            disabled={busy}
            onClick={() => void onRestart()}
          />
        </div>
      </ListItem>
    </List>
  );
}

export default AdminConsolePage;
