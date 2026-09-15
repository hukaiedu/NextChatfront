"use client";

import type { ReactNode } from "react";

import BotIcon from "../icons/bot.svg";
import styles from "./auth-layout.module.scss";

interface AuthLayoutProps {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function AuthLayout({
  title,
  description,
  children,
  footer,
}: AuthLayoutProps) {
  return (
    <main className={styles["auth-page"]}>
      <div className={styles["auth-layout"]}>
        <div className={styles.brand} aria-label="personChat">
          <span className={styles["brand-mark"]} aria-hidden="true">
            <BotIcon />
          </span>
          <span className={styles["brand-name"]}>personChat</span>
        </div>
        <section className={styles.card} aria-labelledby="auth-title">
          <h1 id="auth-title" className={styles.title}>
            {title}
          </h1>
          <p className={styles.description}>{description}</p>
          {children}
        </section>
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </main>
  );
}
