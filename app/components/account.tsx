import { useState } from "react";
import { useRouter } from "next/navigation";

import { IconButton } from "./button";
import {
  List,
  ListItem,
  PasswordInput,
  showConfirm,
  showToast,
} from "./ui-lib";
import { LoginError, useAuthStore } from "../store/auth";
import { credentialErrorText, isPasswordUsable } from "../utils/credential";
import { leaveIdentityAndReload } from "../utils/identity";
import Locale from "../locales";
import gateStyles from "./auth-gate.module.scss";

/**
 * V1.4 U4 §37–§43:账号区,挂在 Settings 里(现成的次级面板,不重构侧边栏)。
 *
 * - 访客:登录 / 注册入口(§38)
 * - 注册用户:@username + 退出 为一级;修改密码 / 退出所有设备 在次级(§39)
 * - 管理员:只保留既有控制台入口,绝不伪装成注册用户(§40 / UI-ADMIN-01)
 *
 * 去 `/login`、`/register` 用客户端跳转,这样返回聊天时当前文档里的会话与
 * 未提交输入都还在;只有真正换主体(退出 / 退出所有设备)才整页换文档。
 */
export function AccountSection() {
  const router = useRouter();
  const userType = useAuthStore((state) => state.userType);
  const accountName = useAuthStore((state) => state.username);
  const logout = useAuthStore((state) => state.logout);
  const changePassword = useAuthStore((state) => state.changePassword);
  const revokeAllSessions = useAuthStore((state) => state.revokeAllSessions);
  const [busy, setBusy] = useState<"logout" | "change" | "revoke" | null>(null);
  const [showChange, setShowChange] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  /** §85:错误只活在这个面板,不进 store、不跨身份 */
  const [error, setError] = useState<string | null>(null);

  const t = Locale.Account;

  const onLogout = async () => {
    if (busy) return;
    setBusy("logout");
    setError(null);
    if (await logout()) {
      // §44:后端 204 之后才收本地;回首页由 AuthGate 建新的访客身份(§45)
      leaveIdentityAndReload("/");
      return;
    }
    const failure: LoginError | null = useAuthStore.getState().logoutError;
    setError(failure ? credentialErrorText(failure) : t.Error.GENERIC);
    setBusy(null);
  };

  const onChangePassword = async () => {
    if (busy) return;
    if (!isPasswordUsable(newPassword)) {
      setError(t.PasswordTooShort);
      return;
    }
    setBusy("change");
    setError(null);
    const result = await changePassword(currentPassword, newPassword);
    if (!result.ok) {
      // §76 AUTH-PWD-05:失败留在表单上,不跳转也不清聊天
      setError(credentialErrorText(result.error));
      setBusy(null);
      return;
    }
    // §42:同一 userId,当前设备保持登录,其它设备由后端撤销 —— 聊天视图一点不动
    setCurrentPassword("");
    setNewPassword("");
    setShowChange(false);
    setBusy(null);
    showToast(t.PasswordChanged);
  };

  const onRevokeAll = async () => {
    if (busy) return;
    if (!(await showConfirm(t.RevokeAllConfirm))) return;
    setBusy("revoke");
    setError(null);
    const result = await revokeAllSessions();
    if (!result.ok) {
      setError(credentialErrorText(result.error));
      setBusy(null);
      return;
    }
    // §43:当前 Session 也在撤销之列 → 清视图 + 换文档,首页重新建访客身份
    leaveIdentityAndReload("/");
  };

  const errorRow = error ? (
    <div className={gateStyles["error"]} role="alert">
      {error}
    </div>
  ) : null;

  if (userType === "REGISTERED") {
    return (
      <List>
        <ListItem title={t.CurrentAccount(accountName ?? "")}>
          <IconButton
            aria={t.Logout}
            text={t.Logout}
            disabled={busy === "logout"}
            onClick={onLogout}
          />
        </ListItem>
        <ListItem
          title={t.ChangePassword}
          subTitle={showChange ? undefined : t.NoRecoveryTip}
        >
          <IconButton
            aria={t.ChangePassword}
            text={t.ChangePassword}
            disabled={busy === "change"}
            onClick={() => {
              setShowChange((visible) => !visible);
              setError(null);
            }}
          />
        </ListItem>
        {showChange && (
          <>
            <ListItem title={t.CurrentPassword}>
              <PasswordInput
                aria={Locale.Settings.ShowPassword}
                aria-label={t.CurrentPassword}
                name="current-password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) =>
                  setCurrentPassword(event.currentTarget.value)
                }
              />
            </ListItem>
            <ListItem title={t.NewPassword}>
              <PasswordInput
                aria={Locale.Settings.ShowPassword}
                aria-label={t.NewPassword}
                name="new-password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.currentTarget.value)}
              />
            </ListItem>
            <ListItem title={t.SubmitChange}>
              <IconButton
                aria={t.SubmitChange}
                text={busy === "change" ? t.Submitting : t.SubmitChange}
                disabled={busy !== null || !currentPassword || !newPassword}
                onClick={onChangePassword}
              />
            </ListItem>
          </>
        )}
        <ListItem title={t.RevokeAllDevices} subTitle={t.RevokeAllHint}>
          <IconButton
            aria={t.RevokeAllDevices}
            text={t.RevokeAllDevices}
            disabled={busy !== null}
            onClick={onRevokeAll}
          />
        </ListItem>
        {errorRow}
      </List>
    );
  }

  if (userType === "ADMIN") {
    return (
      <List>
        <ListItem title={t.Admin}>
          <IconButton
            aria={t.AdminConsole}
            text={t.AdminConsole}
            onClick={() => window.location.assign("/admin")}
          />
        </ListItem>
      </List>
    );
  }

  return (
    <List>
      <ListItem title={t.Title} subTitle={t.Visitor} />
      <ListItem title={t.Login} subTitle={t.LoginSwitchTip}>
        <IconButton
          aria={t.Login}
          text={t.Login}
          onClick={() => router.push("/login")}
        />
      </ListItem>
      <ListItem title={t.Register} subTitle={t.RegisterPreserveTip}>
        <IconButton
          aria={t.Register}
          text={t.Register}
          onClick={() => router.push("/register")}
        />
      </ListItem>
      {errorRow}
    </List>
  );
}
