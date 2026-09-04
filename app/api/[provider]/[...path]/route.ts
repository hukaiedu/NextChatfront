import { NextResponse } from "next/server";

/**
 * personChat V1：唯一聊天通道为 /backend-api/* → Backend /api/* → Gemini Web。
 * 旧 NextChat 多 Provider 代理（openai/anthropic/google/azure/baidu/bytedance/alibaba/moonshot/stability/iflytek/deepseek/xai/glm/siliconflow/302ai 及 default proxy）已下线。
 * 所有 HTTP 方法统一返回 404，绝不进入原 Handler（ISSUE-01）。
 */
function disabledV1LegacyRoute() {
  return NextResponse.json(
    { error: true, message: "This legacy route is disabled in personChat V1" },
    { status: 404 },
  );
}

export const GET = disabledV1LegacyRoute;
export const POST = disabledV1LegacyRoute;
export const PUT = disabledV1LegacyRoute;
export const PATCH = disabledV1LegacyRoute;
export const DELETE = disabledV1LegacyRoute;
export const OPTIONS = disabledV1LegacyRoute;
export const HEAD = disabledV1LegacyRoute;
