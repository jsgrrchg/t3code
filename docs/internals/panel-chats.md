# Right-panel chats

> For maintainers. Using T3 Code? See [right-panel chats](../user/right-panel-chats.md).

A right-panel chat is a durable orchestration thread with `parentThreadId` set to the ID of a
top-level thread. A top-level thread has a missing or null `parentThreadId`; the missing form keeps
old events and snapshots decodable. `isTopLevelThread` and `isPanelChatThread` are the canonical
classification helpers.

## Durable relationship

`thread.create` accepts an optional parent ID. The server requires the parent to exist, remain
undeleted, belong to the same project, and itself be top-level. Nested panel chats are rejected.
The relationship is projected into the thread row, shells, snapshots, bootstrap payloads, and the
shared client runtime.

Deleting a panel chat affects only that child. Deleting a top-level thread first deletes its direct
children through the normal orchestration deletion path, then deletes the parent. Archiving a
parent hides the workspace that makes its children reachable; children do not use archive state as
a substitute for their relationship.

The server advertises the optional `panelChats` environment capability. New clients gate creation
on it, so they remain compatible with older environments. Web, desktop, remote, relay, and tunnel
connections all use the same contracts and commands. Mobile has no right panel and filters child
threads out of its navigation.

## Client ownership

Durable data and local layout intentionally have different owners:

- The server owns the parent-child relationship, transcript, execution, title, checkpoints, and
  lifecycle.
- `rightPanelStore` owns open surfaces, order, and active surface per environment and top-level
  thread. Closing a tab changes only this local layout state.
- The child selector derives all durable children for a parent, allowing a client to reopen a chat
  even when no local tab exists. It searches the full derived collection and caps rendered results
  so an unbounded durable history does not create an unbounded menu tree.

`ChatView` owns workspace layout and global shortcuts. `ThreadConversationPane` renders a child in
panel presentation without registering another right panel, preview bus, chat-action bus, or set of
global key handlers. Right-panel content switches by active surface, so only the active child
transcript has a mounted React tree. Inactive children remain represented by lightweight shells
and continue running on the server.

File links, turn diffs, and Agents CTAs from a child target surfaces in the parent's visible panel.
Diff and Agents descriptors retain the source child ID while that child exists; reconciliation
clears the source when the child is deleted locally or by another client.

Creation from the panel, Command Palette, and `rightPanel.newChat` converges on the workspace
chat-action handler. The child inherits the parent's project, checkout/worktree, branch, provider
selection, runtime mode, and interaction mode at creation time. Subsequent state evolves
independently, including normal first-turn automatic title generation.
