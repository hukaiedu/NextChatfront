import { useEffect, useState } from "react";

import DownIcon from "../icons/down.svg";
import Locale from "../locales";
import { useChatStore } from "../store";
import { IconButton } from "./button";
import { Selector } from "./ui-lib";

const RETRY_VALUE = "__retry_load_models__";
const DEFAULT_VALUE = "";

/**
 * M4:聊天头部的模型选择器。
 *
 * - 会话模型偏好存在后端 Conversation.preferredModelKey,这里只读显示 + PATCH 保存
 * - null = 默认模型(默认选项,选中后 PATCH null 清除偏好,绝不伪造"默认"键)
 * - 历史偏好键不在当前目录里 → 显示「当前模型不可用」,绝不自动清除(§十二)
 * - disabled 的模型项可见但不可选(§十一);在途 Request / 同会话正在保存期间整个按钮禁用(FIX-02)
 * - 目录来自 GET /api/provider/models;带偏好的会话进入聊天页即拉取以解析 label,
 *   其余会话首次打开时拉取,失败在列表里给重试项(§十六/§十七)
 */
export function ModelSelectorButton() {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const catalog = chatStore.modelCatalog;
  const catalogStatus = chatStore.modelCatalogStatus;
  const [pickerOpen, setPickerOpen] = useState(false);

  const preferred = session.preferredModelKey ?? null;
  const busy = !!session.pendingRequestId;

  // FIX-07:生成中不调 loadModels,避免命中 PROVIDER_NOT_READY
  useEffect(() => {
    if (preferred && catalogStatus === "idle" && !busy) {
      void chatStore.loadModels();
    }
  }, [preferred, catalogStatus, chatStore, busy]);

  // FIX-07:busy 从 true→false 时补拉(mount 时 busy=true 跳过了上面的 effect)
  useEffect(() => {
    if (!busy && preferred && catalogStatus === "idle") {
      void chatStore.loadModels();
    }
  }, [busy]);
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
  const label = preferred
    ? preferredOption?.label ?? Locale.Chat.ModelSelector.Unavailable
    : Locale.Chat.ModelSelector.Default;

  const items =
    catalogStatus === "error"
      ? [
          {
            title: Locale.Chat.ModelSelector.LoadFailed,
            value: RETRY_VALUE,
            disable: false,
          },
          {
            title: Locale.Chat.ModelSelector.Default,
            value: DEFAULT_VALUE,
            disable: false,
          },
        ]
      : [
          {
            title: Locale.Chat.ModelSelector.Default,
            value: DEFAULT_VALUE,
            disable: false,
          },
          ...catalog.map((model) => ({
            title: model.label,
            value: model.key,
            disable: model.disabled,
          })),
        ];

  const handleSelection = (selection: string[]) => {
    const value = selection[0];
    if (value === RETRY_VALUE) {
      void chatStore.loadModels(true);
      return;
    }
    void chatStore.setSessionModel(
      session.id,
      value === DEFAULT_VALUE ? null : value,
    );
  };

  return (
    <>
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
        <Selector
          items={items}
          defaultSelectedValue={preferred ?? DEFAULT_VALUE}
          onSelection={handleSelection}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}
