import { opening, shotDuration, type Line, type Speaker } from './show';
import {
  avoidTitles,
  batchWritten,
  briefOf,
  createQueue,
  dismiss,
  enqueue,
  expire,
  laneDepth,
  markOnAir,
  markTopic,
  pickTopic,
  prefilterComments,
  promote,
  researchSettled,
  researchStarted,
  resetRuntime,
  setFeedEnabled,
  shouldResearch,
  type Comment,
  type FeedState,
  type RankInput,
  type RankResult,
  type ResearchInput,
  type ResearchResult,
  type Topic,
  type TopicBrief,
  type TopicDraft,
  type TopicQueueState,
} from './topics';
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
  write: (
    recent: Line[],
    start: number,
    cue?: string,
    topic?: TopicBrief,
  ) => Promise<Line[]>;
  render: (line: Line) => Promise<Clip>;
  release: (url: string) => void;
  research?: (input: ResearchInput) => Promise<ResearchResult>;
  news?: (input: ResearchInput) => Promise<ResearchResult>;
  rank?: (input: RankInput) => Promise<RankResult>;
};
export type Snapshot = {
  phase: 'idle' | 'buffering' | 'playing' | 'paused' | 'waiting' | 'stopped';
  current: Clip | null;
  previous: Clip | null;
  slots: Slot[];
  history: Clip[];
  cues: Cue[];
  topics: Topic[];
  feed: FeedState;
  batches: number;
  ranking: boolean;
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
  topics: [],
  feed: createQueue().feed,
  batches: 0,
  ranking: false,
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
  private writeFailures = 0;
  private newsAt = 0;
  private newsInflight = false;
  // The wire outlives a single run, so a restart keeps the topics already gathered.
  private queue: TopicQueueState = createQueue();
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
    this.writeFailures = 0;
    this.queue = resetRuntime(this.queue);
    this.draft = opening.map((l) => ({ ...l }));
    this.started = Date.now();
    this.set({ phase: 'buffering', ...this.queuePatch() });
    this.pump();
  }
  stop() {
    ++this.run;
    this.writingEpoch++;
    this.active = 0;
    this.writing = false;
    this.queue = resetRuntime(this.queue);
    this.set({ phase: 'stopped', writing: false, ...this.queuePatch() });
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
  // The only destructive entry point: an audience prompt interrupts unwritten dialogue.
  // Feed and chat topics queue up instead, so automated sources can never starve the buffer.
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
    if (first?.status === 'ready') this.queue = markOnAir(this.queue, first.id);
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
      topics: this.queue.topics,
      initialMs: this.state.initialMs ?? Date.now() - this.started,
    });
    this.pump();
  }
  retry() {
    this.writeFailures = 0;
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
  setFeed(enabled: boolean) {
    this.queue = setFeedEnabled(this.queue, enabled);
    this.set(this.queuePatch());
    this.pump();
  }
  enqueueTopics(drafts: TopicDraft[]) {
    this.queue = enqueue(this.queue, drafts, Date.now());
    this.set(this.queuePatch());
    this.pump();
  }
  promoteTopic(id: string) {
    this.queue = promote(this.queue, id);
    this.set({ topics: this.queue.topics });
    this.pump();
  }
  dismissTopic(id: string) {
    this.queue = dismiss(this.queue, id);
    this.set({ topics: this.queue.topics });
  }
  clearTopics() {
    for (const topic of this.queue.topics.filter((t) => t.status === 'queued'))
      this.queue = dismiss(this.queue, topic.id);
    this.set({ topics: this.queue.topics });
  }
  ingestComments(batch: Comment[]) {
    const rank = this.services.rank;
    const comments = prefilterComments(batch);
    if (!rank || !comments.length || this.state.ranking) return;
    this.set({ ranking: true });
    void rank({
      comments,
      recentTitles: avoidTitles(this.queue),
      onAir: this.onAirTitle(),
    })
      .then(
        (result) => {
          this.queue = enqueue(this.queue, result.topics, Date.now());
        },
        (e) => {
          this.queue = {
            ...this.queue,
            feed: {
              ...this.queue.feed,
              error: e instanceof Error ? e.message : 'Ranking failed.',
            },
          };
        },
      )
      .finally(() => {
        this.set({ ranking: false, ...this.queuePatch() });
        this.pump();
      });
  }
  private queuePatch(): Partial<Snapshot> {
    return {
      topics: this.queue.topics,
      feed: this.queue.feed,
      batches: this.queue.batches,
    };
  }
  private onAirTitle() {
    return (
      this.state.topics.find((t) => t.status === 'on-air')?.title ??
      this.state.cues.find((c) => c.status === 'on-air')?.text
    );
  }
  // The free lane. Cheap and silent: it never touches state.error or the paid lane's cost.
  private pumpNews(run: number) {
    const news = this.services.news;
    if (!news || this.newsInflight) return;
    const now = Date.now();
    if (laneDepth(this.queue, 'web') >= 8 || now - this.newsAt < 90000) return;
    this.newsInflight = true;
    this.newsAt = now;
    void news({ avoid: avoidTitles(this.queue) })
      .then(
        (result) => {
          this.queue = enqueue(this.queue, result.topics, Date.now());
        },
        () => {}, // a quiet lane failing is not worth telling the operator about
      )
      .finally(() => {
        this.newsInflight = false;
        this.set(this.queuePatch());
        if (run === this.run) this.pump();
      });
  }
  // Research runs beside the show: it never blocks a write and never sets state.error.
  private pumpFeed(run: number) {
    const research = this.services.research;
    if (!research) return;
    const now = Date.now();
    this.queue = expire(this.queue, now);
    if (!shouldResearch(this.queue, now)) return;
    this.queue = researchStarted(this.queue, now);
    this.set(this.queuePatch());
    void research({
      avoid: avoidTitles(this.queue),
      onAir: this.onAirTitle(),
    })
      .then(
        (result) => {
          const before = this.queue.topics.length;
          this.queue = enqueue(this.queue, result.topics, Date.now());
          this.queue = researchSettled(this.queue, {
            ok: true,
            now: Date.now(),
            added: this.queue.topics.length - before,
            cost: result.cost,
          });
        },
        (e) => {
          this.queue = researchSettled(this.queue, {
            ok: false,
            now: Date.now(),
            error: e instanceof Error ? e.message : String(e),
          });
        },
      )
      .finally(() => {
        this.set(this.queuePatch());
        if (run === this.run) this.pump();
      });
  }
  private pump() {
    if (!this.running() || this.state.phase === 'paused') return;
    const run = this.run;
    this.pumpFeed(run);
    this.pumpNews(run);
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
    const topic = cue ? undefined : pickTopic(this.queue);
    if (topic) this.queue = markTopic(this.queue, topic.id, 'writing');
    const recent: Line[] = [...this.state.history, ...this.state.slots]
      .slice(-12)
      .map(({ id, speaker, text }) => ({ id, speaker, text }));
    const next = (recent.at(-1)?.id ?? -1) + 1;
    this.set({
      writing: true,
      cues: this.state.cues.map((c) =>
        c.id === cue?.id ? { ...c, status: 'writing' } : c,
      ),
      topics: this.queue.topics,
    });
    try {
      const lines = await this.services.write(
        recent,
        next,
        cue?.text,
        topic && briefOf(topic),
      );
      if (run !== this.run) return;
      if (epoch !== this.writingEpoch) {
        // An audience prompt cancelled this batch; the topic goes back on the wire.
        if (topic) {
          this.queue = markTopic(this.queue, topic.id, 'queued');
          this.set({ topics: this.queue.topics });
        }
        return;
      }
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
      this.writeFailures = 0;
      if (topic) this.queue = markTopic(this.queue, topic.id, 'buffered', next);
      this.queue = batchWritten(
        this.queue,
        topic,
        lines.reduce((total, line) => total + shotDuration(line.text), 0),
      );
      this.set({
        cues: this.state.cues.map((c) =>
          c.id === cue?.id ? { ...c, status: 'buffered', shot: next } : c,
        ),
        ...this.queuePatch(),
      });
    } catch (e) {
      if (run === this.run) {
        if (topic) this.queue = markTopic(this.queue, topic.id, 'queued');
        // A rejected exchange is common enough that the show writes another one
        // instead of stopping. Only a run of failures is worth interrupting for.
        const giveUp = ++this.writeFailures >= 3;
        this.set({
          error: giveUp
            ? e instanceof Error
              ? e.message
              : 'The writer failed.'
            : '',
          cues: this.state.cues.map((c) =>
            c.id === cue?.id ? { ...c, status: 'queued' } : c,
          ),
          topics: this.queue.topics,
        });
      }
    } finally {
      if (run === this.run) {
        this.writing = false;
        this.set({ writing: false });
        this.pump();
      }
    }
  }
}
