import { useDebouncedCallback } from "use-debounce";
import React, {
  Fragment,
  RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import SendWhiteIcon from "../icons/send-white.svg";
import PauseIcon from "../icons/pause.svg";
import RenameIcon from "../icons/rename.svg";
import ExportIcon from "../icons/share.svg";
import ReturnIcon from "../icons/return.svg";
import CopyIcon from "../icons/copy.svg";
import LoadingIcon from "../icons/three-dots.svg";
import PromptIcon from "../icons/prompt.svg";
import MaxIcon from "../icons/max.svg";
import MinIcon from "../icons/min.svg";
import ReloadIcon from "../icons/reload.svg";
import ConfirmIcon from "../icons/confirm.svg";

import LightIcon from "../icons/light.svg";
import DarkIcon from "../icons/dark.svg";
import AutoIcon from "../icons/auto.svg";
import BottomIcon from "../icons/bottom.svg";
import ShortcutkeyIcon from "../icons/shortcutkey.svg";
import ArchiveIcon from "../icons/archive.svg";
import ImageIcon from "../icons/image.svg";
import DeleteIcon from "../icons/clear.svg";
import {
  ChatMessage,
  createMessage,
  getDefaultTopic,
  errorTextForCode,
  SubmitKey,
  Theme,
  useAppConfig,
  useChatStore,
} from "../store";

import {
  autoGrowTextArea,
  copyToClipboard,
  getMessageImages,
  getMessageTextContent,
  safeLocalStorage,
  useMobileScreen,
} from "../utils";

import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_TOTAL_MAX_FINAL_BYTES,
  AttachmentPrepareError,
  PendingImage,
  prepareAttachment,
} from "../utils/attachment";

import dynamic from "next/dynamic";

import { Prompt, usePromptStore } from "../store/prompt";
import Locale from "../locales";

import { IconButton } from "./button";
import styles from "./chat.module.scss";

import { Modal, showImageModal, showPrompt, showToast } from "./ui-lib";
import { ModelSelectorButton } from "./model-selector";
import { BrowserStatusButton } from "./browser-status";
import { useNavigate } from "react-router-dom";
import { CHAT_PAGE_SIZE, Path, UNFINISHED_INPUT } from "../constant";
import { Avatar } from "./emoji";
import { MaskAvatar } from "./mask";
import { ChatCommandPrefix, useChatCommand, useCommand } from "../command";
import { ExportMessageModal } from "./exporter";
import { getClientConfig } from "../config/client";

import clsx from "clsx";

const localStorage = safeLocalStorage();

const Markdown = dynamic(async () => (await import("./markdown")).Markdown, {
  loading: () => <LoadingIcon />,
});

/** PAG-2 §23.1:历史分页锚定状态机(废弃 shift-window,唯一 phase 集合) */
export type PendingHistoryAnchor = {
  sessionId: string;
  requestedCursor: string;
  oldFirstMessageId: string;
  messageId: string;
  relativeTop: number;
  prependedCount: number;
  phase: "awaiting-prepend" | "restore-anchor";
};

/**
 * §23.1 锚定 ref 真正跨越 async loadOlderMessages 存活;模块级持有
 * (_Chat 经 <_Chat key={session.id}> 同时仅一个实例,随重挂载整体销毁)
 */
export const pendingHistoryAnchorRef: {
  current: PendingHistoryAnchor | null;
} = { current: null };

/**
 * PAG2-FIX-01:冷启动 history window 初始化状态机。
 * waiting=mount 时消息链未建,等 loaded;aligning=消息就绪,正把
 * msgRenderIndex+DOM 对齐 latest window;ready=对齐完成,原 PAG-2 逻辑接管。
 * 只描述本组件 incarnation 的首次初始化,ready 即终态,仅 remount 重来。
 */
type HistoryWindowInitPhase = "waiting" | "aligning" | "ready";

function useSubmitHandler() {
  const config = useAppConfig();
  const submitKey = config.submitKey;
  const isComposing = useRef(false);

  useEffect(() => {
    const onCompositionStart = () => {
      isComposing.current = true;
    };
    const onCompositionEnd = () => {
      isComposing.current = false;
    };

    window.addEventListener("compositionstart", onCompositionStart);
    window.addEventListener("compositionend", onCompositionEnd);

    return () => {
      window.removeEventListener("compositionstart", onCompositionStart);
      window.removeEventListener("compositionend", onCompositionEnd);
    };
  }, []);

  const shouldSubmit = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Fix Chinese input method "Enter" on Safari
    if (e.keyCode == 229) return false;
    if (e.key !== "Enter") return false;
    if (e.key === "Enter" && (e.nativeEvent.isComposing || isComposing.current))
      return false;
    return (
      (config.submitKey === SubmitKey.AltEnter && e.altKey) ||
      (config.submitKey === SubmitKey.CtrlEnter && e.ctrlKey) ||
      (config.submitKey === SubmitKey.ShiftEnter && e.shiftKey) ||
      (config.submitKey === SubmitKey.MetaEnter && e.metaKey) ||
      (config.submitKey === SubmitKey.Enter &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.metaKey)
    );
  };

  return {
    submitKey,
    shouldSubmit,
  };
}

export type RenderPrompt = Pick<Prompt, "title" | "content">;

export function PromptHints(props: {
  prompts: RenderPrompt[];
  onPromptSelect: (prompt: RenderPrompt) => void;
}) {
  const noPrompts = props.prompts.length === 0;
  const [selectIndex, setSelectIndex] = useState(0);
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectIndex(0);
  }, [props.prompts.length]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (noPrompts || e.metaKey || e.altKey || e.ctrlKey) {
        return;
      }
      // arrow up / down to select prompt
      const changeIndex = (delta: number) => {
        e.stopPropagation();
        e.preventDefault();
        const nextIndex = Math.max(
          0,
          Math.min(props.prompts.length - 1, selectIndex + delta),
        );
        setSelectIndex(nextIndex);
        selectedRef.current?.scrollIntoView({
          block: "center",
        });
      };

      if (e.key === "ArrowUp") {
        changeIndex(1);
      } else if (e.key === "ArrowDown") {
        changeIndex(-1);
      } else if (e.key === "Enter") {
        const selectedPrompt = props.prompts.at(selectIndex);
        if (selectedPrompt) {
          props.onPromptSelect(selectedPrompt);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.prompts.length, selectIndex]);

  if (noPrompts) return null;
  return (
    <div className={styles["prompt-hints"]}>
      {props.prompts.map((prompt, i) => (
        <div
          ref={i === selectIndex ? selectedRef : null}
          className={clsx(styles["prompt-hint"], {
            [styles["prompt-hint-selected"]]: i === selectIndex,
          })}
          key={prompt.title + i.toString()}
          onClick={() => props.onPromptSelect(prompt)}
          onMouseEnter={() => setSelectIndex(i)}
        >
          <div className={styles["hint-title"]}>{prompt.title}</div>
          <div className={styles["hint-content"]}>{prompt.content}</div>
        </div>
      ))}
    </div>
  );
}

export function ChatAction(props: {
  text: string;
  icon: JSX.Element;
  onClick: () => void;
}) {
  const iconRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState({
    full: 16,
    icon: 16,
  });

  function updateWidth() {
    if (!iconRef.current || !textRef.current) return;
    const getWidth = (dom: HTMLDivElement) => dom.getBoundingClientRect().width;
    const textWidth = getWidth(textRef.current);
    const iconWidth = getWidth(iconRef.current);
    setWidth({
      full: textWidth + iconWidth,
      icon: iconWidth,
    });
  }

  return (
    <div
      className={clsx(styles["chat-input-action"], "clickable")}
      onClick={() => {
        props.onClick();
        setTimeout(updateWidth, 1);
      }}
      onMouseEnter={updateWidth}
      onTouchStart={updateWidth}
      style={
        {
          "--icon-width": `${width.icon}px`,
          "--full-width": `${width.full}px`,
        } as React.CSSProperties
      }
    >
      <div ref={iconRef} className={styles["icon"]}>
        {props.icon}
      </div>
      <div className={styles["text"]} ref={textRef}>
        {props.text}
      </div>
    </div>
  );
}

function useScrollToBottom(
  scrollRef: RefObject<HTMLDivElement>,
  detach: boolean = false,
  messages: ChatMessage[],
) {
  // for auto-scroll
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollDomToBottom = useCallback(() => {
    const dom = scrollRef.current;
    if (dom) {
      requestAnimationFrame(() => {
        setAutoScroll(true);
        dom.scrollTo(0, dom.scrollHeight);
      });
    }
  }, [scrollRef]);

  // auto scroll
  useEffect(() => {
    if (autoScroll && !detach) {
      scrollDomToBottom();
    }
  });

  // auto scroll when messages append(PAG-2 §24:length-effect 收窄为 append-only ——
  // 判定:旧数组为空,或新数组首条 id 与旧数组首条 id 相同;prepend 历史不得拉底)
  const lastMessagesLength = useRef(messages.length);
  const lastFirstMessageId = useRef(messages[0]?.id);
  useEffect(() => {
    const appendedOnly =
      lastMessagesLength.current === 0 ||
      messages[0]?.id === lastFirstMessageId.current;
    if (
      messages.length > lastMessagesLength.current &&
      appendedOnly &&
      !detach
    ) {
      scrollDomToBottom();
    }
    lastMessagesLength.current = messages.length;
    lastFirstMessageId.current = messages[0]?.id;
  }, [messages.length, detach, scrollDomToBottom]);

  return {
    scrollRef,
    autoScroll,
    setAutoScroll,
    scrollDomToBottom,
  };
}

export function ChatActions(props: {
  scrollToBottom: () => void;
  showPromptHints: () => void;
  hitBottom: boolean;
  setShowShortcutKeyModal: React.Dispatch<React.SetStateAction<boolean>>;
  uploadImage?: () => void;
  uploadDisabled?: boolean;
  uploadInProgress?: boolean;
}) {
  const config = useAppConfig();

  // switch themes
  const theme = config.theme;

  function nextTheme() {
    const themes = [Theme.Auto, Theme.Light, Theme.Dark];
    const themeIndex = themes.indexOf(theme);
    const nextIndex = (themeIndex + 1) % themes.length;
    const nextTheme = themes[nextIndex];
    config.update((config) => (config.theme = nextTheme));
  }

  const isMobileScreen = useMobileScreen();

  return (
    <div className={styles["chat-input-actions"]}>
      <>
        {props.uploadImage && (
          <ChatAction
            onClick={() => {
              if (props.uploadDisabled) return;
              props.uploadImage?.();
            }}
            text={
              props.uploadInProgress
                ? Locale.Chat.ImagePreparing
                : Locale.Chat.InputActions.UploadImage
            }
            icon={<ImageIcon />}
          />
        )}
        {!props.hitBottom && (
          <ChatAction
            onClick={props.scrollToBottom}
            text={Locale.Chat.InputActions.ToBottom}
            icon={<BottomIcon />}
          />
        )}
        <ChatAction
          onClick={nextTheme}
          text={Locale.Chat.InputActions.Theme[theme]}
          icon={
            <>
              {theme === Theme.Auto ? (
                <AutoIcon />
              ) : theme === Theme.Light ? (
                <LightIcon />
              ) : theme === Theme.Dark ? (
                <DarkIcon />
              ) : null}
            </>
          }
        />

        <ChatAction
          onClick={props.showPromptHints}
          text={Locale.Chat.InputActions.Prompt}
          icon={<PromptIcon />}
        />

        {!isMobileScreen && (
          <ChatAction
            onClick={() => props.setShowShortcutKeyModal(true)}
            text={Locale.Chat.ShortcutKey.Title}
            icon={<ShortcutkeyIcon />}
          />
        )}
      </>
    </div>
  );
}

export function ShortcutKeyModal(props: { onClose: () => void }) {
  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const shortcuts = [
    {
      title: Locale.Chat.ShortcutKey.newChat,
      keys: isMac ? ["⌘", "Shift", "O"] : ["Ctrl", "Shift", "O"],
    },
    { title: Locale.Chat.ShortcutKey.focusInput, keys: ["Shift", "Esc"] },
    {
      title: Locale.Chat.ShortcutKey.copyLastCode,
      keys: isMac ? ["⌘", "Shift", ";"] : ["Ctrl", "Shift", ";"],
    },
    {
      title: Locale.Chat.ShortcutKey.copyLastMessage,
      keys: isMac ? ["⌘", "Shift", "C"] : ["Ctrl", "Shift", "C"],
    },
    {
      title: Locale.Chat.ShortcutKey.showShortcutKey,
      keys: isMac ? ["⌘", "/"] : ["Ctrl", "/"],
    },
  ];
  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Chat.ShortcutKey.Title}
        onClose={props.onClose}
        actions={[
          <IconButton
            type="primary"
            text={Locale.UI.Confirm}
            icon={<ConfirmIcon />}
            key="ok"
            onClick={() => {
              props.onClose();
            }}
          />,
        ]}
      >
        <div className={styles["shortcut-key-container"]}>
          <div className={styles["shortcut-key-grid"]}>
            {shortcuts.map((shortcut, index) => (
              <div key={index} className={styles["shortcut-key-item"]}>
                <div className={styles["shortcut-key-title"]}>
                  {shortcut.title}
                </div>
                <div className={styles["shortcut-key-keys"]}>
                  {shortcut.keys.map((key, i) => (
                    <div key={i} className={styles["shortcut-key"]}>
                      <span>{key}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
}

/**
 * I3/H1:附件 owner 身份(区分 PROMOTION / SWITCH,禁止只靠 [session.id])。
 * 状态全部放外层 Chat(keyed _Chat 之外),经 props 传给 _Chat。
 */
type AttachmentOwner = {
  sessionId: string;
  currentSessionIndex: number;
  wasDraft: boolean;
};

/** I3:outer Chat → _Chat 的附件 composer props 组(H1;gate/epoch 全在 outer 实现) */
export type AttachmentController = {
  pendingImages: PendingImage[];
  isPreparingImages: boolean;
  isSubmittingMessage: boolean;
  addFiles: (files: FileList | File[]) => void;
  removeAt: (id: string) => void;
  submit: (text: string) => void;
};

/** I3-B:I3-A 支持集的派生视图(唯一真值仍是 utils/attachment.ts ATTACHMENT_ACCEPT) */
const ACCEPTED_ATTACHMENT_MIME_TYPES = new Set(ATTACHMENT_ACCEPT.split(","));

/** I3-B:clipboard File 允许空名,空名补名表(仅 I3-A 支持 MIME;F9 名实相符) */
const PASTE_IMAGE_NAME_BY_MIME = new Map<string, string>([
  ["image/png", "paste-image.png"],
  ["image/jpeg", "paste-image.jpg"],
  ["image/webp", "paste-image.webp"],
  ["image/gif", "paste-image.gif"],
]);

/** I3-B:剪贴板 → File[](只做事件源适配;最终 MIME 校验在 prepareAttachment) */
function extractClipboardImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (let index = 0; index < data.items.length; index += 1) {
    const item = data.items[index];
    if (item.kind !== "file" || !item.type.toLowerCase().startsWith("image/")) {
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

function normalizeClipboardImageNames(files: File[]): File[] {
  return files.map((file) => {
    if (file.name !== "") return file;
    const fallbackName = PASTE_IMAGE_NAME_BY_MIME.get(file.type.toLowerCase());
    if (fallbackName === undefined) return file;
    return new File([file], fallbackName, {
      type: file.type,
      lastModified: file.lastModified,
    });
  });
}

function _Chat(props: { attachment: AttachmentController }) {
  const attachment = props.attachment;
  type RenderMessage = ChatMessage & { preview?: boolean };

  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const config = useAppConfig();
  const fontSize = config.fontSize;
  const fontFamily = config.fontFamily;

  const [showExport, setShowExport] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [userInput, setUserInput] = useState("");
  const { submitKey, shouldSubmit } = useSubmitHandler();
  const scrollRef = useRef<HTMLDivElement>(null);
  const isScrolledToBottom = scrollRef?.current
    ? Math.abs(
        scrollRef.current.scrollHeight -
          (scrollRef.current.scrollTop + scrollRef.current.clientHeight),
      ) <= 1
    : false;
  const isAttachWithTop = useMemo(() => {
    const lastMessage = scrollRef.current?.lastElementChild as HTMLElement;
    // if scrolllRef is not ready or no message, return false
    if (!scrollRef?.current || !lastMessage) return false;
    const topDistance =
      lastMessage!.getBoundingClientRect().top -
      scrollRef.current.getBoundingClientRect().top;
    // leave some space for user question
    return topDistance < 100;
  }, [scrollRef?.current?.scrollHeight]);

  const isTyping = userInput !== "";

  // if user is typing, should auto scroll to bottom
  // if user is not typing, should auto scroll to bottom only if already at bottom
  const { setAutoScroll, scrollDomToBottom } = useScrollToBottom(
    scrollRef,
    (isScrolledToBottom || isAttachWithTop) && !isTyping,
    session.messages,
  );
  const [hitBottom, setHitBottom] = useState(true);
  const isMobileScreen = useMobileScreen();
  const navigate = useNavigate();

  // prompt hints
  const promptStore = usePromptStore();
  const [promptHints, setPromptHints] = useState<RenderPrompt[]>([]);
  const onSearch = useDebouncedCallback(
    (text: string) => {
      const matchedPrompts = promptStore.search(text);
      setPromptHints(matchedPrompts);
    },
    100,
    { leading: true, trailing: true },
  );

  // auto grow input
  const [inputRows, setInputRows] = useState(2);
  const measure = useDebouncedCallback(
    () => {
      const rows = inputRef.current ? autoGrowTextArea(inputRef.current) : 1;
      const inputRows = Math.min(
        20,
        Math.max(2 + Number(!isMobileScreen), rows),
      );
      setInputRows(inputRows);
    },
    100,
    {
      leading: true,
      trailing: true,
    },
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(measure, [userInput]);

  // chat commands shortcuts
  const chatCommands = useChatCommand({
    new: () => chatStore.newSession(),
    newm: () => navigate(Path.NewChat),
    prev: () => chatStore.nextSession(-1),
    next: () => chatStore.nextSession(1),
    del: () => chatStore.deleteSession(chatStore.currentSessionIndex),
  });

  // only search prompts when user input is short
  const SEARCH_TEXT_LIMIT = 30;
  const onInput = (text: string) => {
    setUserInput(text);
    const n = text.trim().length;

    // clear search results
    if (n === 0) {
      setPromptHints([]);
    } else if (text.match(ChatCommandPrefix)) {
      setPromptHints(chatCommands.search(text));
    } else if (!config.disablePromptHint && n < SEARCH_TEXT_LIMIT) {
      // check if need to trigger auto completion
      if (text.startsWith("/")) {
        let searchText = text.slice(1);
        onSearch(searchText);
      }
    }
  };

  // I3-B:三阶段 gate —— picker(uploadDisabled)与 paste 共用同一判据
  const attachmentDisabled =
    attachment.isPreparingImages ||
    attachment.isSubmittingMessage ||
    session.pendingRequestId !== undefined;

  // I3-B:粘贴图片 = 纯适配层;校验/压缩/限额/epoch 全在 I3-A addFiles 链路。
  // gate 命中时不收图也不 preventDefault(文字仍走浏览器默认粘贴);
  // 仅 supported image 获得「图片优先」(unsupported 交给 prepareAttachment 拒绝,
  // 不得连带吞掉剪贴板文本)。
  const onPasteImages = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (attachmentDisabled) return;
    const files = normalizeClipboardImageNames(
      extractClipboardImages(event.clipboardData),
    );
    if (files.length === 0) return;
    const hasSupportedImage = files.some((file) =>
      ACCEPTED_ATTACHMENT_MIME_TYPES.has(file.type.toLowerCase()),
    );
    if (hasSupportedImage) {
      event.preventDefault();
    }
    attachment.addFiles(files);
  };

  const doSubmit = (userInput: string) => {
    // I3/R23:准备中 / POST 在途守卫(真拦截在 outer submit 的 submittingRef);
    // 联合判据:文本 ∨ 附件至少一个(纯图 content="")
    if (attachment.isPreparingImages) return;
    if (attachment.isSubmittingMessage) return;
    if (userInput.trim() === "" && attachment.pendingImages.length === 0)
      return;
    // §39:command 仅在文本非空时尝试(纯图不得进入 command parser,现序不变)
    if (userInput.trim() !== "") {
      const matchCommand = chatCommands.match(userInput);
      if (matchCommand.matched) {
        setUserInput("");
        setPromptHints([]);
        matchCommand.invoke();
        return;
      }
    }
    attachment.submit(userInput);
    chatStore.setLastInput(userInput);
    setUserInput("");
    setPromptHints([]);
    if (!isMobileScreen) inputRef.current?.focus();
    setAutoScroll(true);
  };

  const onPromptSelect = (prompt: RenderPrompt) => {
    setTimeout(() => {
      setPromptHints([]);

      const matchedChatCommand = chatCommands.match(prompt.content);
      if (matchedChatCommand.matched) {
        // if user is selecting a chat command, just trigger it
        matchedChatCommand.invoke();
        setUserInput("");
      } else {
        // or fill the prompt
        setUserInput(prompt.content);
      }
      inputRef.current?.focus();
    }, 30);
  };

  // check if should send message
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // if ArrowUp and no userInput, fill with last input
    if (
      e.key === "ArrowUp" &&
      userInput.length <= 0 &&
      !(e.metaKey || e.altKey || e.ctrlKey)
    ) {
      setUserInput(chatStore.lastInput ?? "");
      e.preventDefault();
      return;
    }
    if (shouldSubmit(e) && promptHints.length === 0) {
      doSubmit(userInput);
      e.preventDefault();
    }
  };
  // 历史消息完全来自后端,不再注入本地 context 与 BOT_HELLO 占位:
  // 空会话就是空的,首条回答由后端建 Conversation 后才出现。
  const renderMessages = useMemo(() => {
    return (session.messages as RenderMessage[]).concat(
      userInput.length > 0 && config.sendPreviewBubble
        ? [
            {
              ...createMessage({
                role: "user",
                content: userInput,
              }),
              preview: true,
            },
          ]
        : [],
    );
  }, [config.sendPreviewBubble, session.messages, userInput]);

  const [msgRenderIndex, _setMsgRenderIndex] = useState(
    Math.max(0, renderMessages.length - CHAT_PAGE_SIZE),
  );

  function setMsgRenderIndex(newIndex: number) {
    newIndex = Math.min(renderMessages.length - CHAT_PAGE_SIZE, newIndex);
    newIndex = Math.max(0, newIndex);
    _setMsgRenderIndex(newIndex);
  }

  // PAG2-FIX-01:已 loaded 的会话 mount(如 A→B→A)初始即 aligning;
  // 冷启动(loaded=false)从 waiting 开始,等 store 建链
  const [historyWindowInitPhase, setHistoryWindowInitPhase] =
    useState<HistoryWindowInitPhase>(session.loaded ? "aligning" : "waiting");

  const messages = useMemo(() => {
    const endRenderIndex = Math.min(
      msgRenderIndex + 3 * CHAT_PAGE_SIZE,
      renderMessages.length,
    );
    return renderMessages.slice(msgRenderIndex, endRenderIndex);
  }, [msgRenderIndex, renderMessages]);

  // PAG-2 §21:IO 回调读取镜像,七条件之四(msgRenderIndex===0)在触发时复核
  const msgRenderIndexRef = useRef(msgRenderIndex);
  msgRenderIndexRef.current = msgRenderIndex;

  // PAG-2 §25:顶部三态 + 隐形 sentinel 的可见性(cursor!==null 是全部三态前提)
  // PAG2-FIX-01:初始化未 ready 前不挂 sentinel/IO —— msgRenderIndex 尚未
  // 对齐 latest window 时,即使七条件表面成立也不允许 history 分页启动
  const hasHistoryMore =
    !session.draft && session.loaded && session.messageNextCursor !== null;
  const historySentinelVisible =
    historyWindowInitPhase === "ready" &&
    hasHistoryMore &&
    msgRenderIndex === 0 &&
    !session.loadingOlderMessages &&
    !session.messageHistoryError;

  // PAG-2 §23.2:IO / Retry 唯一写入口 —— 请求前写入 anchor,跨 async 存活
  async function requestOlderMessages(fromRetry = false) {
    const container = scrollRef.current;
    if (!container) return;
    const target = useChatStore
      .getState()
      .sessions.find((s) => s.id === session.id);
    if (
      !target ||
      target.draft ||
      !target.loaded ||
      target.messageNextCursor === null ||
      target.loadingOlderMessages
    ) {
      return;
    }
    if (!fromRetry && target.messageHistoryError) return;
    if (msgRenderIndexRef.current !== 0) return;
    const firstPersisted = target.messages.find(
      (m) => m.position !== undefined,
    );
    if (!firstPersisted) return;
    const anchorEl = container.querySelector(
      `[data-message-id="${firstPersisted.id}"]`,
    );
    if (!anchorEl) return;
    const anchor: PendingHistoryAnchor = {
      sessionId: target.id,
      requestedCursor: target.messageNextCursor,
      oldFirstMessageId: firstPersisted.id,
      messageId: firstPersisted.id,
      relativeTop:
        anchorEl.getBoundingClientRect().top -
        container.getBoundingClientRect().top,
      prependedCount: 0,
      phase: "awaiting-prepend",
    };
    pendingHistoryAnchorRef.current = anchor;
    const result = await useChatStore.getState().loadOlderMessages(target.id);
    if (!result.applied || result.prependedCount === 0) {
      // §23.4 一/二/六:失败/stale/guard no-op/空页;身份校验,不误清新一轮
      if (pendingHistoryAnchorRef.current === anchor) {
        pendingHistoryAnchorRef.current = null;
      }
    }
  }

  // PAG-2 §21:IntersectionObserver(root=.chat-body,顶部 300px 预载);
  // sentinel 仅在七条件成立时渲染,msgRenderIndex>0 时窗口滑动零请求
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        void requestOlderMessages();
      },
      { root: scrollRef.current, rootMargin: "300px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historySentinelVisible]);

  // PAG-2 §23.3:two-phase useLayoutEffect(每次 commit 都跑,由 phase 状态机驱动)
  useLayoutEffect(() => {
    const pending = pendingHistoryAnchorRef.current;
    if (!pending || pending.sessionId !== session.id) return;
    if (pending.phase === "awaiting-prepend") {
      // Phase 1 唯一依据 = messages 本身(REVIEW-25),精确计算 prepend 数
      const prependCount = session.messages
        .filter((m) => m.position !== undefined)
        .findIndex((m) => m.id === pending.oldFirstMessageId);
      if (prependCount > 0) {
        pending.prependedCount = prependCount;
        pending.phase = "restore-anchor";
        setMsgRenderIndex(msgRenderIndex + prependCount); // 主补偿 §22
        return; // 本 commit 不做任何 DOM 修正
      }
      if (prependCount === -1) {
        pendingHistoryAnchorRef.current = null; // §23.4 五:原链被 latest gap/reset 替换
      }
      // ===0:send append / SSE patch / loadOlder 仍在飞,Phase 1 不区分、无 UI 副作用
      return;
    }
    // phase === "restore-anchor":第二次 commit,paint 前同步修正
    const container = scrollRef.current;
    if (!container) return;
    const el = container.querySelector(
      `[data-message-id="${pending.messageId}"]`,
    );
    if (el) {
      const newRelativeTop =
        el.getBoundingClientRect().top - container.getBoundingClientRect().top;
      container.scrollTop += newRelativeTop - pending.relativeTop;
    } else {
      // §23.4:anchor 不在窗口 → 降级,记日志,不做猜测性 scrollTop 修正
      console.debug("[Chat] history anchor not in window", pending.messageId);
    }
    pendingHistoryAnchorRef.current = null;
  });

  // PAG2-FIX-01 Phase1:loaded 翻转后先以正确 msgRenderIndex 重新 commit 一次
  // DOM;此处不做 history IO、不依赖 IntersectionObserver、不执行 loadOlder
  useLayoutEffect(() => {
    if (historyWindowInitPhase !== "waiting" || !session.loaded) return;
    setMsgRenderIndex(Math.max(0, renderMessages.length - CHAT_PAGE_SIZE));
    setHistoryWindowInitPhase("aligning");
  });

  // PAG2-FIX-01 Phase2:latest window 已 commit,对 .chat-body 做一次初始
  // 贴底并打开 gate。ready 后不再重入,refresh/SSE/append/loadOlder 均无副作用
  useLayoutEffect(() => {
    if (historyWindowInitPhase !== "aligning") return;
    const latestWindowIndex = Math.max(
      0,
      renderMessages.length - CHAT_PAGE_SIZE,
    );
    if (msgRenderIndex !== latestWindowIndex) {
      // 对齐期间窗口又漂移(如 preview 气泡)→ 以当前 length 再对齐一次
      setMsgRenderIndex(latestWindowIndex);
      return;
    }
    const dom = scrollRef.current;
    if (dom) {
      dom.scrollTo(0, dom.scrollHeight);
    }
    setAutoScroll(true);
    setHitBottom(true);
    setHistoryWindowInitPhase("ready");
  });

  // PAG-2 §27.2 Header displayedCount 公式(REVIEW-14/17):
  // draft / 未建链 → 本地可见条数(禁 0+2 冒充);建链 → totalCount + 本地 transient
  const localTransientCount = session.messages.filter(
    (m) => m.position === undefined,
  ).length;
  const historyTotalCount =
    session.draft || !session.loaded
      ? session.messages.length
      : session.messageTotalCount + localTransientCount;

  // PAG-2 §27.1 Export 独立 snapshot 接线:组件态持有 prepared snapshot,
  // 不写回 ChatStore;preparingExport 期间按钮 disabled 防重复点击
  const [preparingExport, setPreparingExport] = useState(false);
  const [preparedExportMessages, setPreparedExportMessages] = useState<
    ChatMessage[]
  >([]);

  async function onExport() {
    if (preparingExport) return;
    setPreparingExport(true);
    try {
      const snapshot = await chatStore.prepareMessagesForExport(session.id);
      setPreparedExportMessages(snapshot);
      setShowExport(true);
    } catch (error) {
      console.error("[Export] ", error);
      showToast(Locale.Chat.ExportFailed);
    } finally {
      setPreparingExport(false);
    }
  }

  const onChatBodyScroll = (e: HTMLElement) => {
    const bottomHeight = e.scrollTop + e.clientHeight;
    const edgeThreshold = e.clientHeight;

    const isTouchTopEdge = e.scrollTop <= edgeThreshold;
    const isTouchBottomEdge = bottomHeight >= e.scrollHeight - edgeThreshold;
    const isHitBottom =
      bottomHeight >= e.scrollHeight - (isMobileScreen ? 4 : 10);

    const prevPageMsgIndex = msgRenderIndex - CHAT_PAGE_SIZE;
    const nextPageMsgIndex = msgRenderIndex + CHAT_PAGE_SIZE;

    if (isTouchTopEdge && !isTouchBottomEdge) {
      setMsgRenderIndex(prevPageMsgIndex);
    } else if (isTouchBottomEdge) {
      setMsgRenderIndex(nextPageMsgIndex);
    }

    setHitBottom(isHitBottom);
    setAutoScroll(isHitBottom);
  };

  function scrollToBottom() {
    setMsgRenderIndex(renderMessages.length - CHAT_PAGE_SIZE);
    scrollDomToBottom();
  }

  async function renameCurrentSession() {
    const title = await showPrompt(Locale.Chat.Rename, session.topic);
    if (title) {
      await chatStore.renameSession(session.id, title);
    }
  }

  function toggleArchiveSession() {
    const index = chatStore.sessions.findIndex((s) => s.id === session.id);
    if (index < 0) return;
    if (session.conversationStatus === "ARCHIVED") {
      chatStore.restoreSession(index);
    } else {
      chatStore.archiveSession(index);
    }
  }

  const clientConfig = useMemo(() => getClientConfig(), []);

  const autoFocus = !isMobileScreen; // wont auto focus on mobile screen
  const showMaxIcon = !isMobileScreen && !clientConfig?.isApp;

  useCommand({
    fill: setUserInput,
    submit: (text) => {
      doSubmit(text);
    },
  });

  // remember unfinished input
  useEffect(() => {
    // try to load from local storage
    const key = UNFINISHED_INPUT(session.id);
    const mayBeUnfinishedInput = localStorage.getItem(key);
    if (mayBeUnfinishedInput && userInput.length === 0) {
      setUserInput(mayBeUnfinishedInput);
      localStorage.removeItem(key);
    }

    const dom = inputRef.current;
    return () => {
      localStorage.setItem(key, dom?.value ?? "");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 快捷键 shortcut keys
  const [showShortcutKeyModal, setShowShortcutKeyModal] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // 打开新聊天 command + shift + o
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "o"
      ) {
        event.preventDefault();
        setTimeout(() => {
          chatStore.newSession();
          navigate(Path.Chat);
        }, 10);
      }
      // 聚焦聊天输入 shift + esc
      else if (event.shiftKey && event.key.toLowerCase() === "escape") {
        event.preventDefault();
        inputRef.current?.focus();
      }
      // 复制最后一个代码块 command + shift + ;
      else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.code === "Semicolon"
      ) {
        event.preventDefault();
        const copyCodeButton =
          document.querySelectorAll<HTMLElement>(".copy-code-button");
        if (copyCodeButton.length > 0) {
          copyCodeButton[copyCodeButton.length - 1].click();
        }
      }
      // 复制最后一个回复 command + shift + c
      else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "c"
      ) {
        event.preventDefault();
        const lastNonUserMessage = messages
          .filter((message) => message.role !== "user")
          .pop();
        if (lastNonUserMessage) {
          const lastMessageContent = getMessageTextContent(lastNonUserMessage);
          copyToClipboard(lastMessageContent);
        }
      }
      // 展示快捷键 command + /
      else if ((event.metaKey || event.ctrlKey) && event.key === "/") {
        event.preventDefault();
        setShowShortcutKeyModal(true);
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [messages, chatStore, navigate]);

  return (
    <>
      <div className={styles.chat} key={session.id}>
        <div className="window-header" data-tauri-drag-region>
          {isMobileScreen && (
            <div className="window-actions">
              <div className={"window-action-button"}>
                <IconButton
                  icon={<ReturnIcon />}
                  bordered
                  title={Locale.Chat.Actions.ChatList}
                  onClick={() => navigate(Path.Home)}
                />
              </div>
            </div>
          )}

          <div
            className={clsx("window-header-title", styles["chat-body-title"])}
          >
            <div
              className={clsx(
                "window-header-main-title",
                styles["chat-body-main-title"],
              )}
              onClickCapture={renameCurrentSession}
            >
              {!session.topic ? getDefaultTopic() : session.topic}
            </div>
            <div className="window-header-sub-title">
              {Locale.Chat.SubTitle(historyTotalCount)}
            </div>
          </div>
          <div className="window-actions">
            <ModelSelectorButton />
            {!isMobileScreen && <BrowserStatusButton />}
            <div className="window-action-button">
              <IconButton
                icon={<ReloadIcon />}
                bordered
                title={Locale.Chat.Actions.Refresh}
                onClick={() => chatStore.refreshSessionMessages(session.id)}
              />
            </div>
            {!isMobileScreen && (
              <div className="window-action-button">
                <IconButton
                  icon={<RenameIcon />}
                  bordered
                  title={Locale.Chat.Rename}
                  aria={Locale.Chat.Rename}
                  onClick={renameCurrentSession}
                />
              </div>
            )}
            {!session.draft && (
              <div className="window-action-button">
                <IconButton
                  icon={
                    session.conversationStatus === "ARCHIVED" ? (
                      <ReturnIcon />
                    ) : (
                      <ArchiveIcon />
                    )
                  }
                  bordered
                  title={
                    session.conversationStatus === "ARCHIVED"
                      ? Locale.Chat.Actions.Restore
                      : Locale.Chat.Actions.Archive
                  }
                  onClick={toggleArchiveSession}
                />
              </div>
            )}
            <div className="window-action-button">
              <IconButton
                icon={<ExportIcon />}
                bordered
                title={Locale.Chat.Actions.Export}
                disabled={preparingExport}
                onClick={() => void onExport()}
              />
            </div>
            {showMaxIcon && (
              <div className="window-action-button">
                <IconButton
                  icon={config.tightBorder ? <MinIcon /> : <MaxIcon />}
                  bordered
                  title={Locale.Chat.Actions.FullScreen}
                  aria={Locale.Chat.Actions.FullScreen}
                  onClick={() => {
                    config.update(
                      (config) => (config.tightBorder = !config.tightBorder),
                    );
                  }}
                />
              </div>
            )}
          </div>
        </div>
        <div className={styles["chat-main"]}>
          <div className={styles["chat-body-container"]}>
            <div
              className={styles["chat-body"]}
              ref={scrollRef}
              onScroll={(e) => onChatBodyScroll(e.currentTarget)}
              onMouseDown={() => inputRef.current?.blur()}
              onTouchStart={() => {
                inputRef.current?.blur();
                setAutoScroll(false);
              }}
            >
              {hasHistoryMore &&
                (session.loadingOlderMessages ? (
                  <div
                    className={styles["chat-history-status"]}
                    data-message-pagination-status="loading"
                  >
                    {Locale.Chat.HistoryLoading}
                  </div>
                ) : session.messageHistoryError ? (
                  <div
                    className={styles["chat-history-status"]}
                    data-message-pagination-status="error"
                  >
                    <span>{Locale.Chat.HistoryError}</span>
                    <button
                      data-message-pagination-retry="older"
                      onClick={() => void requestOlderMessages(true)}
                    >
                      {Locale.Chat.Actions.Retry}
                    </button>
                  </div>
                ) : historySentinelVisible ? (
                  <div
                    ref={sentinelRef}
                    className={styles["chat-history-sentinel"]}
                    data-message-pagination-sentinel="true"
                  />
                ) : null)}
              {messages.map((message, i) => {
                const isUser = message.role === "user";
                const messageImages = getMessageImages(message);
                const showActions =
                  i > 0 &&
                  !(message.preview || message.content.length === 0) &&
                  !message.streaming;

                return (
                  <Fragment key={message.id}>
                    <div
                      className={
                        isUser
                          ? styles["chat-message-user"]
                          : styles["chat-message"]
                      }
                      data-message-id={message.id}
                    >
                      <div className={styles["chat-message-container"]}>
                        <div className={styles["chat-message-header"]}>
                          <div className={styles["chat-message-avatar"]}>
                            {isUser ? (
                              <Avatar avatar={config.avatar} />
                            ) : (
                              <>
                                {["system"].includes(message.role) ? (
                                  <Avatar avatar="2699-fe0f" />
                                ) : (
                                  <MaskAvatar
                                    avatar={session.mask.avatar}
                                    model={
                                      message.model ||
                                      session.mask.modelConfig.model
                                    }
                                  />
                                )}
                              </>
                            )}
                          </div>
                          {!isUser && (
                            <div className={styles["chat-model-name"]}>
                              {message.model}
                            </div>
                          )}

                          {showActions && (
                            <div className={styles["chat-message-actions"]}>
                              <div className={styles["chat-input-actions"]}>
                                <ChatAction
                                  text={Locale.Chat.Actions.Copy}
                                  icon={<CopyIcon />}
                                  onClick={() =>
                                    copyToClipboard(
                                      getMessageTextContent(message),
                                    )
                                  }
                                />
                              </div>
                            </div>
                          )}
                        </div>
                        <div className={styles["chat-message-item"]}>
                          <Markdown
                            key={message.streaming ? "loading" : "done"}
                            content={getMessageTextContent(message)}
                            loading={
                              (message.preview || message.streaming) &&
                              message.content.length === 0 &&
                              !isUser
                            }
                            //   onContextMenu={(e) => onRightClick(e, message)} // hard to use
                            onDoubleClickCapture={() => {
                              if (!isMobileScreen) return;
                              setUserInput(getMessageTextContent(message));
                            }}
                            fontSize={fontSize}
                            fontFamily={fontFamily}
                            parentRef={scrollRef}
                            defaultShow={i >= messages.length - 6}
                          />
                          {messageImages.length > 0 &&
                            (messageImages.length === 1 ? (
                              <img
                                className={styles["chat-message-item-image"]}
                                src={messageImages[0]}
                                alt=""
                                onClick={() => showImageModal(messageImages[0])}
                              />
                            ) : (
                              <div
                                className={styles["chat-message-item-images"]}
                                style={
                                  {
                                    "--image-count": messageImages.length,
                                  } as React.CSSProperties
                                }
                              >
                                {messageImages.map((image, imageIndex) => (
                                  <img
                                    className={
                                      styles["chat-message-item-image-multi"]
                                    }
                                    src={image}
                                    key={imageIndex}
                                    alt=""
                                    onClick={() => showImageModal(image)}
                                  />
                                ))}
                              </div>
                            ))}
                          {message.isError && (
                            <div className={styles["chat-message-error"]}>
                              {errorTextForCode(message.errorCode)}
                            </div>
                          )}
                        </div>

                        <div className={styles["chat-message-action-date"]}>
                          {message.date.toLocaleString()}
                        </div>
                      </div>
                    </div>
                  </Fragment>
                );
              })}
            </div>
            <div className={styles["chat-input-panel"]}>
              <PromptHints
                prompts={promptHints}
                onPromptSelect={onPromptSelect}
              />

              <ChatActions
                scrollToBottom={scrollToBottom}
                hitBottom={hitBottom}
                showPromptHints={() => {
                  // Click again to close
                  if (promptHints.length > 0) {
                    setPromptHints([]);
                    return;
                  }

                  inputRef.current?.focus();
                  setUserInput("/");
                  onSearch("");
                }}
                setShowShortcutKeyModal={setShowShortcutKeyModal}
                uploadImage={() => fileInputRef.current?.click()}
                uploadDisabled={attachmentDisabled}
                uploadInProgress={attachment.isPreparingImages}
              />
              <input
                ref={fileInputRef}
                type="file"
                hidden
                multiple
                accept={ATTACHMENT_ACCEPT}
                onChange={(e) => {
                  if (e.currentTarget.files?.length) {
                    attachment.addFiles(e.currentTarget.files);
                  }
                  e.currentTarget.value = "";
                }}
              />
              <label
                className={clsx(
                  styles["chat-input-panel-inner"],
                  attachment.pendingImages.length > 0 &&
                    styles["chat-input-panel-inner-attach"],
                )}
                htmlFor="chat-input"
              >
                {attachment.pendingImages.length > 0 && (
                  <div className={styles["attach-images"]}>
                    {attachment.pendingImages.map((image) => (
                      <div
                        key={image.id}
                        className={styles["attach-image"]}
                        style={{ backgroundImage: `url(${image.dataUrl})` }}
                        onClick={() => showImageModal(image.dataUrl)}
                      >
                        <div className={styles["attach-image-mask"]}>
                          <DeleteIcon
                            className={styles["delete-image"]}
                            role="button"
                            aria-label={Locale.Chat.Actions.Delete}
                            aria-disabled={
                              attachment.isSubmittingMessage || undefined
                            }
                            onClick={(e: React.MouseEvent) => {
                              e.stopPropagation();
                              if (attachment.isSubmittingMessage) return;
                              attachment.removeAt(image.id);
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  id="chat-input"
                  ref={inputRef}
                  className={styles["chat-input"]}
                  placeholder={Locale.Chat.Input(submitKey)}
                  onInput={(e) => onInput(e.currentTarget.value)}
                  onPaste={onPasteImages}
                  value={userInput}
                  onKeyDown={onInputKeyDown}
                  onFocus={scrollToBottom}
                  onClick={scrollToBottom}
                  rows={inputRows}
                  autoFocus={autoFocus}
                  style={{
                    fontSize: config.fontSize,
                    fontFamily: config.fontFamily,
                  }}
                />
                {session.pendingRequestId ? (
                  <IconButton
                    icon={<PauseIcon />}
                    text={Locale.Chat.InputActions.Stop}
                    className={styles["chat-input-send"]}
                    type="primary"
                    disabled={session.cancelling}
                    onClick={() => chatStore.cancelRequest(session.id)}
                  />
                ) : (
                  <IconButton
                    icon={<SendWhiteIcon />}
                    text={Locale.Chat.Send}
                    className={styles["chat-input-send"]}
                    type="primary"
                    disabled={
                      attachment.isPreparingImages ||
                      attachment.isSubmittingMessage
                    }
                    onClick={() => doSubmit(userInput)}
                  />
                )}
              </label>
            </div>
          </div>
        </div>
      </div>
      {showExport && (
        <ExportMessageModal
          messages={preparedExportMessages}
          onClose={() => setShowExport(false)}
        />
      )}

      {showShortcutKeyModal && (
        <ShortcutKeyModal onClose={() => setShowShortcutKeyModal(false)} />
      )}
    </>
  );
}

/**
 * I3/H1:附件 ephemeral 状态全部住在本组件(keyed `_Chat` 之外),
 * 草稿首发导致的 `_Chat` remount 不清 pending/preparing/submitting;
 * 真切换会话由 owner transition classifier 作废(R35)。
 */
export function Chat() {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();

  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [isPreparingImages, setIsPreparingImages] = useState(false);
  const [isSubmittingMessage, setIsSubmittingMessage] = useState(false);
  const attachmentEpochRef = useRef(0);
  const submittingRef = useRef(false);
  const attachmentOwnerRef = useRef<AttachmentOwner | null>(null);

  // H3/H4:owner transition —— SAME/PROMOTION 保留,SWITCH 才 invalidate
  useEffect(() => {
    const owner: AttachmentOwner = {
      sessionId: session.id,
      currentSessionIndex: chatStore.currentSessionIndex,
      wasDraft: session.draft === true,
    };
    const prev = attachmentOwnerRef.current;
    attachmentOwnerRef.current = owner;

    if (prev === null) return;
    if (prev.sessionId === owner.sessionId) return;

    const isPromotion =
      prev.wasDraft === true &&
      owner.wasDraft === false &&
      prev.sessionId.startsWith("draft-") &&
      !owner.sessionId.startsWith("draft-") &&
      prev.currentSessionIndex === owner.currentSessionIndex;
    if (isPromotion) return;

    attachmentEpochRef.current += 1;
    setPendingImages([]);
    setIsPreparingImages(false);
    setIsSubmittingMessage(false);
    submittingRef.current = false;
  }, [session.id, session.draft, chatStore.currentSessionIndex]);

  // 外层 Chat 卸载:作废晚到的 prepare/submit continuation(仅挂载周期一次)
  useEffect(
    () => () => {
      attachmentEpochRef.current += 1;
    },
    [],
  );

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      if (isPreparingImages || submittingRef.current) return;
      const list = Array.from(files);
      if (list.length === 0) return;
      const capturedEpoch = attachmentEpochRef.current;
      const baseCount = pendingImages.length;
      const baseTotal = pendingImages.reduce((sum, im) => sum + im.bytes, 0);
      let addedCount = 0;
      let addedBytes = 0;
      setIsPreparingImages(true);
      try {
        // 串行 for…of:严格 FileList 顺序(= 后端 digest 顺序),禁并行 canvas
        for (const file of list) {
          try {
            const image = await prepareAttachment(file);
            if (capturedEpoch !== attachmentEpochRef.current) return;
            if (baseCount + addedCount >= ATTACHMENT_MAX_COUNT) {
              showToast(Locale.Chat.ImageCountExceeded);
              break;
            }
            if (
              baseTotal + addedBytes + image.bytes >
              ATTACHMENT_TOTAL_MAX_FINAL_BYTES
            ) {
              showToast(Locale.Chat.ImageTotalExceeded);
              continue;
            }
            addedCount += 1;
            addedBytes += image.bytes;
            setPendingImages((prev) => [...prev, image]);
          } catch (error) {
            // R28:单张本地失败只拒绝该张,批次继续,已成功项保留
            showToast(
              Locale.Chat[
                error instanceof AttachmentPrepareError
                  ? error.reason
                  : "ImageReadFailed"
              ],
            );
          }
        }
      } finally {
        if (capturedEpoch === attachmentEpochRef.current) {
          setIsPreparingImages(false);
        }
      }
    },
    [isPreparingImages, pendingImages],
  );

  const removeAt = useCallback((id: string) => {
    setPendingImages((prev) => prev.filter((image) => image.id !== id));
  }, []);

  const submit = useCallback(
    (text: string) => {
      if (isPreparingImages || submittingRef.current) return;
      if (text.trim() === "" && pendingImages.length === 0) return;
      const snapshot = pendingImages;
      const epochAtSend = attachmentEpochRef.current;
      submittingRef.current = true; // 先 ref(同步拦双击,G1)
      setIsSubmittingMessage(true); // 再 state(驱动 disabled)
      void chatStore
        .onUserInput(text, snapshot)
        .then((accepted) => {
          if (!accepted) return; // Backend 未接受 → 保留 pending 可重试
          if (epochAtSend !== attachmentEpochRef.current) return;
          setPendingImages([]);
        })
        .finally(() => {
          if (epochAtSend !== attachmentEpochRef.current) return;
          submittingRef.current = false;
          setIsSubmittingMessage(false); // → session.pendingRequestId 接管 Stop
        });
    },
    [chatStore, isPreparingImages, pendingImages],
  );

  return (
    <_Chat
      key={session.id}
      attachment={{
        pendingImages,
        isPreparingImages,
        isSubmittingMessage,
        addFiles,
        removeAt,
        submit,
      }}
    ></_Chat>
  );
}
