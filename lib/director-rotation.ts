/** Policy is based on the operator's extended account, not fal's public 15-minute tier. */
export const directorPolicy = {
  sessionSeconds: 3600,
  warmupSeconds: 90,
  handoverSeconds: 30,
  safetySeconds: 5,
  startupTimeoutMs: 120000,
  maxFailures: 6,
};
export interface DirectorSession {
  id: number;
  ready(): boolean;
  quiet(): boolean;
  stalled(): boolean;
  buffered(): number;
  close(): void | Promise<void>;
}
export type DirectorEvents = {
  limit(seconds: number | null): void;
  ended(message: string, fatal?: boolean): void;
};
export type DirectorSnapshot = {
  phase:
    | 'idle'
    | 'starting'
    | 'live'
    | 'warming'
    | 'recovering'
    | 'stopped'
    | 'error';
  running: boolean;
  activeId: number | null;
  candidateId: number | null;
  remainingSeconds: number;
  bufferedSeconds: number;
  rotations: number;
  failures: number;
  error: string;
};
type Entry<T> = {
  id: number;
  controller: AbortController;
  createdAt: number;
  deadline: number;
  session?: T;
  failed: boolean;
};
type Options<T extends DirectorSession> = {
  create(id: number, signal: AbortSignal, events: DirectorEvents): Promise<T>;
  /** Resolve only after a displayed frame and exclusive audio transfer. Check valid after awaits. */
  take(next: T, old: T | undefined, valid: () => boolean): Promise<void>;
  now?: () => number;
  sessionSeconds?: number;
};
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Owns only two entries. The caller ticks this clock even when playback is buffering. */
export class DirectorRotation<T extends DirectorSession> {
  private active?: Entry<T>;
  private candidate?: Entry<T>;
  private running = false;
  private taking?: Entry<T>;
  private takingAt = 0;
  private closing = 0;
  private creating = 0;
  private drains = new Set<() => void>();
  private sequence = 0;
  private epoch = 0;
  private rotations = 0;
  private failures = 0;
  private retryAt = 0;
  private error = '';
  private terminal: DirectorSnapshot['phase'] = 'idle';
  private listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly seconds: number;
  private snapshot: DirectorSnapshot;
  constructor(private options: Options<T>) {
    this.now = options.now ?? (() => performance.now());
    this.seconds = Math.max(
      120,
      Math.min(3600, options.sessionSeconds || directorPolicy.sessionSeconds),
    );
    this.snapshot = this.read();
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;
  start() {
    if (this.running) return;
    this.epoch++;
    this.running = true;
    this.failures = 0;
    this.rotations = 0;
    this.error = '';
    this.retryAt = 0;
    this.open();
    this.publish();
  }
  stop() {
    this.running = false;
    this.epoch++;
    this.taking = undefined;
    this.terminal = 'stopped';
    this.release(this.active);
    this.release(this.candidate);
    this.active = undefined;
    this.candidate = undefined;
    this.publish();
    return this.drain();
  }
  tick() {
    if (!this.running) return;
    const now = this.now();
    if (this.taking && now - this.takingAt >= 10000)
      this.fail(this.taking, 'Handover timed out.');
    const active = this.active;
    const remaining = active ? (active.deadline - now) / 1000 : 0;
    const warmup = active
      ? Math.min(
          directorPolicy.warmupSeconds,
          (active.deadline - active.createdAt) / 3000,
        )
      : 0;
    if (
      this.candidate &&
      !this.candidate.session?.ready() &&
      now - this.candidate.createdAt >= directorPolicy.startupTimeoutMs
    )
      this.fail(
        this.candidate,
        'Replacement session did not produce playable footage in time.',
      );
    if (!this.running) return;
    const recovering = active?.failed || active?.session?.stalled();
    if (
      !this.candidate &&
      now >= this.retryAt &&
      (!active || recovering || remaining <= warmup)
    )
      this.open();
    const next = this.candidate;
    if (
      !this.taking &&
      next?.session?.ready() &&
      !next.failed &&
      next.deadline > now + 5000
    ) {
      const forced =
        remaining <= directorPolicy.safetySeconds || active?.session?.stalled();
      const quiet = active?.session?.quiet();
      if (
        !active ||
        forced ||
        ((recovering || remaining <= directorPolicy.handoverSeconds) && quiet)
      )
        this.take(next);
    }
    // A replacement with an exhausted lifetime is never reusable, even if its buffer decoded.
    if (this.candidate && this.candidate.deadline <= now + 5000)
      this.fail(
        this.candidate,
        'Replacement session reached its limit before handover.',
      );
    this.publish();
  }
  private open() {
    if (!this.running || this.candidate || this.closing || this.creating)
      return;
    const createdAt = this.now();
    const entry: Entry<T> = {
      id: ++this.sequence,
      controller: new AbortController(),
      createdAt,
      deadline: createdAt + this.seconds * 1000,
      failed: false,
    };
    this.candidate = entry;
    const events: DirectorEvents = {
      limit: (seconds) => {
        if (
          !this.owns(entry) ||
          typeof seconds !== 'number' ||
          !Number.isFinite(seconds) ||
          seconds <= 0
        )
          return;
        entry.deadline = Math.min(
          entry.deadline,
          entry.createdAt + seconds * 1000,
        );
        this.publish();
      },
      ended: (message, fatal) => this.fail(entry, message, fatal),
    };
    // create may throw before returning its promise; the entry is already owned either way.
    this.creating++;
    try {
      void this.options
        .create(entry.id, entry.controller.signal, events)
        .then((session) => {
          if (!this.owns(entry)) {
            this.closeSession(session);
            return;
          }
          entry.session = session;
          this.publish();
        })
        .catch((error) => this.fail(entry, messageOf(error)))
        .finally(() => {
          this.creating--;
          this.settleDrain();
        });
    } catch (error) {
      this.creating--;
      this.settleDrain();
      this.fail(entry, messageOf(error));
    }
  }
  private take(entry: Entry<T>) {
    const epoch = this.epoch;
    const old = this.active;
    const valid = () =>
      this.running &&
      this.epoch === epoch &&
      this.candidate === entry &&
      !entry.failed &&
      entry.deadline > this.now() + 5000;
    this.taking = entry;
    this.takingAt = this.now();
    void Promise.resolve()
      .then(() => this.options.take(entry.session!, old?.session, valid))
      .then(() => {
        if (!valid()) return;
        this.active = entry;
        this.candidate = undefined;
        this.taking = undefined;
        if (old) this.rotations++;
        this.failures = 0;
        this.error = '';
        this.release(old);
        this.publish();
      })
      .catch((error) => {
        if (valid()) this.fail(entry, messageOf(error));
      })
      .finally(() => {
        if (this.epoch === epoch && this.taking === entry)
          this.taking = undefined;
      });
  }
  private owns(entry: Entry<T>) {
    return (
      this.running &&
      !entry.controller.signal.aborted &&
      (entry === this.active || entry === this.candidate)
    );
  }
  private fail(entry: Entry<T>, message: string, fatal = false) {
    if (!this.owns(entry) || entry.failed) return;
    entry.failed = true;
    this.error = message.slice(0, 350);
    if (fatal) {
      this.halt();
      return;
    }
    if (entry === this.candidate) {
      this.candidate = undefined;
      if (this.taking === entry) this.taking = undefined;
      this.release(entry);
      this.failures++;
      this.retryAt =
        this.now() + Math.min(60000, 5000 * 2 ** (this.failures - 1));
      if (this.failures >= directorPolicy.maxFailures) {
        this.halt();
        return;
      }
    }
    this.publish();
  }
  private halt() {
    void this.stop();
    this.terminal = 'error';
    this.publish();
  }
  private release(entry?: Entry<T>) {
    if (!entry) return;
    entry.controller.abort();
    if (entry.session) this.closeSession(entry.session);
  }
  private closeSession(session: T) {
    this.closing++;
    try {
      void Promise.resolve(session.close())
        .catch(() => {})
        .finally(() => {
          this.closing--;
          this.settleDrain();
        });
    } catch {
      this.closing--;
      this.settleDrain();
    }
  }
  drain(): Promise<void> {
    if (!this.closing && !this.creating) return Promise.resolve();
    return new Promise((resolve) => this.drains.add(resolve));
  }
  private settleDrain() {
    if (this.closing || this.creating) return;
    this.drains.forEach((resolve) => resolve());
    this.drains.clear();
  }
  private read(): DirectorSnapshot {
    const active = this.active;
    return {
      phase: !this.running
        ? this.terminal
        : !active
          ? this.failures
            ? 'recovering'
            : 'starting'
          : active.failed || active.session?.stalled()
            ? 'recovering'
            : this.candidate
              ? 'warming'
              : 'live',
      running: this.running,
      activeId: active?.id ?? null,
      candidateId: this.candidate?.id ?? null,
      remainingSeconds: Math.max(
        0,
        Math.ceil(((active?.deadline ?? this.now()) - this.now()) / 1000),
      ),
      bufferedSeconds: Math.floor(active?.session?.buffered() ?? 0),
      rotations: this.rotations,
      failures: this.failures,
      error: this.error,
    };
  }
  private publish() {
    this.snapshot = this.read();
    this.listeners.forEach((fn) => fn());
  }
}
