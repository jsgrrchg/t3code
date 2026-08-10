import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { dispatchChatAction, subscribeChatAction } from "./chatActionBus";

describe("chatActionBus", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["interrupt-active-turn", "new-panel-chat"] as const)(
    "routes %s through the mounted chat owner",
    (action) => {
      vi.stubGlobal("window", new EventTarget());
      vi.stubGlobal(
        "CustomEvent",
        class<T> extends Event {
          readonly detail: T;

          constructor(type: string, init: CustomEventInit<T>) {
            super(type, init);
            this.detail = init.detail as T;
          }
        },
      );
      const listener = vi.fn(() => true);
      const unsubscribe = subscribeChatAction(listener);

      expect(dispatchChatAction(action)).toBe(true);
      expect(listener).toHaveBeenCalledWith(action);

      unsubscribe();
      expect(dispatchChatAction(action)).toBe(false);
      expect(listener).toHaveBeenCalledTimes(1);
    },
  );
});
