"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { BackendUserType, getAuthSession } from "../client/backend-api";
import { LoginError, useAuthStore } from "../store/auth";
import { credentialErrorText } from "../utils/credential";
import { leaveIdentityAndReload } from "../utils/identity";
import Locale from "../locales";
import styles from "../components/auth-gate.module.scss";

/**
 * V1.4 U4 §22–§26:注册用户登录页。
 *
 * 与 `/` 的 AuthGate 不同,这个页面**只 probe,绝不自动建匿名身份**(§22) ——
 * 直接来登录已有账号的人不该先被塞一个访客身份,而 `POST /auth/user/login`
 * 本身也不要求先有 Session。
 *
 * 登录成功 = 换主体(§20):清身份 → 关流 → 清聊天视图 → 整页换文档,
 * 匿名 UI 必须彻底消失,不允许在旧列表上 append 新账号的会话(§21)。
 */
export default function LoginPage() {
  const router = useRouter();
  const userLogin = useAuthStore((state) => state.userLogin);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [probing, setProbing] = useState(true);
  /** 当前浏览器已有身份;null = 未认证或探测失败(未认证时页面照常可登录) */
  const [identity, setIdentity] = useState<{
    userType: BackendUserType | null;
    username: string | null;
  } | null>(null);
  /** §85:错误只活在这个页面,不进 store、不跨身份 */
  const [error, setError] = useState<LoginError | null>(null);

  useEffect(() => {
    let alive = true;
    void getAuthSession()
      .then((session) => {
        if (!alive) return;
        setIdentity(
          session.authenticated
            ? {
                userType: session.userType ?? null,
                username: session.username ?? null,
              }
            : null,
        );
      })
      .catch(() => {
        // 探测失败按「未认证」处理:表单照常可用,真正的判定在后端
        if (alive) setIdentity(null);
      })
      .finally(() => {
        if (alive) setProbing(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (submitting || !username || !password) return;
    setSubmitting(true);
    setError(null);
    void userLogin(username, password).then((result) => {
      if (!result.ok) {
        setError(result.error);
        setSubmitting(false);
        return;
      }
      // §20/§61:成功不解除 submitting —— 换文档期间按钮保持禁用,不给双击留窗口
      leaveIdentityAndReload("/");
    });
  };

  if (probing) {
    return <div className={styles["auth-gate"]} aria-busy="true" />;
  }

  const t = Locale.Account;
  const current = identity?.userType;

  return (
    <div className={styles["auth-gate"]}>
      <form className={styles["form"]} onSubmit={submit}>
        <div className={styles["title"]}>{t.LoginTitle}</div>
        {/* §24:本地是访客时讲清楚「不会合并」;§25:已注册时允许换账号;
            §26:管理员只是提示,不给特权也不自动调 Admin 接口 */}
        {current === "ANONYMOUS" && (
          <div className={styles["error"]}>{t.LoginSwitchTip}</div>
        )}
        {current === "REGISTERED" && (
          <div className={styles["error"]}>
            <div>{t.CurrentAccount(identity?.username ?? "")}</div>
            <div>{t.SwitchAccountWarning}</div>
          </div>
        )}
        {current === "ADMIN" && (
          <div className={styles["error"]}>{t.Admin}</div>
        )}
        <label htmlFor="login-username">{t.Username}</label>
        <input
          id="login-username"
          className={styles["input"]}
          type="text"
          name="username"
          autoComplete="username"
          placeholder={t.UsernamePlaceholder}
          value={username}
          onChange={(event) => setUsername(event.currentTarget.value)}
        />
        <label htmlFor="login-password">{t.Password}</label>
        <input
          id="login-password"
          className={styles["input"]}
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.currentTarget.value)}
        />
        {error && (
          <div id="login-error" className={styles["error"]} role="alert">
            {credentialErrorText(error)}
          </div>
        )}
        <button
          className={styles["submit"]}
          type="submit"
          disabled={submitting || !username || !password}
        >
          {submitting ? t.Submitting : t.SubmitLogin}
        </button>
        <button
          className={styles["submit"]}
          type="button"
          onClick={() => router.push("/register")}
        >
          {t.ToRegister}
        </button>
        <button
          className={styles["submit"]}
          type="button"
          onClick={() => router.push("/")}
        >
          {t.BackToChat}
        </button>
      </form>
    </div>
  );
}
