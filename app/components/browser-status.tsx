import { useEffect } from "react";
import clsx from "clsx";
import styles from "./browser-status.module.scss";

import ReloadIcon from "../icons/reload.svg";
import Locale from "../locales";
import { AdminBrowserState, AdminBrowserStatus } from "../client/admin-api";
import {
  isUnsupportedBrowserApi,
  retainBrowserStatusPolling,
  useBrowserStore,
} from "../store/browser";
import { IconButton } from "./button";
import { List, ListItem, showConfirm, showToast } from "./ui-lib";

/**
 * V1.3-C §40/§41:服务端浏览器运维面板。原「Public 设置页 / 聊天头部」入口已移除,
 * 本组件只允许被 /admin 控制台挂载 —— 快照含 profileDir / providerLoggedIn 等运维字段。
 */

const STATE_LABEL: Record<AdminBrowserState, string> = {
  RUNNING: Locale.Browser.State.RUNNING,
  STARTING: Locale.Browser.State.STARTING,
  RESTARTING: Locale.Browser.State.RESTARTING,
  STOPPED: Locale.Browser.State.STOPPED,
  FAILED: Locale.Browser.State.FAILED,
};

const STATE_HINT: Record<AdminBrowserState, string> = {
  RUNNING: Locale.Browser.Hint.RUNNING,
  STARTING: Locale.Browser.Hint.STARTING,
  RESTARTING: Locale.Browser.Hint.RESTARTING,
  STOPPED: Locale.Browser.Hint.STOPPED,
  FAILED: Locale.Browser.Hint.FAILED,
};

const DOT_CLASS: Record<AdminBrowserState, string> = {
  RUNNING: styles["dot-running"],
  STARTING: styles["dot-busy"],
  RESTARTING: styles["dot-busy"],
  STOPPED: styles["dot-off"],
  FAILED: styles["dot-error"],
};

const UNKNOWN = Locale.Browser.Empty;

export function browserStateView(status: AdminBrowserStatus | null) {
  return {
    label: status ? STATE_LABEL[status.state] : Locale.Browser.State.UNKNOWN,
    hint: status ? STATE_HINT[status.state] : Locale.Browser.Hint.UNKNOWN,
    dotClass: status ? DOT_CLASS[status.state] : styles["dot-unknown"],
  };
}

function formatDateTime(iso?: string | null): string {
  if (!iso) return UNKNOWN;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return UNKNOWN;
  return date.toLocaleString();
}

function formatClock(ms: number | null): string {
  if (ms == null) return UNKNOWN;
  return new Date(ms).toLocaleTimeString();
}

/** 优先用后端给的 uptimeMs,没有才用 startedAt 与本地时间推算 */
export function formatUptime(
  uptimeMs?: number | null,
  startedAt?: string | null,
): string {
  let value = uptimeMs;
  if (value == null && startedAt) {
    const started = new Date(startedAt).getTime();
    value = Number.isNaN(started) ? null : Date.now() - started;
  }
  if (value == null || Number.isNaN(value) || value < 0) return UNKNOWN;

  const totalSeconds = Math.floor(value / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatLoggedIn(loggedIn?: boolean | null): string {
  if (loggedIn === true) return Locale.Browser.LoggedIn.Yes;
  if (loggedIn === false) return Locale.Browser.LoggedIn.No;
  return Locale.Browser.LoggedIn.Unknown;
}

function formatBrowserType(status: AdminBrowserStatus | null): string {
  if (!status?.browserType) return UNKNOWN;
  if (status.headless == null) return status.browserType;
  return `${status.browserType} · ${
    status.headless ? Locale.Browser.Headless.Yes : Locale.Browser.Headless.No
  }`;
}

function formatLastError(status: AdminBrowserStatus | null): string {
  const error = status?.lastError;
  if (!error) return UNKNOWN;
  const detail = error.message ? `: ${error.message}` : "";
  return `${error.code}${detail}`;
}

export function browserStatusRows(
  status: AdminBrowserStatus | null,
  fetchedAt: number | null,
) {
  return [
    {
      label: Locale.Browser.Fields.StartedAt,
      value: formatDateTime(status?.startedAt),
    },
    {
      label: Locale.Browser.Fields.Uptime,
      value: formatUptime(status?.uptimeMs, status?.startedAt),
    },
    {
      label: Locale.Browser.Fields.BrowserType,
      value: formatBrowserType(status),
    },
    {
      label: Locale.Browser.Fields.Profile,
      value: status?.profileDir ?? UNKNOWN,
    },
    {
      label: Locale.Browser.Fields.LoggedIn,
      value: formatLoggedIn(status?.providerLoggedIn),
    },
    {
      label: Locale.Browser.Fields.ActiveRequests,
      value:
        status?.activeRequests == null
          ? UNKNOWN
          : String(status.activeRequests),
    },
    {
      label: Locale.Browser.Fields.LastError,
      value: formatLastError(status),
    },
    {
      label: Locale.Browser.Fields.RefreshedAt,
      value: formatClock(fetchedAt),
    },
  ];
}

/**
 * 浏览器状态失败提示:HTTP 404 说明后端还没有这个接口,与「后端连不上」区分开。
 * 这是 Admin 面:允许显示后端原始错误码(§36 Admin surface 不受 Public 映射限制)。
 */
export function browserErrorText(
  code: string | null,
  httpStatus: number | null,
): string | null {
  if (!code) return null;
  if (isUnsupportedBrowserApi(code, httpStatus)) {
    return Locale.Browser.Unsupported;
  }
  return `${Locale.Browser.FetchFailed} · ${code}`;
}

function useBrowserStatusPanel() {
  const {
    status,
    fetchState,
    fetchErrorCode,
    fetchErrorStatus,
    restarting,
    fetchedAt,
  } = useBrowserStore();

  useEffect(() => {
    void useBrowserStore.getState().refresh();
    return retainBrowserStatusPolling();
  }, []);

  const restart = async () => {
    if (restarting) return;
    if (!(await showConfirm(Locale.Browser.RestartConfirm))) return;
    const result = await useBrowserStore.getState().restart();
    if (result.ok) {
      showToast(Locale.Browser.RestartSuccess);
    } else if (result.errorText) {
      showToast(result.errorText);
    }
  };

  const refresh = () => void useBrowserStore.getState().refresh(true);

  return {
    status,
    fetchState,
    restarting,
    fetchedAt,
    errorText: browserErrorText(fetchErrorCode, fetchErrorStatus),
    restart,
    refresh,
  };
}

/** /admin:完整浏览器运维面板(状态 + 明细 + 刷新/重启) */
export function AdminBrowserPanel() {
  const {
    status,
    fetchState,
    restarting,
    fetchedAt,
    errorText,
    restart,
    refresh,
  } = useBrowserStatusPanel();
  const view = browserStateView(status);
  const rows = browserStatusRows(status, fetchedAt);
  const subTitle = errorText ?? Locale.Browser.SubTitle;

  return (
    <List>
      <ListItem title={Locale.Browser.Title} subTitle={subTitle}>
        <div className={styles["state-badge"]}>
          <span className={clsx(styles.dot, view.dotClass)} />
          <span>{view.label}</span>
        </div>
      </ListItem>

      {rows.map((row) => (
        <ListItem key={row.label} title={row.label}>
          <div className={styles["state-value"]} title={row.value}>
            {row.value}
          </div>
        </ListItem>
      ))}

      <ListItem
        title={Locale.Browser.Actions.Restart}
        subTitle={Locale.Browser.RestartTip}
      >
        <div className={styles["actions"]}>
          <IconButton
            aria={Locale.Browser.Actions.Refresh}
            icon={<ReloadIcon />}
            bordered
            disabled={fetchState === "loading"}
            title={Locale.Browser.Actions.Refresh}
            onClick={refresh}
          />
          <IconButton
            aria={Locale.Browser.Actions.Restart}
            text={Locale.Browser.Actions.Restart}
            bordered
            disabled={restarting}
            onClick={restart}
          />
        </div>
      </ListItem>
    </List>
  );
}
