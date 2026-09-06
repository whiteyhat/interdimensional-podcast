import { opening, type Line, type Speaker } from './show';
export type Clip = Line & {
  url: string;
  rawUrl: string;
  duration: number;
  renderMs: number;
};
export type Slot = Line & {
  status: 'rendering' | 'ready' | 'failed';
  clip?: Clip;
  error?: string;
};
export type Cue = {
  id: string;
  text: string;
  status: 'queued' | 'writing' | 'buffered' | 'on-air';
  shot?: number;
};
export type Services = {
  write: (recent: Line[], start: number, cue?: string) => Promise<Line[]>;
  render: (line: Line) => Promise<Clip>;
  release: (url: string) => void;
};
export type Snapshot = {
  phase: 'idle' | 'buffering' | 'playing' | 'paused' | 'waiting' | 'stopped';
  current: Clip | null;
  previous: Clip | null;
  slots: Slot[];
  history: Clip[];
  cues: Cue[];
  writing: boolean;
  error: string;
  initialMs: number | null;
  stalls: number;
  aired: number;
};
const initial = (): Snapshot => ({
  phase: 'idle',
  current: null,
  previous: null,
  slots: [],
  history: [],
  cues: [],
  writing: false,
  error: '',
  initialMs: null,
  stalls: 0,
  aired: 0,
});
export class Podcast {
  private state = initial();
  private listeners = new Set<() => void>();
  private run = 0;
  private started = 0;
  private draft: Line[] = [];
  private writing = false;
  private active = 0;
  private ended = false;
  private writingEpoch = 0;
  constructor(private services: Services) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private set(patch: Partial<Snapshot>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  private running() {
    return ['buffering', 'playing', 'waiting', 'paused'].includes(
      this.state.phase,
    );
  }
  start() {
    if (this.running()) return;
    this.dispose();
    this.state = initial();
    this.draft = opening.map((l) => ({ ...l }));
    this.started = Date.now();
    this.set({ phase: 'buffering' });
    this.pump();
  }
  stop() {
    ++this.run;
    this.writingEpoch++;
    this.active = 0;
    this.writing = false;
    this.set({ phase: 'stopped', writing: false });
  }
  dispose() {
    this.stop();
    const urls = new Set([
      this.state.current?.url,
      this.state.previous?.url,
      ...this.state.slots.map((s) => s.clip?.url),
    ]);
    for (const url of urls) if (url) this.services.release(url);
    this.draft = [];
    this.ended = false;
  }
  cue(text: string) {
    text = text.trim().slice(0, 240);
    if (!text) return;
    // Only discard unsubmitted dialogue. Paid/in-flight shots retain their ordering.
    this.draft = [];
    this.writingEpoch++;
    const item: Cue = { id: crypto.randomUUID(), text, status: 'queued' };
    this.set({
      cues: [
        ...this.state.cues.filter(
          (c) => c.status !== 'queued' && c.status !== 'writing',
        ),
        item,
      ].slice(-12),
      error: '',
    });
    this.pump();
  }
  pause() {
    if (this.state.phase === 'playing') this.set({ phase: 'paused' });
    else if (this.state.phase === 'paused') {
      this.set({ phase: this.ended ? 'waiting' : 'playing' });
      if (this.ended) this.advance();
      this.pump();
    }
  }
  clipEnded(id: number) {
    if (this.state.current?.id !== id || this.ended || !this.running()) return;
    this.ended = true;
    if (this.state.phase !== 'paused') this.advance();
  }
  shown(id: number) {
    if (this.state.current?.id !== id) return;
    const previous = this.state.previous;
    if (previous) this.services.release(previous.url);
    this.set({ previous: null });
  }
  private advance() {
    const first = this.state.slots[0];
    if (!first?.clip || first.status !== 'ready') {
      if (this.state.phase !== 'waiting')
        this.set({ phase: 'waiting', stalls: this.state.stalls + 1 });
      this.pump();
      return;
    }
    const old = this.state.current;
    this.ended = false;
    this.set({
      current: first.clip,
      previous: old,
      slots: this.state.slots.slice(1),
      phase: 'playing',
      history: [...this.state.history, first.clip].slice(-100),
      aired: this.state.aired + 1,
      cues: this.state.cues.map((c) =>
        c.shot === first.id ? { ...c, status: 'on-air' } : c,
      ),
      initialMs: this.state.initialMs ?? Date.now() - this.started,
    });
    this.pump();
  }
  retry() {
    this.set({ error: '' });
    for (const slot of this.state.slots.filter(s=>s.status==='failed').slice(0,Math.max(0,2-this.active)))
      if (slot.status === 'failed') {
        this.set({
          slots: this.state.slots.map((s) =>
            s.id === slot.id
              ? { ...s, status: 'rendering', error: undefined }
              : s,
          ),
        });
        this.launch(slot, this.run);
      }
    this.pump();
  }
  private pump() {
    if (!this.running() || this.state.phase === 'paused') return;
    const run = this.run;
    while (
      this.active < 2 &&
      this.state.slots.length < 4 &&
      this.draft.length
    ) {
      const line = this.draft.shift()!;
      this.set({
        slots: [...this.state.slots, { ...line, status: 'rendering' }],
      });
      this.launch(line, run);
    }
    if (
      this.state.phase === 'buffering' &&
      this.state.slots.slice(0, 3).length === 3 &&
      this.state.slots.slice(0, 3).every((s) => s.status === 'ready')
    ) {
      this.advance();
      return;
    }
    if (
      this.state.phase === 'waiting' &&
      this.state.slots[0]?.status === 'ready'
    ) {
      this.advance();
      return;
    }
    if (
      this.draft.length === 0 &&
      this.state.slots.length < 4 &&
      !this.writing &&
      !this.state.error
    ) {
      void this.writeNext(run);
    }
  }
  private launch(line: Line, run: number) {
    this.active++;
    void this.services
      .render(line)
      .then(
        (clip) => {
          if (run !== this.run) {
            this.services.release(clip.url);
            return;
          }
          this.set({
            slots: this.state.slots.map((s) =>
              s.id === line.id ? { ...s, status: 'ready', clip } : s,
            ),
          });
        },
        (e) => {
          if (run !== this.run) return;
          this.set({
            slots: this.state.slots.map((s) =>
              s.id === line.id
                ? { ...s, status: 'failed', error: String(e) }
                : s,
            ),
            error:
              e instanceof Error
                ? e.message
                : 'A shot failed. Retry keeps the existing job where possible.',
          });
        },
      )
      .finally(() => {
        if (run !== this.run) return;
        this.active--;
        this.pump();
      });
  }
  private async writeNext(run: number) {
    this.writing = true;
    const epoch = this.writingEpoch;
    const cue = this.state.cues.find((c) => c.status === 'queued');
    const recent: Line[] = [...this.state.history, ...this.state.slots]
      .slice(-12)
      .map(({ id, speaker, text }) => ({ id, speaker, text }));
    const next = (recent.at(-1)?.id ?? -1) + 1;
    this.set({
      writing: true,
      cues: this.state.cues.map((c) =>
        c.id === cue?.id ? { ...c, status: 'writing' } : c,
      ),
    });
    try {
      const lines = await this.services.write(recent, next, cue?.text);
      if (run !== this.run) return;
      if (epoch !== this.writingEpoch) return;
      if (
        lines.length !== 4 ||
        lines.some(
          (l, i) =>
            l.id !== next + i ||
            l.speaker !==
              (((next + i) % 2 === 0 ? 'host' : 'guest') as Speaker),
        )
      )
        throw Error('Writer returned out-of-order dialogue');
      this.draft = lines;
      this.set({
        cues: this.state.cues.map((c) =>
          c.id === cue?.id ? { ...c, status: 'buffered', shot: next } : c,
        ),
      });
    } catch (e) {
      if (run === this.run)
        this.set({
          error: e instanceof Error ? e.message : 'The writer failed.',
          cues: this.state.cues.map((c) =>
            c.id === cue?.id ? { ...c, status: 'queued' } : c,
          ),
        });
    } finally {
      if (run === this.run) {
        this.writing = false;
        this.set({ writing: false });
        this.pump();
      }
    }
  }
}
