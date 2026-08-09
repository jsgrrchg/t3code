const TRANSIENT_UI_SELECTOR = [
  '[role="dialog"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="command-dialog-popup"]',
  '[data-slot="dialog-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="select-popup"]',
].join(",");

/** Escape dismisses transient UI before it reaches the active chat turn. */
export function isChatShortcutBlockedByTransientUi(): boolean {
  return typeof document !== "undefined" && document.querySelector(TRANSIENT_UI_SELECTOR) !== null;
}
