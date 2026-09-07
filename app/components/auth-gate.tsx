"use client";

import { FormEvent, ReactNode, useEffect, useState } from "react";

import { LoginError, useAuthStore } from "../store/auth";
import Locale from "../locales";
import styles from "./auth-gate.module.scss";

function loginErrorText(error: LoginError): string {
  if (error.code === "AUTH_RATE_LIMITED") {
    return Locale.Auth.Error.AUTH_RATE_LIMITED(error.retryAfterSeconds ?? 0);
  }
  if (error.code === "AUTH_INVALID_CREDENTIALS") {
    return Locale.Auth.Error.AUTH_INVALID_CREDENTIALS;
  }
  return Locale.Auth.Error.NETWORK_ERROR;
}

/**
 * SEC-1 §11.3:认证门。checking → 占位;unauthenticated → 登录表单;
 * authenticated → 透传 children(可承接 RSC 内容)。
 */
export function AuthGate(props: { children?: ReactNode }) {
  const status = useAuthStore((state) => state.status);
  const loginError = useAuthStore((state) => state.loginError);
  const login = useAuthStore((state) => state.login);
  const probe = useAuthStore((state) => state.probe);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (status === "checking") {
      // 探测网络失败时保持 checking,不臆断认证状态(§8.3 第三态同理)
      probe().catch(() => undefined);
    }
  }, [status, probe]);

  if (status === "checking") {
    return <div className={styles["auth-gate"]} aria-busy="true" />;
  }

  if (status === "unauthenticated") {
    const submit = (event: FormEvent) => {
      event.preventDefault();
      if (submitting || !password) return;
      setSubmitting(true);
      login(password).finally(() => setSubmitting(false));
    };

    return (
      <div className={styles["auth-gate"]}>
        <form className={styles["form"]} onSubmit={submit}>
          <div className={styles["title"]}>{Locale.Auth.ServerTitle}</div>
          <input
            className={styles["input"]}
            type="password"
            name="password"
            value={password}
            placeholder={Locale.Auth.PasswordPlaceholder}
            onChange={(event) => setPassword(event.currentTarget.value)}
            autoFocus
          />
          {loginError && (
            <div className={styles["error"]}>{loginErrorText(loginError)}</div>
          )}
          <button
            className={styles["submit"]}
            type="submit"
            disabled={submitting || !password}
          >
            {Locale.Auth.Submit}
          </button>
        </form>
      </div>
    );
  }

  return <>{props.children}</>;
}
