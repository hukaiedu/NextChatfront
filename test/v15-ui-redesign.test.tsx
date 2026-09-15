import { jest } from "@jest/globals";
import fs from "node:fs";
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ChatSession } from "../app/store/chat";

/**
 * V1.5 前端改版(§16 Gate 1):新 UI 骨架的组件级自动化。
 *
 * jsdom 把 CSS Module 的类名解析成空字符串(styleMock),所以 DOM 断言一律走
 * data-* / #chat-input / label[for] / role / 文案;纯视觉事实(850px 列宽、
 * Composer 圆角、气泡底色、无重阴影)按 SCSS 源文件静态断言 —— 同 I3-PREVIEW-05。
 *
 * 只测「页面壳 + 布局 + 展示层」:身份、附件、分页的业务契约仍由 v14u4-* / I3 / PAG 套件守。
 */

const push = jest.fn();
const routerMock = {
  push,
  replace: jest.fn(),
  back: jest.fn(),
  prefetch: jest.fn(),
};

// ESM 下 jest.mock 不生效,必须 unstable_mockModule(同 v14u4-pages.test.tsx)
jest.unstable_mockModule("next/navigation", () => ({
  __esModule: true,
  useRouter: () => routerMock,
}));

let useChatStore: (typeof import("../app/store/chat"))["useChatStore"];
let useAuthStore: (typeof import("../app/store/auth"))["useAuthStore"];
let resetAuthBootstrapState: (typeof import("../app/store/auth"))["resetAuthBootstrapState"];
let useAppConfig: (typeof import("../app/store/config"))["useAppConfig"];
let createEmptyMask: (typeof import("../app/store/mask"))["createEmptyMask"];
let createMessage: (typeof import("../app/store/chat"))["createMessage"];
let SideBar: (typeof import("../app/components/sidebar"))["SideBar"];
let ChatList: (typeof import("../app/components/chat-list"))["ChatList"];
let Chat: (typeof import("../app/components/chat"))["Chat"];
let Locale: (typeof import("../app/locales"))["default"];
let DEFAULT_SIDEBAR_WIDTH: number;
let NARROW_SIDEBAR_WIDTH: number;

const STAMP = "2026-09-14T00:00:00.000Z";
const PREFIX = "/backend-api";
const LIST = `${PREFIX}/conversations?`;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  await tick();
  await tick();
};

class FakeIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function reply(status: number, data?: unknown, meta?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => ({ data: data ?? null, ...(meta ? { meta } : {}) }),
  };
}

function routes(url: string, method: string): any {
  if (url === `${PREFIX}/auth/session`) {
    return reply(200, {
      authenticated: true,
      expiresAt: STAMP,
      userType: "ANONYMOUS",
      username: null,
    });
  }
  if (url.startsWith(LIST) && method === "GET") {
    return reply(200, [], { nextCursor: null });
  }
  if (url.endsWith("/messages")) {
    return reply(200, [], { nextCursor: null, totalCount: 0 });
  }
  if (url === `${PREFIX}/provider/models`) {
    return reply(200, { models: [] });
  }
  return undefined;
}

function fakeSession(
  id: string,
  topic: string,
  overrides: Partial<ChatSession> = {},
): ChatSession {
  return {
    id,
    topic,
    messages: [],
    stat: { tokenCount: 0, wordCount: 0, charCount: 0 },
    lastUpdate: Date.parse(STAMP),
    mask: createEmptyMask(),
    loaded: true,
    draft: false,
    messageNextCursor: null,
    loadingOlderMessages: false,
    messageHistoryError: false,
    messageTotalCount: 0,
    ...overrides,
  } as ChatSession;
}

/** 直接把会话表灌进 store:改版壳层测试不重跑 bootstrap */
function seedSessions(sessions: ChatSession[], currentSessionIndex = 0) {
  useChatStore.setState({
    sessions,
    currentSessionIndex,
    ready: true,
    loadingList: false,
    listStatus: "ACTIVE",
    listNextCursor: null,
    loadingMoreList: false,
    listReloadError: false,
    listMoreError: false,
  } as any);
}

function inputBox(): HTMLTextAreaElement {
  const el = document.getElementById("chat-input");
  expect(el).toBeTruthy();
  return el as HTMLTextAreaElement;
}

function composerToolbar(): HTMLElement {
  const el = document.querySelector('[data-composer-toolbar="true"]');
  expect(el).toBeTruthy();
  return el as HTMLElement;
}

function nodeOf(text: string): HTMLElement {
  const node = screen.getByText(text);
  expect(node).toBeTruthy();
  return node as HTMLElement;
}

function buttonOf(text: string): HTMLButtonElement {
  const button = nodeOf(text).closest("button");
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

function identityNode(): Element | null {
  return document.querySelector("[data-sidebar-identity]");
}

function source(file: string): string {
  return fs.readFileSync(file, "utf8");
}

/** 取某个规则块:只在行首匹配选择器(避开同名的嵌套副本),按花括号配对取整块 */
function ruleBlock(file: string, selector: string): string {
  const at = file.indexOf("\n" + selector);
  expect(at).toBeGreaterThanOrEqual(0);
  const start = at + 1;
  const open = file.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < file.length; i += 1) {
    if (file[i] === "{") depth += 1;
    else if (file[i] === "}") {
      depth -= 1;
      if (depth === 0) return file.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced block: ${selector}`);
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

const DESKTOP_WIDTH = 1280;
const CHAT_SCSS = "app/components/chat.module.scss";
const HOME_SCSS = "app/components/home.module.scss";

beforeAll(async () => {
  (globalThis as any).IntersectionObserver = FakeIntersectionObserver;
  Element.prototype.scrollIntoView = () => {};
  (Element.prototype as any).scrollTo = () => {};
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get: () => 6000,
  });
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get: () => 600,
  });

  const prevFetch = globalThis.fetch.bind(globalThis);
  (globalThis as any).fetch = async (input: any, init: any = {}) => {
    const url = String(input);
    if (url.includes("prompts.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ en: [], tw: [], cn: [] }),
      };
    }
    const method = String(init.method ?? "GET").toUpperCase();
    return routes(url, method) ?? prevFetch(input, init);
  };

  // store 必须先于组件求值:组件经 store/index 形成循环依赖
  ({ useChatStore, createMessage } = await import("../app/store/chat"));
  ({ useAuthStore, resetAuthBootstrapState } = await import("../app/store/auth"));
  ({ useAppConfig } = await import("../app/store/config"));
  ({ createEmptyMask } = await import("../app/store/mask"));
  ({ DEFAULT_SIDEBAR_WIDTH, NARROW_SIDEBAR_WIDTH } = await import("../app/constant"));
  ({ SideBar } = await import("../app/components/sidebar"));
  ({ ChatList } = await import("../app/components/chat-list"));
  ({ Chat } = await import("../app/components/chat"));
  Locale = (await import("../app/locales")).default;
});

beforeEach(() => {
  push.mockClear();
  document.documentElement.style.removeProperty("--sidebar-width");
  localStorage.clear();
  useAppConfig.setState({
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    dontShowMaskSplashScreen: true,
  } as any);
  useAuthStore.setState({
    status: "authenticated",
    userType: "ANONYMOUS",
    username: null,
    sameSubjectTransition: false,
    expiresAt: STAMP,
    identityEpoch: 0,
    bootstrapErrorCode: null,
    adminLoginError: null,
    logoutError: null,
  });
  resetAuthBootstrapState();
  seedSessions([fakeSession("s-1", "会话一"), fakeSession("s-2", "会话二")]);
  setViewport(DESKTOP_WIDTH);
});

function renderSideBar() {
  return render(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/chat"] },
      React.createElement(SideBar),
    ),
  );
}

function renderChatList() {
  return render(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/chat"] },
      React.createElement(ChatList, { narrow: false }),
    ),
  );
}

function renderChat() {
  return render(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/chat"] },
      React.createElement(Chat),
    ),
  );
}

describe("V1.5 §3 Sidebar 骨架", () => {
  test("UI-SB-01 品牌行:personChat 与折叠按钮同一行,新建对话紧随其后", async () => {
    renderSideBar();
    await act(settle);

    const brand = screen.getByText("personChat");
    const collapse = screen.getByTitle(Locale.Home.CollapseSidebar);
    const headerRow = collapse.closest("[data-tauri-drag-region]") as HTMLElement;
    expect(headerRow).toBeTruthy();
    expect(headerRow.textContent).toContain("personChat");
    expect(
      brand.compareDocumentPosition(collapse) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const newChat = buttonOf(Locale.Home.NewChat);
    expect(
      headerRow.compareDocumentPosition(newChat) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("UI-SB-02 折叠按钮把 Sidebar 收到 narrow,再点回 260px", async () => {
    renderSideBar();
    await act(settle);

    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe(
      `${DEFAULT_SIDEBAR_WIDTH}px`,
    );

    act(() => {
      fireEvent.click(screen.getByTitle(Locale.Home.CollapseSidebar));
    });
    await act(settle);

    expect(useAppConfig.getState().sidebarWidth).toBe(NARROW_SIDEBAR_WIDTH);
    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe(
      `${NARROW_SIDEBAR_WIDTH}px`,
    );
    // narrow 下文案让位给图标:轻量、不横向撑破
    expect(screen.queryByText(Locale.Home.NewChat)).toBeNull();

    act(() => {
      fireEvent.click(screen.getByTitle(Locale.Home.CollapseSidebar));
    });
    await act(settle);

    expect(useAppConfig.getState().sidebarWidth).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(screen.getByText(Locale.Home.NewChat)).toBeTruthy();
  });

  test("UI-SB-03 默认宽度就是 260px(§3 轻量 Sidebar,不是 300+ 的重面板)", () => {
    expect(DEFAULT_SIDEBAR_WIDTH).toBe(260);
    const home = source(HOME_SCSS);
    const sidebar = ruleBlock(home, ".sidebar {");
    expect(sidebar).toContain("width: var(--sidebar-width)");
    expect(sidebar).toContain("background-color: var(--color-sidebar)");

    const globals = source("app/styles/globals.scss");
    expect(globals).toContain("--sidebar-width: 260px;");
  });

  test("UI-SB-04 访客:底部显示当前身份 + 登录入口,点登录走 /login 整页", async () => {
    renderSideBar();
    await act(settle);

    expect(identityNode()?.getAttribute("data-sidebar-identity")).toBe("guest");
    expect(screen.getByText(Locale.Account.Visitor)).toBeTruthy();

    const login = document.querySelector("[data-sidebar-login]");
    expect(login).toBeTruthy();
    act(() => {
      fireEvent.click(login as Element);
    });
    expect(push).toHaveBeenCalledWith("/login");
  });

  test("UI-SB-05 REGISTERED:显示当前账号并进设置(这里不复制认证逻辑)", async () => {
    useAuthStore.setState({ userType: "REGISTERED", username: "alice" });
    renderSideBar();
    await act(settle);

    const node = identityNode() as Element;
    expect(node.getAttribute("data-sidebar-identity")).toBe("registered");
    expect(screen.getByText(Locale.Account.CurrentAccount("alice"))).toBeTruthy();
    expect(node.getAttribute("href")).toBe("/settings");
    expect(screen.queryByText(Locale.Account.Visitor)).toBeNull();
  });

  test("UI-SB-06 ADMIN 身份单独展示,不冒充注册用户", async () => {
    useAuthStore.setState({ userType: "ADMIN", username: null });
    renderSideBar();
    await act(settle);

    expect(identityNode()?.getAttribute("data-sidebar-identity")).toBe("admin");
    expect(screen.getByText(Locale.Account.Admin)).toBeTruthy();
    expect(document.querySelector("[data-sidebar-login]")).toBeNull();
  });

  test("UI-SB-07 新建对话只在顶部出现一次,设置入口仍可达", async () => {
    renderSideBar();
    await act(settle);

    expect(screen.getAllByText(Locale.Home.NewChat)).toHaveLength(1);
    expect(screen.getByLabelText(Locale.Settings.Title)).toBeTruthy();
  });

  test("UI-SB-08 历史行是扁平列表:hover/选中只用背景差,不加边框卡片(§3)", () => {
    const home = source(HOME_SCSS);
    const item = ruleBlock(home, ".chat-item {");
    expect(item).toContain("background-color: transparent");
    expect(item).not.toContain("border:");
    const selected = ruleBlock(home, ".chat-item-selected {");
    expect(selected).toContain("background-color: var(--color-surface)");
    expect(selected).not.toContain("border:");
    // §3 底部保留原有入口:身份之外菜单/设置仍在
    expect(home).toContain(".sidebar-tail {");
    expect(home).toContain(".sidebar-identity {");
  });
});

describe("V1.5 §3 历史对话:打开与新建", () => {
  test("UI-LIST-01 点击历史行切到该会话,不新造会话", async () => {
    renderChatList();
    await act(settle);

    expect(useChatStore.getState().currentSessionIndex).toBe(0);
    act(() => {
      fireEvent.click(screen.getByText("会话二"));
    });

    const state = useChatStore.getState();
    expect(state.currentSessionIndex).toBe(1);
    expect(state.sessions).toHaveLength(2);
    expect(state.sessions[1].id).toBe("s-2");
  });

  test("UI-LIST-02 顶部『开启新对话』立刻落到新草稿会话", async () => {
    renderSideBar();
    await act(settle);

    act(() => {
      fireEvent.click(buttonOf(Locale.Home.NewChat));
    });
    await act(settle);

    const state = useChatStore.getState();
    expect(state.sessions).toHaveLength(3);
    expect(state.currentSessionIndex).toBe(0);
    expect(state.sessions[0].draft).toBe(true);
  });
});

describe("V1.5 §4 空白首页", () => {
  test("UI-EMPTY-01 空会话只显示居中问候语,没有欢迎卡片墙", async () => {
    seedSessions([fakeSession("s-empty", "新会话")]);
    renderChat();
    await act(settle);

    const hero = document.querySelector('[data-empty-state="true"]');
    expect(hero).toBeTruthy();
    expect(hero?.textContent).toContain(Locale.Store.BotHello);
    expect(screen.getAllByText(Locale.Store.BotHello)).toHaveLength(1);
    expect(inputBox()).toBeTruthy();
    expect(document.querySelector("[data-message-id]")).toBeNull();
  });

  test("UI-EMPTY-02 已有消息后问候语消失,消息列表照常渲染", async () => {
    seedSessions([
      fakeSession("s-full", "有历史的会话", {
        messages: [createMessage({ role: "user", content: "已有消息" })],
      }),
    ]);
    renderChat();
    await act(settle);

    expect(document.querySelector('[data-empty-state="true"]')).toBeNull();
    expect(document.querySelector("[data-message-id]")).toBeTruthy();
    expect(inputBox()).toBeTruthy();
  });
});

describe("V1.5 §5 Composer", () => {
  test("UI-CMP-01 模型选择在卡片底部左侧,附件与发送在右侧", async () => {
    seedSessions([fakeSession("s-empty", "新会话")]);
    renderChat();
    await act(settle);

    const toolbar = composerToolbar();
    const left = toolbar.firstElementChild as HTMLElement;
    const right = toolbar.lastElementChild as HTMLElement;
    expect(left).toBeTruthy();
    expect(right).not.toBe(left);
    expect(left.textContent).toContain(Locale.Chat.ModelSelector.Default);
    expect(right.textContent).toContain(Locale.Chat.InputActions.UploadImage);
    expect(right.textContent).toContain(Locale.Chat.Send);

    const upload = nodeOf(Locale.Chat.InputActions.UploadImage);
    const send = buttonOf(Locale.Chat.Send);
    expect(right.contains(upload)).toBeTruthy();
    expect(right.contains(send)).toBeTruthy();
    expect(left.contains(send)).toBeFalsy();
    expect(
      upload.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("UI-CMP-02 工具条与输入框同处一张卡片,卡片仍是 textarea 的 label", async () => {
    seedSessions([fakeSession("s-empty", "新会话")]);
    renderChat();
    await act(settle);

    const card = composerToolbar().parentElement as HTMLElement;
    expect(card.tagName).toBe("LABEL");
    expect(card.getAttribute("for")).toBe("chat-input");
    expect(card.contains(inputBox())).toBeTruthy();
    // 附件托盘在卡片内、输入框之前(§5:托盘随卡片走,不浮层遮挡)
    expect(card.contains(inputBox())).toBeTruthy();
    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).toBeTruthy();
    expect(card.parentElement?.contains(fileInput as Node)).toBeTruthy();

    const chat = source(CHAT_SCSS);
    const tray = ruleBlock(chat, ".attach-images {");
    expect(tray).toContain("display: flex");
    expect(tray).not.toContain("position: absolute");
  });

  test("UI-CMP-03 Enter 发送、Shift+Enter 只换行(§16 Gate 1)", async () => {
    seedSessions([fakeSession("s-empty", "新会话")]);
    let release!: (v: boolean) => void;
    const onUserInput = jest.fn(
      async (_content: string, _images?: unknown) =>
        new Promise<boolean>((resolve) => (release = resolve)),
    );
    act(() => {
      useChatStore.setState({ onUserInput: onUserInput } as any);
    });
    renderChat();
    await act(settle);

    act(() => {
      fireEvent.input(inputBox(), { target: { value: "改版的草稿" } });
    });

    const newline = fireEvent.keyDown(inputBox(), { key: "Enter", shiftKey: true });
    await act(settle);
    expect(newline).toBe(true); // 未 preventDefault → 浏览器照常插入换行
    expect(onUserInput).not.toHaveBeenCalled();
    expect(inputBox().value).toBe("改版的草稿");

    const submit = fireEvent.keyDown(inputBox(), { key: "Enter", shiftKey: false });
    await act(settle);
    expect(submit).toBe(false); // preventDefault → 不会留下多余空行
    expect(onUserInput).toHaveBeenCalledTimes(1);
    expect(onUserInput.mock.calls[0][0]).toBe("改版的草稿");
    // 发送在途:主按钮禁用,不重复提交
    expect(buttonOf(Locale.Chat.Send).disabled).toBe(true);

    await act(async () => {
      release(true);
      await settle();
    });
    expect(inputBox().value).toBe("");
    expect(buttonOf(Locale.Chat.Send).disabled).toBe(false);
  });

  test("UI-CMP-04 Streaming 中发送键换成停止(§11 在途请求可取消)", async () => {
    seedSessions([
      fakeSession("s-live", "生成中的会话", { pendingRequestId: "req-1" }),
    ]);
    renderChat();
    await act(settle);

    const right = composerToolbar().lastElementChild as HTMLElement;
    expect(right.textContent).toContain(Locale.Chat.InputActions.Stop);
    expect(screen.queryByText(Locale.Chat.Send)).toBeNull();

    const cancel = jest.fn(async () => {});
    act(() => {
      useChatStore.setState({ cancelRequest: cancel } as any);
    });
    await act(settle);
    act(() => {
      fireEvent.click(buttonOf(Locale.Chat.InputActions.Stop));
    });
    expect(cancel).toHaveBeenCalledWith("s-live");

    seedSessions([
      fakeSession("s-live", "生成中的会话", {
        pendingRequestId: "req-1",
        cancelling: true,
      }),
    ]);
    await act(settle);
    expect(buttonOf(Locale.Chat.InputActions.Stop).disabled).toBe(true);
  });

  test("UI-CMP-05 模型选择器搬到 Composer 底部后仍能开菜单选默认(业务逻辑未动)", async () => {
    seedSessions([fakeSession("s-empty", "新会话")]);
    renderChat();
    await act(settle);

    const toolbar = composerToolbar();
    const left = toolbar.firstElementChild as HTMLElement;
    const modelButton = left.querySelector("button");
    expect(modelButton).toBeTruthy();
    act(() => {
      fireEvent.click(modelButton as Element);
    });
    await act(settle);

    const menu = document.querySelector('[role="menu"]');
    expect(menu).toBeTruthy();
    expect(menu?.textContent).toContain(Locale.Chat.ModelSelector.Default);
    // 菜单锚在左列(§5 底部左侧),向上展开以免被视口下沿裁掉
    expect(left.contains(menu)).toBeTruthy();
    const scss = source("app/components/model-selector.module.scss");
    expect(scss).toMatch(/\.anchor-up \.menu \{[^}]*bottom: calc\(100% \+ 4px\)/);
  });

  test("UI-CMP-06 工具条内的动作自带胶囊样式(离开 .chat-input-actions 也不竖排溢出)", () => {
    const chat = source(CHAT_SCSS);
    const action = ruleBlock(
      chat,
      ".chat-input-panel .chat-input-toolbar .chat-input-action {",
    );
    expect(action).toContain("display: inline-flex");
    // 工具条不做 hover 展开,文字必须常驻可见
    expect(action).toMatch(/\.text \{[^}]*opacity: 1/);
  });

  test("UI-CMP-07 输入框有显式无障碍名称(不被包裹的 label 污染)", async () => {
    seedSessions([fakeSession("s-empty", "新会话")]);
    renderChat();
    await act(settle);

    const input = inputBox();
    const label = input.getAttribute("aria-label");
    expect(label).toBeTruthy();
    // 包裹的 <label> 会把工具条文字(模型/上传图片/发送)拼进派生名称
    expect(label).toBe(input.getAttribute("placeholder"));
  });
});

describe("V1.5 §6/§7/§9 布局与配色令牌", () => {
  test("UI-TK-01 对话列 850px 居中,Composer 与空态同列宽", () => {
    const globals = source("app/styles/globals.scss");
    expect(globals).toContain("--chat-column-width: 850px");
    // 亮/暗两套都要有,否则深色模式掉回默认宽度
    expect(globals.split("--chat-column-width: 850px").length - 1).toBeGreaterThanOrEqual(
      2,
    );
    expect(globals).toContain("--message-max-width: 100%");

    const chat = source(CHAT_SCSS);
    for (const selector of [
      ".chat-message {",
      ".chat-message-user {",
      ".chat-input-panel-inner {",
      ".chat-empty-state {",
      ".prompt-hints {",
    ]) {
      expect([selector, ruleBlock(chat, selector).includes("var(--chat-column-width)")]).toEqual(
        [selector, true],
      );
    }
    // 行内消息不再被旧的百分比限宽挤歪
    expect(ruleBlock(chat, ".chat-message {")).toContain("width: 100%");
    expect(chat).toContain("margin-left: auto");
    expect(chat).toContain("margin-right: auto");
  });

  test("UI-TK-02 AI 消息无重气泡、用户消息淡背景 + 中等圆角", () => {
    const chat = source(CHAT_SCSS);
    const item = ruleBlock(chat, ".chat-message-item {");
    expect(item).toContain("background-color: transparent");
    expect(item).toContain("border: none");
    expect(item).toContain("border-radius: var(--bubble-radius)");

    const user = ruleBlock(
      chat,
      ".chat-message-user > .chat-message-container > .chat-message-item {",
    );
    expect(user).toContain("var(--color-bubble-user)");
    expect(user).not.toContain("box-shadow");
  });

  test("UI-TK-03 Composer 圆角 20–24px、淡边框淡阴影,不用重阴影", () => {
    const globals = source("app/styles/globals.scss");
    const radius = Number(globals.match(/--composer-radius:\s*(\d+)px/)![1]);
    expect(radius).toBeGreaterThanOrEqual(20);
    expect(radius).toBeLessThanOrEqual(24);

    const chat = source(CHAT_SCSS);
    const inner = ruleBlock(chat, ".chat-input-panel-inner {");
    expect(inner).toContain("border-radius: var(--composer-radius)");
    expect(inner).toContain("border: 1px solid var(--color-line)");
    expect(inner).toContain("box-shadow: var(--shadow-soft)");
    expect(inner).not.toContain("box-shadow: var(--shadow)");
  });

  test("UI-TK-04 Composer 排在滚动区之后、非浮层,天然不遮最后一条消息", () => {
    const chat = source(CHAT_SCSS);
    const panel = ruleBlock(chat, ".chat-input-panel {");
    expect(panel).toContain("position: relative");
    expect(panel).not.toContain("position: absolute");
    expect(panel).not.toContain("position: fixed");
    expect(panel).not.toContain("overflow-x");

    const tsx = source("app/components/chat.tsx");
    expect(tsx.indexOf('styles["chat-body"]')).toBeLessThan(
      tsx.indexOf('styles["chat-input-panel"]'),
    );
    expect(tsx).not.toContain("position: sticky");
  });

  test("UI-TK-05 配色是浅色留白系:三档底色 + 淡分隔线,无渐变/霓虹", () => {
    const globals = source("app/styles/globals.scss");
    for (const token of [
      "--color-canvas",
      "--color-sidebar",
      "--color-surface",
      "--color-surface-soft",
      "--color-bubble-user",
      "--color-line",
      "--shadow-soft",
    ]) {
      expect(globals).toContain(token);
    }
    const chat = source(CHAT_SCSS);
    for (const selector of [
      ".chat-message-item {",
      ".chat-input-panel-inner {",
      ".chat-empty-state {",
    ]) {
      expect([selector, ruleBlock(chat, selector).includes("gradient")]).toEqual([
        selector,
        false,
      ]);
    }
    expect(source(HOME_SCSS)).not.toContain("linear-gradient");
  });
});

describe("V1.5 §10 移动端", () => {
  afterEach(() => {
    setViewport(DESKTOP_WIDTH);
  });

  test("UI-MB-01 窄屏聊天页给回列表按钮,Composer 仍完整可用", async () => {
    setViewport(390);
    seedSessions([fakeSession("s-empty", "新会话")]);
    renderChat();
    await act(settle);

    expect(screen.getByTitle(Locale.Chat.Actions.ChatList)).toBeTruthy();
    expect(screen.queryByText(Locale.Chat.Rename)).toBeNull();
    expect(inputBox()).toBeTruthy();
    expect(composerToolbar()).toBeTruthy();
    expect(screen.getByText(Locale.Chat.Send)).toBeTruthy();
  });

  test("UI-MB-02 窄屏 Sidebar 满屏宽度,不挤出不满屏的空隙", async () => {
    setViewport(390);
    renderSideBar();
    await act(settle);

    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe(
      "100vw",
    );
  });

  test("UI-MB-03 移动端输入框 16px 字号(iOS 不自动放大)", async () => {
    const chat = source(CHAT_SCSS);
    expect(chat).toContain("@media only screen and (max-width: 600px)");
    expect(chat).toMatch(/\.chat-input \{\s*\n\s*font-size: 16px;/);

    // 内联样式会盖掉上面的媒体查询,真正生效的是组件里的窄屏下限
    seedSessions([fakeSession("s-empty", "新会话")]);
    setViewport(390);
    const mobile = renderChat();
    await act(settle);
    expect(inputBox().style.fontSize).toBe("16px");

    mobile.unmount();
    setViewport(DESKTOP_WIDTH);
    renderChat();
    await act(settle);
    expect(inputBox().style.fontSize).toBe(
      `${useAppConfig.getState().fontSize}px`,
    );
  });
});
