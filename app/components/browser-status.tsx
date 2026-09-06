import { useEffect, useState } from "react";
import clsx from "clsx";
import styles from "./browser-status.module.scss";

import ReloadIcon from "../icons/reload.svg";
import Locale from "../locales";
import {
  BackendBrowserState,
  BackendBrowserStatus,
} from "../client/backend-api";
import {
  isUnsupportedBrowserApi,
  retainBrowserStatusPolling,
  useBrowserStore,
} from "../store/browser";
import { errorTextForCode } from "../store/chat";
import { IconButton } from "./button";
import { List, ListItem, Popover, showConfirm, showToast } from "./ui-lib";

const STATE_LABEL: Record<BackendBrowserState, string> = {
  RUNNING: Locale.Browser.State.RUNNING,
  STARTING: Locale.Browser.State.STARTING,
  RESTARTING: Locale.Browser.State.RESTARTING,
  STOPPED: Locale.Browser.State.STOPPED,
  FAILED: Locale.Browser.State.FAILED,
};

const STATE_HINT: Record<BackendBrowserState, string> = {
  RUNNING: Locale.Browser.Hint.RUNNING,
  STARTING: Locale.Browser.Hint.STARTING,
  RESTARTING: Locale.Browser.Hint.RESTARTING,
  STOPPED: Locale.Browser.Hint.STOPPED,
  FAILED: Locale.Browser.Hint.FAILED,
};

const DOT_CLASS: Record<BackendBrowserState, string> = {
  RUNNING: styles["dot-running"],
  STARTING: styles["dot-busy"],
  RESTARTING: styles["dot-busy"],
  STOPPED: styles["dot-off"],
  FAILED: styles["dot-error"],
};

const UNKNOWN = Locale.Browser.Empty;

export function browserStateView(status: BackendBrowserStatus | null) {
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

function formatBrowserType(status: BackendBrowserStatus | null): string {
  if (!status?.browserType) return UNKNOWN;
  if (status.headless == null) return status.browserType;
  return `${status.browserType} · ${
    status.headless ? Locale.Browser.Headless.Yes : Locale.Browser.Headless.No
  }`;
}

function formatLastError(status: BackendBrowserStatus | null): string {
  const error = status?.lastError;
  if (!error) return UNKNOWN;
  const detail = error.message ? `: ${error.message}` : "";
  return `${error.code}${detail}`;
}

export function browserStatusRows(
  status: BackendBrowserStatus | null,
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
 * 浏览器状态失败提示:HTTP 404 说明后端还没有这个接口,
 * 与「后端连不上」区分开,避免前端先上线时给出误导性的网络错误。
 */
export function browserErrorText(
  code: string | null,
  httpStatus: number | null,
): string | null {
  if (!code) return null;
  if (isUnsupportedBrowserApi(code, httpStatus)) {
    return Locale.Browser.Unsupported;
  }
  return `${Locale.Browser.FetchFailed} · ${errorTextForCode(code)}`;
}

/**
 * 浏览器状态的共享数据源:挂载即拉取一次,并与其他展示位共用一个轮询定时器。
 * 状态只来自后端,不落本地存储。
 */
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

/** 设置页:完整的浏览器状态面板 */
export function BrowserStatusSection() {
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

/** 聊天头部:状态胶囊 + 点击展开的详情气泡 */
export function BrowserStatusButton() {
  const { status, fetchState, restarting, fetchedAt, errorText, restart } =
    useBrowserStatusPanel();
  const [open, setOpen] = useState(false);
  const view = browserStateView(status);
  const rows = browserStatusRows(status, fetchedAt);
  const tip = errorText ?? view.hint;

  return (
    <div className="window-action-button">
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        content={
          <div className={styles["status-popover"]}>
            <div className={styles["status-popover-header"]}>
              <div className={styles["state-badge"]}>
                <span className={clsx(styles.dot, view.dotClass)} />
                <span>{Locale.Browser.Title}</span>
              </div>
              <div className={styles["status-popover-hint"]}>
                {tip}
                {restarting ? ` · ${Locale.Browser.State.RESTARTING}` : ""}
              </div>
            </div>
            <div className={styles["status-popover-rows"]}>
              {rows.map((row) => (
                <div className={styles["status-row"]} key={row.label}>
                  <div className={styles["status-row-label"]}>{row.label}</div>
                  <div className={styles["status-row-value"]} title={row.value}>
                    {row.value}
                  </div>
                </div>
              ))}
            </div>
            <div className={styles["status-popover-actions"]}>
              <IconButton
                aria={Locale.Browser.Actions.Refresh}
                text={Locale.Browser.Actions.Refresh}
                bordered
                disabled={fetchState === "loading"}
                onClick={() => void useBrowserStore.getState().refresh(true)}
              />
              <IconButton
                aria={Locale.Browser.Actions.Restart}
                text={Locale.Browser.Actions.Restart}
                bordered
                type="danger"
                disabled={restarting}
                onClick={restart}
              />
            </div>
          </div>
        }
      >
        <IconButton
          aria={Locale.Browser.Title}
          icon={<span className={clsx(styles.dot, view.dotClass)} />}
          text={view.label}
          bordered
          title={tip}
          onClick={() => setOpen((value) => !value)}
        />
      </Popover>
    </div>
  );
}
