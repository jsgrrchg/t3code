# Right-panel chats

Right-panel chats are focused conversations that live beside a main thread. They use the same
project, checkout, branch, provider, model, and interaction mode as the main thread when created,
then continue independently.

Create one from the **+** menu in the right panel, from **New right-panel chat** in the Command
Palette, or with the configurable `rightPanel.newChat` shortcut. Its default shortcut is
`mod+alt+n`.

Each chat appears as a tab in the right panel. Only the selected chat's conversation is rendered,
but other chats keep their history and can continue running in the background. A blue status dot
means a chat is running, an amber dot means it needs attention, and a foreground dot marks an
unread completion. Use the drag handle on any right-panel tab to rearrange the tabs for that main
thread; their order is stored on the current client.

## Titles and history

A new chat starts as **New chat**. After its first turn, T3 Code uses the usual automatic thread
title generation. You can double-click its tab, press `F2` while the tab is focused, or choose
**Rename** from the tab menu to set your own title. The same menu can regenerate the automatic
title.

Closing a chat tab asks for confirmation and then permanently deletes that chat and its conversation
history. The same rule applies when a chat is included in **Close others**, **Close to the right**, or
**Close all**; one confirmation covers all chats affected by the action. Closing non-chat surfaces
such as Files, Diff, Terminal, Preview, or Agents keeps their existing behavior.

**Open chat** in the right-panel **+** menu and the panel's empty state remain available for chats
that were closed by an older client. Both selectors search the complete retained chat history while
keeping the visible result list bounded.

With focus on a panel tab, use Left and Right Arrow (or Home and End) to change tabs, `F2` to rename
a chat, and Delete to close the tab. Escape cancels a rename and returns focus to the tab. The tab
menu also provides Close, Close others, Close to the right, and Close all in desktop and remote web
clients.

## Where chats appear

Right-panel chats belong to their main thread. They do not add entries to the left sidebar,
recents, archive lists, or global thread search. Their relationship and conversation history are
stored by the server while the chat exists, so they survive reloads and work over remote
connections. Which tabs are open, their order, and the active tab are layout preferences local to
each client; closing a chat tab also deletes the server-owned chat for every client.

The main thread's left-sidebar status includes activity from its right-panel chats. It shows when a
child chat is working, needs approval or input, is monitoring background work, or has an unread
completion, without adding a separate sidebar row for that chat.

The feature is available in the shared web renderer, including the desktop app and remote web
clients. Mobile does not currently show the right panel and hides these chats from its main thread
history. When connected to an older server that does not advertise right-panel chat support, the
creation actions are hidden or disabled.
