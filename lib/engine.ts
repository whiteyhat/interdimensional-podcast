import { isBeat, opening, runsOk, shotDuration, type Line } from './show';
import { GestureSchedule } from './gestures';
import {
  avoidTitles,
  batchWritten,
  briefOf,
  createQueue,
  enqueue,
  expire,
  laneDepth,
  markOnAir,
  markTopic,
  pickTopic,
  prefilterComments,
  rankComments,
  researchSettled,
  researchStarted,
  resetRuntime,
  setFeedEnabled,
  shouldResearch,
  supersedeLane,
  topicConfig,
  type Comment,
  type FeedState,
  type ResearchInput,
  type ResearchResult,
  type Topic,
  type TopicBrief,
  type TopicDraft,
  type TopicQueueState,
} from './topics';
import {
  markRequest,
  mergeIncoming,
  nextQueued,
  trimRequests,
  type PaidRequest,
} from './requests';
import {
  coinDrafts,
  createCoinMemory,
  pumpEvents,
  type CoinMemory,
  type CoinSnapshot,
} from './coin';
export type { PaidRequest } from './requests';
export type { CoinSnapshot } from './coin';
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
/** The site hands paid requests to the studio and hears back when one reaches the air. */
export type RequestServices = {
  pull: () => Promise<PaidRequest[]>;
  aired: (reference: string) => Promise<void>;
};
/** What the coin route answers: the chart, and whether the coin exists yet. */
export type CoinReading = { launched: boolean; coin: CoinSnapshot | null };
export type Services = {
  write: (
    recent: Line[],
    start: number,
    cue?: string,
    topic?: TopicBrief,
    from?: string,
  ) => Promise<Line[]>;
  render: (line: Line) => Promise<Clip>;
  release: (url: string) => void;
  research?: (input: ResearchInput) => Promise<ResearchResult>;
  news?: (input: ResearchInput) => Promise<ResearchResult>;
  requests?: RequestServices;
  /** The show's own chart; the snapshot is null until the coin is launched. */
  coin?: () => Promise<CoinReading>;
};
export type Snapshot = {
  phase: 'idle' | 'buffering' | 'playing' | 'paused' | 'waiting' | 'stopped';
  current: Clip | null;
  previous: Clip | null;
  slots: Slot[];
  history: Clip[];
  requests: PaidRequest[];
  coin: CoinSnapshot | null;
  /** null until the coin lane's first answer; false means the coin has not launched yet. */
  coinLaunched: boolean | null;
  coinError: string;
  topics: Topic[];
  feed: FeedState;
  batches: number;
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
  requests: [],
  coin: null,
  coinLaunched: null,
  coinError: '',
  topics: [],
  feed: createQueue().feed,
  batches: 0,
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
  /** Which paid request the unsent draft belongs to, if any; topic drafts carry nothing. */
  private draftRequestId?: string;
  private writing = false;
  private inflightRequestId?: string;
  private active = 0;
  private ended = false;
  private playedSeconds = 0;
  private gestures = new GestureSchedule();
  private writingEpoch = 0;
  private writeFailures = 0;
  /** When each polling lane last called out, and whether that call is still open. */
  private lanes = new Map<string, { at: number; inflight: boolean }>();
  /** The last shot of each request's written batch, so airing never assumes a batch length. */
  private requestEnds = new Map<string, number>();
  private coinMemory: CoinMemory = createCoinMemory();
  private viewers?: number;
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
    // Paid requests were bought; a restart must not lose one that has not aired yet.
    const owed = this.state.requests
      .filter((r) => r.status !== 'aired')
      .map((r) => ({ ...r, status: 'queued' as const, shot: undefined }));
    this.state = {
      ...initial(),
      requests: owed,
      coin: this.state.coin,
      coinLaunched: this.state.coinLaunched,
    };
    this.writeFailures = 0;
    this.queue = resetRuntime(this.queue);
    this.draft = opening.map((l) => ({ ...l }));
    this.draftRequestId = undefined;
    this.started = Date.now();
    this.playedSeconds = 0;
    this.gestures = new GestureSchedule();
    this.set({ phase: 'buffering', ...this.queuePatch() });
    this.pump();
  }
  stop() {
    ++this.run;
    this.writingEpoch++;
    this.active = 0;
    this.writing = false;
    this.inflightRequestId = undefined;
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
    this.draftRequestId = undefined;
    this.requestEnds.clear();
    this.ended = false;
  }
  // The only destructive entry point: a paid request interrupts unwritten topic dialogue.
  // Feed and chat topics queue up instead, and a paid batch already being written is never
  // cancelled by the next paid request, so every purchase airs in the order it arrived.
  request(item: PaidRequest) {
    const before = this.state.requests;
    const requests = mergeIncoming(before, [item]);
    if (requests === before) return;
    if (this.draft.length && !this.draftRequestId) {
      this.draft = [];
    }
    if (this.writing && !this.inflightRequestId) this.writingEpoch++;
    this.set({ requests, error: '' });
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
    this.playedSeconds += this.state.current.duration;
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
    const before = this.state.requests;
    const requests = before.map((r) => {
      if (r.shot === first.id && r.status === 'buffered')
        return { ...r, status: 'on-air' as const };
      // Once the conversation has moved past the last shot of its batch, the request is done.
      const end = this.requestEnds.get(r.id);
      if (r.status === 'on-air' && end !== undefined && first.id > end)
        return { ...r, status: 'aired' as const };
      return r;
    });
    // The site hears about a request once, on the edge where it reaches the air.
    requests.forEach((r, i) => {
      if (r.status === 'on-air' && before[i].status === 'buffered')
        void this.services.requests?.aired(r.reference).catch(() => {});
      if (r.status === 'aired') this.requestEnds.delete(r.id);
    });
    this.set({
      current: first.clip,
      previous: old,
      slots: this.state.slots.slice(1),
      phase: 'playing',
      history: [...this.state.history, first.clip].slice(-100),
      aired: this.state.aired + 1,
      requests: trimRequests(requests),
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
  /** Live viewer count from the stream chat; folded into the next chart snapshot. */
  setViewers(count: number) {
    if (!Number.isFinite(count) || count < 0 || count === this.viewers) return;
    this.viewers = count;
    if (this.state.coin) this.set({ coin: { ...this.state.coin, viewers: count } });
  }
  /** Chat ranking is a pure heuristic, so it runs here rather than over the network. */
  ingestComments(batch: Comment[]) {
    // A busy room offers more comments than the show can answer; the wire keeps a few at a time.
    if (laneDepth(this.queue, 'chat') >= topicConfig.chatDepth) return;
    const comments = prefilterComments(batch);
    if (!comments.length) return;
    const picked = rankComments(comments, avoidTitles(this.queue));
    if (!picked.length) return;
    this.queue = enqueue(this.queue, picked, Date.now());
    this.set(this.queuePatch());
    this.pump();
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
      this.state.requests.find((r) => r.status === 'on-air')?.text
    );
  }
  /**
   * A background lane that calls out on its own clock: one call in flight at a time,
   * never more often than everyMs, and a pump when it settles. The work decides what,
   * if anything, reaches the snapshot.
   */
  private lane(name: string, everyMs: number, work: () => Promise<unknown>) {
    const lane = this.lanes.get(name) ?? { at: 0, inflight: false };
    this.lanes.set(name, lane);
    const now = Date.now();
    if (lane.inflight || now - lane.at < everyMs) return;
    lane.inflight = true;
    lane.at = now;
    const run = this.run;
    void work().finally(() => {
      lane.inflight = false;
      if (run === this.run) this.pump();
    });
  }
  // The free lane. Cheap and silent: it never touches state.error or the paid lane's cost.
  private pumpNews() {
    const news = this.services.news;
    if (!news || laneDepth(this.queue, 'web') >= 8) return;
    this.lane('news', 90000, async () => {
      await news({ avoid: avoidTitles(this.queue) }).then(
        (result) => {
          this.queue = enqueue(this.queue, result.topics, Date.now());
        },
        () => {}, // a quiet lane failing is not worth telling the operator about
      );
      this.set(this.queuePatch());
    });
  }
  // Paid requests arrive through the site. Also quiet: a failed pull simply waits for the next pump.
  private pumpRequests(run: number) {
    const requests = this.services.requests;
    if (!requests) return;
    this.lane('requests', 8000, () =>
      requests.pull().then((batch) => {
        if (run !== this.run) return;
        for (const item of batch) this.request(item);
      }, () => {}),
    );
  }
  /**
   * Read the chart once, whatever the show is doing. The lanes only run while the show is
   * on air, but the producer opens the console before that and still wants a live chart.
   */
  readCoin() {
    this.pumpCoin(this.run);
  }
  // The chart lane: a snapshot every twenty seconds, and only a real move becomes a topic.
  private pumpCoin(run: number) {
    const coin = this.services.coin;
    if (!coin) return;
    this.lane('coin', 20000, () =>
      coin().then(
        (reading) => {
          if (run !== this.run) return;
          if (!reading.coin) {
            this.set({ coinLaunched: reading.launched, coinError: '' });
            return;
          }
          const next =
            this.viewers === undefined
              ? reading.coin
              : { ...reading.coin, viewers: this.viewers };
          const { events, memory } = pumpEvents({
            prev: this.state.coin ?? undefined,
            next,
            memory: this.coinMemory,
            now: Date.now(),
          });
          this.coinMemory = memory;
          const drafts = coinDrafts(events).slice(0, 1);
          if (drafts.length) {
            // The newest chart event replaces an older one still waiting its turn.
            this.queue = supersedeLane(this.queue, 'coin');
            this.queue = enqueue(this.queue, drafts, Date.now());
          }
          this.set({
            coin: next,
            coinLaunched: reading.launched,
            coinError: '',
            ...this.queuePatch(),
          });
        },
        // The card keeps showing the last good snapshot; the failure is only a note beside it.
        (e: unknown) => {
          if (run !== this.run) return;
          this.set({
            coinError: e instanceof Error ? e.message : 'Chart unavailable',
          });
        },
      ),
    );
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
    this.pumpRequests(run);
    this.pumpCoin(run);
    this.pumpFeed(run);
    this.pumpNews();
    while (
      this.active < 2 &&
      this.state.slots.length < 4 &&
      this.draft.length
    ) {
      const draft = this.draft[0];
      // Include committed footage, but never count a finished frame held during an underrun twice.
      const startsAt = this.playedSeconds
        + (this.state.current && !this.ended ? this.state.current.duration : 0)
        + this.state.slots.reduce((seconds, slot) => seconds
          + (slot.clip?.duration ?? shotDuration(slot.text, slot.gesture)), 0);
      // Keep a due short turn until its predecessors decode. Skipping it would starve gestures
      // whenever the renderer runs behind playback; reserving early would guess at their spacing.
      if (this.gestures.isDue(draft.speaker, isBeat(draft.text), startsAt)
        && this.state.slots.some((slot) => slot.status !== 'ready')) break;
      this.draft.shift();
      const gesture = this.gestures.reserve(draft.speaker, isBeat(draft.text), startsAt, draft.id);
      const line: Line = { ...draft, gesture };
      this.set({
        slots: [...this.state.slots, { ...line, status: 'rendering' }],
      });
      this.launch(line, run);
    }
    if (!this.draft.length) this.draftRequestId = undefined;
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
          this.gestures.rendered(line.id, clip.duration);
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
    const request = nextQueued(this.state.requests);
    const topic = request ? undefined : pickTopic(this.queue);
    if (topic) this.queue = markTopic(this.queue, topic.id, 'writing');
    this.inflightRequestId = request?.id;
    const recent: Line[] = [...this.state.history, ...this.state.slots]
      .slice(-12)
      .map(({ id, speaker, text }) => ({ id, speaker, text }));
    const next = (recent.at(-1)?.id ?? -1) + 1;
    this.set({
      writing: true,
      requests: request
        ? markRequest(this.state.requests, request.id, 'writing')
        : this.state.requests,
      topics: this.queue.topics,
    });
    try {
      const lines = await this.services.write(
        recent,
        next,
        request?.text,
        topic && briefOf(topic),
        request?.from,
      );
      if (run !== this.run) return;
      if (epoch !== this.writingEpoch) {
        // A paid request cancelled this batch; the topic goes back on the wire.
        if (topic) {
          this.queue = markTopic(this.queue, topic.id, 'queued');
          this.set({ topics: this.queue.topics });
        }
        if (request)
          this.set({ requests: markRequest(this.state.requests, request.id, 'queued') });
        return;
      }
      // The writer now chooses who speaks, so the show only checks that the batch is
      // four sequential turns by real characters and that neither one holds the floor
      // for more than two shots in a row, counting the last line already committed.
      if (
        lines.length !== 4 ||
        lines.some(
          (l, i) =>
            l.id !== next + i || (l.speaker !== 'host' && l.speaker !== 'guest'),
        ) ||
        !runsOk(
          lines.map((l) => l.speaker),
          recent.at(-1)?.speaker,
        )
      )
        throw Error('Writer returned out-of-order dialogue');
      this.draft = lines;
      this.draftRequestId = request?.id;
      this.writeFailures = 0;
      if (topic) this.queue = markTopic(this.queue, topic.id, 'buffered', next);
      // Remember where this batch ends so airing does not have to know how long a batch is.
      if (request) this.requestEnds.set(request.id, next + lines.length - 1);
      this.queue = batchWritten(
        this.queue,
        topic,
        lines.reduce((total, line) => total + shotDuration(line.text), 0),
      );
      this.set({
        requests: request
          ? markRequest(this.state.requests, request.id, 'buffered', next)
          : this.state.requests,
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
          requests: request
            ? markRequest(this.state.requests, request.id, 'queued')
            : this.state.requests,
          topics: this.queue.topics,
        });
      }
    } finally {
      if (run === this.run) {
        this.writing = false;
        this.inflightRequestId = undefined;
        this.set({ writing: false });
        this.pump();
      }
    }
  }
}
