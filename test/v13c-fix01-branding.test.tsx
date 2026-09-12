import { jest } from "@jest/globals";
import { act, render, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { MemoryRouter } from "react-router-dom";
import type { ChatMessage, ChatSession } from "../app/store/chat";

/**
 * V1.3-C FIX-01A:Public 聊天不得表达后端实现品牌(Gemini / Gemini Web / Provider /
 * Browser),但 GET /backend-api/provider/models 返回的真实模型 label(例如
 * "Gemini 3.6 Flash")必须继续正常展示。
 *
 * 两个方向分开测:BRAND-01/02/03 防泄露,BRAND-04 防"为了零 Gemini 把真实模型名
 * 与动态品牌图标一起误删"。真实模型 label 的正向用例在 backend-model-selector
 * 的 M4-30。
 */

const STAMP = "2026-09-12T00:00:00.000Z";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// store/组件必须晚于 fetch 桩求值(prompt store 在创建时就 fetch prompts.json)
let useChatStore: (typeof import("../app/store/chat"))["useChatStore"];
let BACKEND_MODEL_LABEL: string;
let Chat: (typeof import("../app/components/chat"))["Chat"];
let createEmptyMask: (typeof import("../app/store/mask"))["createEmptyMask"];

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
  model?: string,
): ChatMessage {
  return {
    id,
    role,
    content,
    date: STAMP,
    position: 1,
    ...(model ? { model } : {}),
  };
}

function session(messages: ChatMessage[]): ChatSession {
  return {
    id: "c-1",
    topic: "品牌检查会话",
    messages,
    stat: { tokenCount: 0, wordCount: 0, charCount: 0 },
    lastUpdate: Date.parse(STAMP),
    mask: createEmptyMask(),
    loaded: true,
    draft: false,
    conversationStatus: "ACTIVE",
    messageNextCursor: null,
    loadingOlderMessages: false,
    messageHistoryError: false,
    messageTotalCount: messages.length,
  } as ChatSession;
}

beforeAll(async () => {
  (globalThis as any).fetch = jest.fn(async (input: any) => {
    const url = String(input);
    return {
      ok: true,
      status: 200,
      // prompts.json 按语言分组,plugins.json 是数组
      json: async () => (url.includes("plugins.json") ? [] : { en: [], tw: [], cn: [] }),
    };
  });
  (globalThis as any).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  Element.prototype.scrollIntoView = () => {};
  (Element.prototype as any).scrollTo = () => {};
  (globalThis as any).EventSource = class {
    close() {}
    addEventListener() {}
  };

  ({ useChatStore, BACKEND_MODEL_LABEL } = await import("../app/store/chat"));
  ({ createEmptyMask } = await import("../app/store/mask"));
  ({ Chat } = await import("../app/components/chat"));
});

afterEach(() => {
  useChatStore.setState({
    sessions: [],
    currentSessionIndex: 0,
    ready: false,
  } as any);
});

async function renderChat() {
  useChatStore.setState({
    sessions: [
      session([
        message("m-1", "user", "你好"),
        message("m-2", "assistant", "后端保存的回答", BACKEND_MODEL_LABEL),
      ]),
    ],
    currentSessionIndex: 0,
    ready: true,
    loadingList: false,
    listStatus: "ACTIVE",
  } as any);

  const view = render(
    <MemoryRouter>
      <Chat />
    </MemoryRouter>,
  );
  await act(async () => {
    await tick();
  });
  return view;
}

describe("FIX-01A:Public 助手身份去实现品牌", () => {
  test("BRAND-01 助手气泡展示中性助手名,整个 Chat DOM 不含实现品牌", async () => {
    const view = await renderChat();

    const bubble = view.container.querySelector(
      '[data-message-id="m-2"]',
    ) as HTMLElement;
    expect(bubble).not.toBeNull();
    // CSS Module 类名是哈希,按文本定位中性助手名节点
    expect(within(bubble).getByText("Assistant")).toBeInTheDocument();

    // Markdown 正文走 next/dynamic,jest 内不解析文本(既有环境限制,同 I3 用例口径);
    // 这里扫的是 Chat 渲染出的全部可见文案
    const text = view.container.textContent ?? "";
    expect(text).not.toMatch(/gemini/i);
    expect(text).not.toContain("Gemini Web");
    expect(text).not.toContain("Provider");
    expect(text).not.toContain("Browser");
  });

  test("BRAND-02 中性展示名常量守卫:不携带后端实现品牌", () => {
    expect(BACKEND_MODEL_LABEL).toBe("Assistant");
    expect(BACKEND_MODEL_LABEL).not.toMatch(/gemini|provider|browser/i);
  });

  test("BRAND-03 Public 运行时源码静态扫描:实现品牌硬编码 = 0", () => {
    const publicSources = [
      "app/store/chat.ts",
      "app/components/chat.tsx",
      "app/components/chat-list.tsx",
      "app/components/model-selector.tsx",
      "app/components/new-chat.tsx",
      "app/components/settings.tsx",
    ];
    for (const file of publicSources) {
      // 注释允许说明后端实现,所以剔掉注释行后再判字面量
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect([file, code.includes("Gemini Web")]).toEqual([file, false]);
      expect([file, /llm-icons\/gemini\.svg/.test(code)]).toEqual([file, false]);
    }
  });

  test("BRAND-04 真实 Gemini 模型展示能力保留:动态 label 机制未被删", () => {
    // A 类:emoji.tsx 仍按模型名前缀挑品牌图标(只有真实 Gemini 模型拿 Gemini 图标)
    const emoji = readFileSync("app/components/emoji.tsx", "utf8");
    expect(emoji).toContain(
      'import BotIconGemini from "../icons/llm-icons/gemini.svg"',
    );
    expect(emoji).toContain('modelName.startsWith("gemini")');

    // B 类:浏览器运维文案(Gemini Web 字样)只服务 Admin 面板
    const adminPage = readFileSync("app/admin/page.tsx", "utf8");
    expect(adminPage).toContain('from "../components/browser-status"');
    for (const file of [
      "app/components/settings.tsx",
      "app/components/chat.tsx",
    ]) {
      expect([file, /Locale\.Browser/.test(readFileSync(file, "utf8"))]).toEqual([
        file,
        false,
      ]);
    }
  });
});
