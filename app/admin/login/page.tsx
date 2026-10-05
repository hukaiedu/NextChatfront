"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { useAuthStore, LoginError } from "../../store/auth";
import { getAuthSession } from "../../client/backend-api";
import Locale from "../../locales";
import styles from "./login.module.scss";

/**
 * V1.3-C §16/§17:独立的管理员入口。
 *
 * - 已是 ADMIN → 直接进 /admin
 * - ANONYMOUS / 未认证 → 显示管理员密码表单(**不**先创建匿名身份)
 * - 已有匿名身份时,提交前显示身份切换提示(§18)
 *
 * 密码只存在于 form state 与一次 POST 请求里(§69),不写 storage / URL / console。
 */
export default function AdminLoginPage() {
  const router = useRouter();
  const adminLogin = useAuthStore((state) => state.adminLogin);
  const adminLoginError = useAuthStore((state) => state.adminLoginError);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [probing, setProbing] = useState(true);
  /** 当前浏览器已有的身份;null = 未认证 / 探测失败 */
  const [existing, setExisting] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getAuthSession()
      .then((session) => {
        if (!alive) return;
        if (session.authenticated && session.userType === "ADMIN") {
          // 不解除占位:避免闪一下密码表单再跳走
          router.replace("/admin");
          return;
        }
        setProbing(false);
        setExisting(session.authenticated ? session.userType ?? null : null);
      })
      .catch(() => {
        if (alive) setProbing(false);
      });
    return () => {
      alive = false;
    };
  }, [router]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (submitting || !password) return;
    setSubmitting(true);
    void adminLogin(password)
      .then((ok) => {
        // §69:提交完成后立刻清理 form state
        setPassword("");
        // FIX-02A:后端删掉旧匿名 Session 并覆盖同名 Cookie,且匿名 Conversation 不转给
        // ADMIN —— 必须整页换文档,才能让旧匿名 chat store / 消息缓存 / SSE 一起消失。
        if (ok) window.location.replace("/admin");
      })
      .finally(() => setSubmitting(false));
  };

  const errorText = (error: LoginError): string => {
    if (error.code === "AUTH_RATE_LIMITED") {
      return Locale.AdminConsole.Error.AUTH_RATE_LIMITED(
        error.retryAfterSeconds ?? 0,
      );
    }
    if (error.code === "AUTH_INVALID_CREDENTIALS") {
      return Locale.AdminConsole.Error.AUTH_INVALID_CREDENTIALS;
    }
    if (error.code === "ADMIN_UNAVAILABLE") {
      return Locale.AdminConsole.Error.ADMIN_UNAVAILABLE;
    }
    return Locale.AdminConsole.Error.NETWORK_ERROR;
  };

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="admin-login-title">
        <div className={styles.brand}>
          <img src="/mark.png" width="36" height="36" alt="" />
          <span>personChat</span>
        </div>
        <h1 id="admin-login-title" className={styles.title}>
          {Locale.AdminConsole.LoginTitle}
        </h1>
        <p className={styles.description}>
          {Locale.AdminConsole.LoginDescription}
        </p>
        {probing ? (
          <div className={styles.probing} role="status" aria-busy="true">
            {Locale.AdminConsole.LoginProbing}
          </div>
        ) : (
          <form
            className={styles.form}
            onSubmit={submit}
            aria-busy={submitting}
          >
            {existing === "ANONYMOUS" && (
              <p className={styles.notice}>
                {Locale.AdminConsole.SwitchWarning}
              </p>
            )}
            <label className={styles.label} htmlFor="admin-password">
              {Locale.AdminConsole.PasswordLabel}
            </label>
            <input
              id="admin-password"
              className={styles.input}
              type="password"
              name="password"
              value={password}
              placeholder={Locale.AdminConsole.PasswordPlaceholder}
              autoComplete="current-password"
              aria-invalid={!!adminLoginError}
              aria-describedby={
                adminLoginError ? "admin-login-error" : undefined
              }
              disabled={submitting}
              autoFocus
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
            {adminLoginError && (
              <p id="admin-login-error" className={styles.error} role="alert">
                {errorText(adminLoginError)}
              </p>
            )}
            <button
              className={styles.submit}
              type="submit"
              disabled={submitting || !password}
            >
              {submitting
                ? Locale.AdminConsole.Submitting
                : Locale.AdminConsole.Submit}
            </button>
          </form>
        )}
        <Link className={styles.back} href="/">
          {Locale.AdminConsole.BackToChat}
        </Link>
      </section>
    </main>
  );
}
