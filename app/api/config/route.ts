import { NextResponse } from "next/server";

import { getServerSideConfig } from "../../config/server";

const serverConfig = getServerSideConfig();

// Danger! Do not hard code any secret value here!
// 警告！不要在这里写入任何敏感信息！
//
// personChat V1（ISSUE-01 / 验收计划 §5）：/api/config 仅保留「访问控制 / 通用 UI 标志」，
// 供前端启动时准入判断使用（needCode）。已移除全部 Provider / 模型开关
// （hideUserApiKey / disableGPT4 / customModels / defaultModel / visionModels），
// 不含任何 API Key 或 Provider 凭据。V1 唯一聊天通道为 /backend-api/*。
const DANGER_CONFIG = {
  needCode: serverConfig.needCode,
  hideBalanceQuery: serverConfig.hideBalanceQuery,
  disableFastLink: serverConfig.disableFastLink,
};

declare global {
  type DangerConfig = typeof DANGER_CONFIG;
}

async function handle() {
  return NextResponse.json(DANGER_CONFIG);
}

export const GET = handle;
export const POST = handle;

export const runtime = "edge";
