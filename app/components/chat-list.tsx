import DeleteIcon from "../icons/delete.svg";

import styles from "./home.module.scss";
import {
  DragDropContext,
  Droppable,
  Draggable,
  OnDragEndResponder,
} from "@hello-pangea/dnd";

import { useChatStore } from "../store";

import Locale from "../locales";
import { useLocation, useNavigate } from "react-router-dom";
import { Path } from "../constant";
import { MaskAvatar } from "./mask";
import { Mask } from "../store/mask";
import { useRef, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { showConfirm } from "./ui-lib";
import { useMobileScreen } from "../utils";
import clsx from "clsx";

export function ChatItem(props: {
  onClick?: () => void;
  onDelete?: () => void;
  title: string;
  /** 未加载过消息的会话不展示条数 */
  count?: number;
  time: string;
  selected: boolean;
  id: string;
  index: number;
  narrow?: boolean;
  mask: Mask;
}) {
  const draggableRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (props.selected && draggableRef.current) {
      draggableRef.current?.scrollIntoView({
        block: "center",
      });
    }
  }, [props.selected]);

  const { pathname: currentPath } = useLocation();
  const countLabel =
    props.count === undefined ? "" : Locale.ChatItem.ChatItemCount(props.count);
  return (
    <Draggable draggableId={`${props.id}`} index={props.index}>
      {(provided) => (
        <div
          className={clsx(styles["chat-item"], {
            [styles["chat-item-selected"]]:
              props.selected &&
              (currentPath === Path.Chat || currentPath === Path.Home),
          })}
          onClick={props.onClick}
          ref={(ele) => {
            draggableRef.current = ele;
            provided.innerRef(ele);
          }}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          title={`${props.title}\n${countLabel}`}
        >
          {props.narrow ? (
            <div className={styles["chat-item-narrow"]}>
              <div className={clsx(styles["chat-item-avatar"], "no-dark")}>
                <MaskAvatar
                  avatar={props.mask.avatar}
                  model={props.mask.modelConfig.model}
                />
              </div>
              {props.count !== undefined && (
                <div className={styles["chat-item-narrow-count"]}>
                  {props.count}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className={styles["chat-item-title"]}>{props.title}</div>
              <div className={styles["chat-item-info"]}>
                <div className={styles["chat-item-count"]}>{countLabel}</div>
                <div className={styles["chat-item-date"]}>{props.time}</div>
              </div>
            </>
          )}

          <div
            className={styles["chat-item-delete"]}
            onClickCapture={(e) => {
              props.onDelete?.();
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <DeleteIcon />
          </div>
        </div>
      )}
    </Draggable>
  );
}

const paginationStatusStyle: CSSProperties = {
  padding: "8px 14px",
  fontSize: "12px",
  opacity: 0.6,
  textAlign: "center",
};

export function ChatList(props: { narrow?: boolean }) {
  const [sessions, selectedIndex, selectSession, moveSession] = useChatStore(
    (state) => [
      state.sessions,
      state.currentSessionIndex,
      state.selectSession,
      state.moveSession,
    ],
  );
  const chatStore = useChatStore();
  const navigate = useNavigate();
  const isMobileScreen = useMobileScreen();

  // PAG-1:无限滚动与 DnD 互斥 —— 拖动周期不得改变 Draggable 集合
  const [isDragging, setIsDragging] = useState(false);
  // IO 回调要读最新值,拖拽状态用 ref 镜像
  const isDraggingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const {
    listNextCursor,
    loadingList,
    loadingMoreList,
    listReloadError,
    listMoreError,
  } = chatStore;

  const setDragging = (dragging: boolean) => {
    isDraggingRef.current = dragging;
    setIsDragging(dragging);
  };

  const hasMore = listNextCursor !== null;

  // PAG-1:IntersectionObserver(root = sidebar-body 滚动容器,底部 300px 预载);
  // 六条件闸门在回调里读最新 store 状态,cursor=null 由 store 守卫兜底
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;
    const scrollRoot = sentinel.closest(`.${styles["sidebar-body"]}`) ?? null;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        const state = useChatStore.getState();
        if (
          state.listNextCursor === null ||
          state.loadingList ||
          state.loadingMoreList ||
          state.listReloadError ||
          state.listMoreError ||
          isDraggingRef.current
        ) {
          return;
        }
        void state.loadMoreConversations();
      },
      { root: scrollRoot, rootMargin: "0px 0px 300px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore]);

  const onDragStart = () => setDragging(true);

  const onDragEnd: OnDragEndResponder = (result) => {
    // PAG-REVIEW-14:必须先解除拖拽再 early return —— 否则取消拖拽 / 原位
    // 放下后 isDragging 永久 true,Infinite Scroll 从此关闭
    setDragging(false);
    const { destination, source } = result;
    if (!destination) {
      return;
    }

    if (
      destination.droppableId === source.droppableId &&
      destination.index === source.index
    ) {
      return;
    }

    moveSession(source.index, destination.index);
  };

  return (
    <DragDropContext onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <Droppable droppableId="chat-list">
        {(provided) => (
          <div
            className={styles["chat-list"]}
            ref={provided.innerRef}
            {...provided.droppableProps}
          >
            {sessions.map((item, i) => (
              <ChatItem
                title={item.topic}
                time={new Date(item.lastUpdate).toLocaleString()}
                count={item.loaded ? item.messages.length : undefined}
                key={item.id}
                id={item.id}
                index={i}
                selected={i === selectedIndex}
                onClick={() => {
                  navigate(Path.Chat);
                  selectSession(i);
                }}
                onDelete={async () => {
                  if (
                    (!props.narrow && !isMobileScreen) ||
                    (await showConfirm(Locale.Home.DeleteChat))
                  ) {
                    chatStore.deleteSession(i);
                  }
                }}
                narrow={props.narrow}
                mask={item.mask}
              />
            ))}
            {provided.placeholder}
            {listReloadError ? (
              <div
                data-pagination-status="reload-error"
                style={paginationStatusStyle}
              >
                <span>{Locale.Home.ReloadError}</span>
                <button
                  data-pagination-retry="reload"
                  onClick={() => void chatStore.reloadList()}
                >
                  {Locale.Home.Retry}
                </button>
              </div>
            ) : listMoreError ? (
              <div
                data-pagination-status="more-error"
                style={paginationStatusStyle}
              >
                <span>{Locale.Home.LoadMoreError}</span>
                <button
                  data-pagination-retry="more"
                  onClick={() => void chatStore.loadMoreConversations()}
                >
                  {Locale.Home.Retry}
                </button>
              </div>
            ) : loadingMoreList ? (
              <div
                data-pagination-status="loading-more"
                style={paginationStatusStyle}
              >
                {Locale.Home.LoadMore}
              </div>
            ) : null}
            {hasMore && !listReloadError && (
              <div
                ref={sentinelRef}
                data-pagination-sentinel="true"
                style={{ height: 1 }}
              />
            )}
          </div>
        )}
      </Droppable>
    </DragDropContext>
  );
}
