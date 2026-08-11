# Progressive diff slices

Large diffs cross the client/server boundary as independently parseable slices. A slice contains
whole files and has this shared shape:

```ts
{
  patch: string;
  truncated: boolean;
  nextCursor: string | null;
}
```

`nextCursor` means more complete files are available. It is pagination state, not a warning.
`truncated` means content inside the current slice could not be inlined. Clients keep slices
separate, parse each once, and flatten the resulting files for their renderer.

Pull-request providers define their own cursor. Local Branch changes resolves the selected base and
HEAD to an immutable merge-base/head pair. Its opaque cursor carries those object IDs, whitespace
mode, snapshot identity, and the next manifest offset. Every continuation validates the cursor and
reruns Git against the frozen commits, so moving a branch while the user reads cannot mix versions.

The Git adapter builds a NUL-separated file manifest and global numstat totals, then serves at most
100 files per page. A response still has a defensive byte budget. If a batch exceeds it, the adapter
retries with fewer files. If one file alone exceeds it, the response keeps that file's structural
header, marks the slice truncated, and advances past it so later files remain reachable.

Review pagination is an explicit opt-in on the existing preview RPC. New clients use the paged path;
clients without the opt-in receive the legacy 120 KB preview. New clients also accept a response
without pagination fields as one legacy page, which keeps web, Desktop, and mobile usable while a
remote client and server update at different times.
