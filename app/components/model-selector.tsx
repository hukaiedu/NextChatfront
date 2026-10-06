import { useEffect, useState } from "react";

import DownIcon from "../icons/down.svg";
import { PersonChatIcon } from "./personchat-icon";
import Locale from "../locales";
import { useChatStore } from "../store";
import { IconButton } from "./button";
import styles from "./model-selector.module.scss";

const RETRY_VALUE = "__retry_load_models__";
const DEFAULT_MODEL_KEY = "gemini-flash";
const DEFAULT_MODEL_LABEL = "Flash";

/**
 * M4:模型选择器(紧凑下拉框,现在 Composer 底部左侧)。
 *
 * - 会话模型偏好存在后端 Conversation.preferredModelKey,这里只读显示 + PATCH 保存
 * - null = 后端使用 Gemini Flash 默认模型;它不是一个可选的模型目录项
 * - 历史偏好键不在当前目录里 → 显示「当前模型不可用」,绝不自动清除(§十二)
 * - disabled 的模型项可见但不可选(§十一);在途 Request / 同会话正在保存期间整个按钮禁用(FIX-02)
 * - 目录来自 GET /api/provider/models;首次进入聊天页拉取,并用于显示默认 Flash 的实际 label
 */
export function ModelSelectorButton(props: { dropUp?: boolean }) {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const catalog = chatStore.modelCatalog;
  const catalogStatus = chatStore.modelCatalogStatus;
  const [pickerOpen, setPickerOpen] = useState(false);

  const preferred = session.preferredModelKey ?? null;
  const busy = !!session.pendingRequestId;

  // 目录是全局共享的;首次进入聊天页拉取,生成中则等到空闲再拉取。
  useEffect(() => {
    if (catalogStatus === "idle" && !busy) {
      void chatStore.loadModels();
    }
  }, [catalogStatus, chatStore, busy]);
  const saving = chatStore.isModelSaving(session.id);
  const disabled = busy || saving;
  const tip = busy
    ? Locale.Chat.ModelSelector.BusyTip
    : saving
    ? Locale.Chat.ModelSelector.SavingTip
    : undefined;

  const preferredOption = preferred
    ? catalog.find((model) => model.key === preferred)
    : undefined;
  const defaultOption =
    catalog.find((model) => model.key === DEFAULT_MODEL_KEY) ??
    catalog.find((model) => model.label.toLowerCase().includes("flash"));
  const label = preferred
    ? preferredOption?.label ?? Locale.Chat.ModelSelector.Unavailable
    : defaultOption?.label ?? DEFAULT_MODEL_LABEL;

  const items =
    catalogStatus === "error"
      ? [
          {
            title: Locale.Chat.ModelSelector.LoadFailed,
            value: RETRY_VALUE,
            disable: false,
          },
        ]
      : catalog.map((model) => ({
          title: model.label,
          value: model.key,
          disable: model.disabled,
        }));

  const currentValue = preferred ?? defaultOption?.key ?? DEFAULT_MODEL_KEY;

  const handleSelection = (value: string) => {
    if (value === RETRY_VALUE) {
      void chatStore.loadModels(true);
      return;
    }
    void chatStore.setSessionModel(session.id, value);
  };

  return (
    <div
      className={`${styles["anchor"]}${
        props.dropUp ? ` ${styles["anchor-up"]}` : ""
      }`}
    >
      <div className="window-action-button">
        <IconButton
          icon={<DownIcon />}
          text={label}
          bordered
          disabled={disabled}
          title={tip}
          onClick={() => {
            setPickerOpen(true);
            void chatStore.loadModels();
          }}
        />
      </div>
      {pickerOpen && (
        <>
          <div
            className={styles["mask"]}
            onClick={() => setPickerOpen(false)}
          />
          <div className={styles["menu"]} role="menu">
            {items.map((item, i) => (
              <button
                key={i}
                type="button"
                role="menuitem"
                className={`${styles["item"]}${
                  item.disable ? ` ${styles["item-disabled"]}` : ""
                }`}
                disabled={item.disable}
                onClick={(e) => {
                  e.stopPropagation();
                  if (item.disable) {
                    return;
                  }
                  if (item.value !== RETRY_VALUE) {
                    setPickerOpen(false);
                  }
                  handleSelection(item.value);
                }}
              >
                <PersonChatIcon width={24} height={24} />
                <span className={styles["item-title"]}>{item.title}</span>
                {item.value === currentValue ? (
                  <span className={styles["item-check"]} />
                ) : null}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
