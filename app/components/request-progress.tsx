import React from "react";
import Locale from "../locales";
import type { BackendRequestStatus } from "../client/backend-api";

/** 状态文字来自后端，文本是否已流入不会改变排队判据。 */
export function RequestProgress({ status }: { status?: BackendRequestStatus }) {
  const text =
    status === "PENDING"
      ? Locale.Chat.Progress.Pending
      : status === "PROCESSING"
      ? Locale.Chat.Progress.Processing
      : status === "CANCELLING"
      ? Locale.Chat.Progress.Cancelling
      : null;
  return text ? (
    <div role="status" aria-live="polite">
      {text}
    </div>
  ) : null;
}
