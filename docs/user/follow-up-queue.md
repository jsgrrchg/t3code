# Follow-up queue

The desktop app can hold follow-up messages until the current turn finishes instead of steering the agent immediately.

Choose the behavior under **Settings → General → Follow-up behavior**:

- **Queue** saves messages sent while the agent is working and sends them in order as each turn finishes. Native Codex review and compact commands wait in the same queue.
- **Steer** sends follow-ups directly into the current turn.

Queued work appears above the composer. Drag an entry by its handle to change when it runs; the handle also supports keyboard reordering. Edit a queued message directly in its row, remove it if it is no longer needed, or select **Steer** to send it to the active turn immediately. While a message is being edited, automatic queue dispatch pauses until you save or cancel. The queue is stored locally and survives an app restart.

Stopping the active turn pauses its queue instead of sending the next entry. The queue remains paused across restarts. The next message sent manually starts immediately; after that turn finishes, queued work resumes from the oldest entry.

Native `/review`, `/review-branch`, `/review-commit`, and `/compact` commands run after the current turn finishes. They cannot be steered into active work because each command starts its own provider action.
