import React from "react";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { RequestProgress } from "../app/components/request-progress";
import Locale from "../app/locales";

test("排队、生成、取消展示不同状态，终态撤掉活动提示", () => {
  const { rerender } = render(<RequestProgress status="PENDING" />);
  expect(screen.getByRole("status").textContent).toBe(Locale.Chat.Progress.Pending);
  rerender(<RequestProgress status="PROCESSING" />);
  expect(screen.getByRole("status").textContent).toBe(Locale.Chat.Progress.Processing);
  rerender(<RequestProgress status="CANCELLING" />);
  expect(screen.getByRole("status").textContent).toBe(Locale.Chat.Progress.Cancelling);
  for (const status of ["SUCCESS", "FAILED", "TIMEOUT", "CANCELLED"] as const) {
    rerender(<RequestProgress status={status} />);
    expect(screen.queryByRole("status")).toBeNull();
  }
});

test("HTML 保留预览，移除调用已关闭端点的分享按钮", () => {
  const source = readFileSync("app/components/markdown.tsx", "utf8");
  expect(source).toContain("<HTMLPreview");
  expect(source).not.toContain("ArtifactsShareButton");
});
