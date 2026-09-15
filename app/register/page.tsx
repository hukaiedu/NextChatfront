"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { useAuthStore } from "../store/auth";
import {
  isPasswordUsable,
  isValidUsername,
  credentialErrorText,
} from "../utils/credential";
import Locale from "../locales";
import { AuthLayout } from "../components/auth-layout";
import styles from "../components/auth-layout.module.scss";

/**
 * V1.4 U4 §27–§36:注册页。
 *
 * §28 与登录页的关键差别:后端的注册是「把一个已有匿名身份原地升级」,
 * 所以未认证时**必须**先建匿名身份(`probeIdentity()` 内部就是 probe→必要时 anonymous),
 * 否则 `POST /auth/register` 只会拿到 401。
 *
 * §17 冻结的时序由 store 保证:200 → sameSubjectTransition → probe → REGISTERED。
 * 回聊天用客户端跳转(不换文档),否则「当前正在看的会话」会被文档重载抹掉。
 */
export default function RegisterPage() {
  const router = useRouter();
  const registerUser = useAuthStore((state) => state.registerUser);
  const userType = useAuthStore((state) => state.userType);
  const accountName = useAuthStore((state) => state.username);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [probing, setProbing] = useState(true);
  /** §85:校验/后端错误都只渲染成一句话,留在本页 state,不进 store */
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // §28:未认证 → 先建匿名;已有身份(含 REGISTERED / ADMIN)只 probe
    void useAuthStore
      .getState()
      .probeIdentity()
      .finally(() => {
        if (alive) setProbing(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    // §31/§32/§33:客户端先挡住明显不合法的输入,省一次注定失败的请求
    if (!isValidUsername(username)) {
      setError(Locale.Account.UsernameInvalid);
      return;
    }
    if (!isPasswordUsable(password)) {
      setError(Locale.Account.PasswordTooShort);
      return;
    }
    if (password !== confirmPassword) {
      setError(Locale.Account.PasswordMismatch);
      return;
    }
    setSubmitting(true);
    setError(null);
    // confirmPassword 不在参数里 —— 它永远不该出现在请求体(§33)
    void registerUser(username, password).then((result) => {
      if (!result.ok) {
        setError(credentialErrorText(result.error));
        setSubmitting(false);
        return;
      }
      setPassword("");
      setConfirmPassword("");
      // §17:同主体原地升级 ⇒ 客户端回聊天,保住正在看的会话与输入
      router.push("/");
    });
  };

  const t = Locale.Account;

  if (probing) {
    return <main className={styles["auth-page"]} aria-busy="true" />;
  }

  // §29:已注册不再提交注册,也不重复建匿名
  if (userType === "REGISTERED") {
    return (
      <AuthLayout
        title={t.RegisterTitle}
        description={t.RegisterSubtitle}
        footer={
          <button
            className={styles.tertiary}
            type="button"
            onClick={() => router.push("/")}
          >
            {t.BackToChat}
          </button>
        }
      >
        <div className={styles["state-panel"]}>
          <div className={styles.notice}>
            {t.AlreadyRegistered(accountName ?? "")}
          </div>
          <button
            className={styles["link-action"]}
            type="button"
            onClick={() => router.push("/login")}
          >
            {t.LoginOther}
          </button>
        </div>
      </AuthLayout>
    );
  }

  // §30:管理员身份不提交注册,也不给普通账号入口任何特权
  if (userType === "ADMIN") {
    return (
      <AuthLayout
        title={t.RegisterTitle}
        description={t.RegisterSubtitle}
        footer={
          <button
            className={styles.tertiary}
            type="button"
            onClick={() => router.push("/")}
          >
            {t.BackToChat}
          </button>
        }
      >
        <div className={styles["state-panel"]}>
          <div className={styles.notice}>{t.Admin}</div>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t.RegisterTitle}
      description={t.RegisterSubtitle}
      footer={
        <button
          className={styles.tertiary}
          type="button"
          onClick={() => router.push("/")}
        >
          {t.BackToChat}
        </button>
      }
    >
      <form className={styles.form} onSubmit={submit}>
        {/* §35:注册是原地升级,当前聊天记录跟着同一个账号一起走 */}
        <div className={styles.notice}>{t.RegisterPreserveTip}</div>
        {/* §36:V1.4 没有找回密码,只提示,不放入口 */}
        <div className={styles.notice}>{t.NoRecoveryTip}</div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="register-username">
            {t.Username}
          </label>
          <input
            id="register-username"
            className={styles.input}
            type="text"
            name="username"
            autoComplete="username"
            placeholder={t.UsernamePlaceholder}
            value={username}
            onChange={(event) => setUsername(event.currentTarget.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="register-password">
            {t.Password}
          </label>
          <input
            id="register-password"
            className={styles.input}
            type="password"
            name="new-password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="register-confirm">
            {t.ConfirmPassword}
          </label>
          <input
            id="register-confirm"
            className={styles.input}
            type="password"
            name="confirm-password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.currentTarget.value)}
          />
        </div>
        {error && (
          <div id="register-error" className={styles.error} role="alert">
            {error}
          </div>
        )}
        <button
          className={styles.primary}
          type="submit"
          disabled={submitting || !username || !password || !confirmPassword}
        >
          {submitting ? t.Submitting : t.SubmitRegister}
        </button>
        <div className={styles["secondary-row"]}>
          <button
            className={styles["link-action"]}
            type="button"
            onClick={() => router.push("/login")}
          >
            {t.ToLogin}
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}
