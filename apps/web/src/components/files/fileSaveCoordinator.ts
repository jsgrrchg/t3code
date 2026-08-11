import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

export interface FileSaveCoordinatorOptions<A, E> {
  readonly debounceMs: number;
  readonly persist: (contents: string) => Promise<AtomCommandResult<A, E>>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onConfirmed: (contents: string) => void;
}

export class FileSaveCoordinator<A = unknown, E = unknown> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents = "";
  private latestRevision = 0;
  private lastChangeAt = 0;
  private saving = false;
  private flushing = false;
  private disposed = false;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly options: FileSaveCoordinatorOptions<A, E>) {}

  change(contents: string): void {
    this.latestContents = contents;
    this.latestRevision += 1;
    this.lastChangeAt = Date.now();
    this.options.onPendingChange(true);
    this.schedule(this.options.debounceMs);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    if (this.latestRevision > 0) void this.persistLatest();
  }

  /** Persist the latest edit and wait until any in-flight save has settled. */
  flush(): Promise<void> {
    this.flushing = true;
    this.clearTimer();
    if (this.latestRevision > 0 && !this.saving) void this.persistLatest();
    if (!this.saving) {
      this.flushing = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  hasPendingChanges(): boolean {
    return this.latestRevision > 0 || this.saving;
  }

  /** Prevent cleanup from writing a file again after it has been deleted. */
  discard(): void {
    this.disposed = true;
    this.clearTimer();
    this.latestRevision = 0;
    this.options.onPendingChange(false);
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persistLatest();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private async persistLatest(): Promise<void> {
    if (this.saving || this.latestRevision === 0) return;

    this.saving = true;
    const contents = this.latestContents;
    const revision = this.latestRevision;
    const result = await this.options.persist(contents);
    const succeeded = result._tag === "Success";
    if (succeeded) {
      this.options.onConfirmed(contents);
    }

    this.saving = false;
    if (this.latestRevision === 0) {
      this.flushing = false;
      this.resolveIdleWaiters();
      return;
    }
    if (revision === this.latestRevision) {
      if (succeeded) {
        this.latestRevision = 0;
        this.options.onPendingChange(false);
      }
      this.flushing = false;
      this.resolveIdleWaiters();
      return;
    }

    const remainingDebounce = Math.max(
      0,
      this.options.debounceMs - (Date.now() - this.lastChangeAt),
    );
    if (this.disposed || this.flushing) {
      void this.persistLatest();
    } else {
      this.schedule(remainingDebounce);
    }
  }

  private resolveIdleWaiters(): void {
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}
