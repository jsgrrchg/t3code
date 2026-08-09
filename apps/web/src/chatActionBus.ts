"use client";

/** Actions owned by the currently mounted chat view but triggered globally. */
export type ChatAction = "interrupt-active-turn";

const EVENT_NAME = "t3code:chat-action";

export function dispatchChatAction(action: ChatAction): boolean {
  if (typeof window === "undefined") return false;
  const event = new CustomEvent<ChatAction>(EVENT_NAME, {
    cancelable: true,
    detail: action,
  });
  return !window.dispatchEvent(event);
}

export function subscribeChatAction(listener: (action: ChatAction) => boolean): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<ChatAction>).detail;
    if (detail === "interrupt-active-turn" && listener(detail)) event.preventDefault();
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
