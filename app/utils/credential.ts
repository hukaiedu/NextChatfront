import type { LoginError } from "../store/auth";
import Locale from "../locales";

/**
 * V1.4 U4 §31:客户端预检规则,与后端 auth.username.ts 冻结的同一条。
 * 这里只是少发一次注定失败的请求,真正的判定仍在后端 —— 所以不要在这里放宽
 * (不加 email / 手机号 / 空格 / 中文,也不放宽到 Unicode)。
 */
export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;

/** §32:口令只限长度 8..128,不强制大小写/数字/符号组合 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export function isValidUsername(value: string): boolean {
  return USERNAME_PATTERN.test(value);
}

export function isPasswordUsable(value: string): boolean {
  return (
    value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH
  );
}

/**
 * §54–§58:公开错误码 → 产品层文案。
 * 用户名不存在 / 密码错 / 账号被禁用一律收成同一句(§56),
 * 503 也不许被解释成「密码错误」(§58);绝不把后端原始码渲染给用户。
 */
export function credentialErrorText(error: LoginError): string {
  const t = Locale.Account.Error;
  switch (error.code) {
    case "AUTH_USERNAME_ALREADY_TAKEN":
      return t.AUTH_USERNAME_ALREADY_TAKEN;
    case "AUTH_IDENTITY_NOT_ANONYMOUS":
      return t.AUTH_IDENTITY_NOT_ANONYMOUS;
    case "AUTH_USER_DISABLED":
      return t.AUTH_USER_DISABLED;
    case "AUTH_INVALID_CREDENTIALS":
      return t.AUTH_INVALID_CREDENTIALS;
    case "AUTH_REQUIRED":
      return t.AUTH_REQUIRED;
    case "AUTH_FORBIDDEN":
      return t.AUTH_FORBIDDEN;
    case "AUTH_RATE_LIMITED":
      return t.AUTH_RATE_LIMITED(error.retryAfterSeconds ?? 0);
    case "SERVICE_BUSY":
      return t.SERVICE_BUSY;
    case "VALIDATION_ERROR":
      return t.VALIDATION_ERROR;
    case "NETWORK_ERROR":
      return t.NETWORK_ERROR;
    default:
      return t.GENERIC;
  }
}
