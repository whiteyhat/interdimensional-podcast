import { isBeat, opening, runsOk, shotDuration, type Line } from './show';
import { GestureSchedule } from './gestures';
import {
  SponsorProgram,
  type SponsorCue,
  type SponsorDelivery,
  type SponsorServices,
} from './sponsor-program';
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
  StudioBusyError,
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
  /** Verified end of the scripted utterance; the remaining picture plays silently. */
  speechEnd?: number;
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
    sponsorship?: SponsorCue,
  ) => Promise<Line[]>;
  render: (line: Line) => Promise<Clip>;
  release: (url: string) => void;
  research?: (input: ResearchInput) => Promise<ResearchResult>;
  news?: (input: ResearchInput) => Promise<ResearchResult>;
  requests?: RequestServices;
  sponsors?: SponsorServices;
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
  sponsors: SponsorDelivery[];
  sponsorError: string;
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
export type BufferPolicy = {
  startupSeconds: number;
  targetSeconds: number;
  recoverySeconds: number;
  concurrency: number;
  maxSlots: number;
};
export const bufferConfig: BufferPolicy = {
  startupSeconds: 40,
  targetSeconds: 60,
  recoverySeconds: 30,
  concurrency: 3,
  maxSlots: 8,
};
/** Only uninterrupted, decoded footage can protect the next cut. */
export function readySeconds(slots: Slot[]) {
  let seconds = 0;
  for (const slot of slots) {
    if (slot.status !== 'ready' || !slot.clip) break;
    seconds += slot.clip.duration;
  }
  return seconds;
}
const initial = (): Snapshot => ({
  phase: 'idle',
  current: null,
  previous: null,
  slots: [],
  history: [],
  requests: [],
  sponsors: [],
  sponsorError: '',
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
  private draftSponsorId?: string;
  private inflightSponsorId?: string;
  private sponsorProgram?: SponsorProgram;
  private sponsorTimer?: ReturnType<typeof setInterval>;
  private sponsorSyncing = false;
  private advancing = false;
  private playbackEpoch = 0;
  private paidBuffered = false;
  private lastPaidAt = -Infinity;
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
  private pendingAired = new Set<string>();
  private coinMemory: CoinMemory = createCoinMemory();
  private viewers?: number;
  // The wire outlives a single run, so a restart keeps the topics already gathered.
  private queue: TopicQueueState = createQueue();
  constructor(
    private services: Services,
    private policy: BufferPolicy = bufferConfig,
  ) {
    if (services.sponsors)
      this.sponsorProgram = new SponsorProgram(services.sponsors, () =>
        this.set({ sponsors: this.sponsorProgram!.snapshot() }),
      );
  }
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
    this.lastPaidAt = Number.isFinite(this.lastPaidAt) ? 0 : -Infinity;
    this.paidBuffered = false;
    this.sponsorProgram?.beginRun();
    this.gestures = new GestureSchedule();
    this.set({ phase: 'buffering', ...this.queuePatch() });
    if (this.sponsorProgram) {
      this.sponsorTimer = setInterval(() => void this.syncSponsors(), 10000);
      void this.syncSponsors();
    }
    this.pump();
  }
  stop() {
    ++this.playbackEpoch;
    ++this.run;
    this.writingEpoch++;
    this.active = 0;
    this.writing = false;
    this.inflightRequestId = undefined;
    this.inflightSponsorId = undefined;
    this.advancing = false;
    clearInterval(this.sponsorTimer);
    this.sponsorTimer = undefined;
    void this.sponsorProgram?.stop();
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
    this.draftSponsorId = undefined;
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
    if (this.draft.length && !this.draftRequestId && !this.draftSponsorId) {
      this.draft = [];
    }
    if (this.writing && !this.inflightRequestId && !this.inflightSponsorId)
      this.writingEpoch++;
    this.set({ requests, error: '' });
    this.pump();
  }
  pause() {
    ++this.playbackEpoch;
    if (this.state.phase === 'playing') {
      this.set({ phase: 'paused' });
      void this.sponsorProgram?.stop();
    } else if (this.state.phase === 'paused') {
      if (this.state.current?.sponsorship || this.state.current?.wardrobe)
        this.ended = true;
      this.set({ phase: this.ended ? 'waiting' : 'playing' });
      void this.syncSponsors();
      if (this.ended) this.advance();
      this.pump();
    }
  }
  clipEnded(id: number) {
    if (this.state.current?.id !== id || this.ended || !this.running()) return;
    const clip = this.state.current;
    this.playedSeconds += clip.duration;
    this.ended = true;
    const completed = this.state.requests.filter(
      (request) =>
        request.status === 'on-air' && this.requestEnds.get(request.id) === id,
    );
    if (completed.length) {
      for (const request of completed) {
        this.requestEnds.delete(request.id);
        this.pendingAired.add(request.reference);
      }
      this.set({
        requests: this.state.requests.map((request) =>
          completed.includes(request)
            ? { ...request, status: 'aired' as const }
            : request,
        ),
      });
      void this.reportAired();
    }
    if (this.sponsorProgram?.needsGate(clip)) {
      const run = this.run;
      void this.sponsorProgram.ended(clip).finally(() => {
        if (run === this.run && this.state.phase !== 'paused') this.advance();
      });
    } else if (this.state.phase !== 'paused') this.advance();
  }
  shown(id: number) {
    if (this.state.current?.id !== id) return;
    const previous = this.state.previous;
    if (previous) this.services.release(previous.url);
    this.set({ previous: null });
  }
  playbackFailed(id: number, url: string, reason: string) {
    const current = this.state.current;
    if (!current || current.id !== id || current.url !== url || !this.running())
      return false;
    if (!this.sponsorProgram?.playbackFailed(current, Error(reason)))
      return false;
    ++this.playbackEpoch;
    this.ended = true;
    const held = this.state.previous ?? current;
    if (held !== current) this.services.release(current.url);
    this.set({
      current: null,
      previous: held,
      phase: 'waiting',
      sponsorError:
        'Playback was interrupted. The sponsorship is being rescheduled.',
    });
    this.pump();
    return true;
  }
  private advance(authorized = false) {
    const first = this.state.slots[0];
    if (first?.status === 'ready') this.queue = markOnAir(this.queue, first.id);
    if (!first?.clip || first.status !== 'ready') {
      if (this.state.phase !== 'waiting')
        this.set({ phase: 'waiting', stalls: this.state.stalls + 1 });
      this.pump();
      return;
    }
    if (this.sponsorProgram?.needsGate(first.clip) && !authorized) {
      if (this.advancing) return;
      this.advancing = true;
      const run = this.run;
      const playbackEpoch = this.playbackEpoch;
      void this.sponsorProgram
        .before(first.clip)
        .then(
          () => {
            if (
              run === this.run &&
              playbackEpoch === this.playbackEpoch &&
              this.state.phase !== 'paused' &&
              this.state.slots[0]?.id === first.id
            )
              this.advance(true);
          },
          () => {
            if (run !== this.run) return;
            this.rejectPlacement(first);
          },
        )
        .finally(() => {
          if (run === this.run) {
            this.advancing = false;
            this.pump();
          }
        });
      return;
    }
    const old = this.state.current ?? this.state.previous;
    this.ended = false;
    const before = this.state.requests;
    const requests = before.map((r) => {
      if (r.shot === first.id && r.status === 'buffered')
        return { ...r, status: 'on-air' as const };
      return r;
    });
    if (
      first.sponsorship?.first ||
      requests.some(
        (r, i) => r.status === 'on-air' && before[i].status === 'buffered',
      )
    ) {
      this.lastPaidAt = this.playedSeconds;
      this.paidBuffered = false;
    }
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
  /** Cancelled ads never air; ordinary dialogue with an obsolete cap is rendered again without it. */
  private rejectPlacement(first: Slot) {
    if (first.sponsorship) {
      const id = first.sponsorship.orderId;
      const removed = this.state.slots.filter(
        (slot) => slot.sponsorship?.orderId === id,
      );
      for (const slot of removed)
        if (slot.clip) this.services.release(slot.clip.url);
      this.draft = this.draft.filter(
        (line) => line.sponsorship?.orderId !== id,
      );
      this.paidBuffered = false;
      this.set({
        slots: this.state.slots.filter(
          (slot) => slot.sponsorship?.orderId !== id,
        ),
        sponsorError:
          'An interrupted sponsorship is being rescheduled. Editorial conversation continues.',
      });
    } else if (first.wardrobe) {
      if (first.clip) this.services.release(first.clip.url);
      const line = {
        ...first,
        wardrobe: undefined,
        clip: undefined,
        status: 'rendering' as const,
        error: undefined,
      };
      this.set({
        slots: this.state.slots.map((slot) =>
          slot.id === first.id ? line : slot,
        ),
      });
      this.launch(line, this.run);
    }
    if (this.ended) this.set({ phase: 'waiting' });
  }
  private async syncSponsors() {
    if (
      !this.sponsorProgram ||
      !this.running() ||
      this.state.phase === 'paused' ||
      this.sponsorSyncing
    )
      return;
    this.sponsorSyncing = true;
    const run = this.run;
    try {
      await this.sponsorProgram.sync();
      if (run === this.run) this.set({ sponsorError: '' });
    } catch (error) {
      if (run === this.run) {
        if (error instanceof StudioBusyError) this.standDown(error.message);
        else
          this.set({
            sponsorError:
              error instanceof Error
                ? error.message
                : 'Sponsorship delivery is temporarily unavailable.',
          });
      }
    } finally {
      this.sponsorSyncing = false;
      if (run === this.run) this.pump();
    }
  }
  retry() {
    this.writeFailures = 0;
    this.set({ error: '' });
    for (const slot of this.state.slots
      .filter((s) => s.status === 'failed')
      .slice(0, Math.max(0, this.policy.concurrency - this.active)))
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
    if (this.state.coin)
      this.set({ coin: { ...this.state.coin, viewers: count } });
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
      this.reportAired()
        .then(() => requests.pull())
        .then(
          (batch) => {
            if (run !== this.run) return;
            for (const item of batch) this.request(item);
          },
          (e) => {
            if (run === this.run && e instanceof StudioBusyError)
              this.standDown(e.message);
          },
        ),
    );
  }
  private async reportAired() {
    if (!this.services.requests) return;
    await Promise.allSettled(
      [...this.pendingAired].map(async (reference) => {
        await this.services.requests!.aired(reference);
        this.pendingAired.delete(reference);
      }),
    );
  }
  /**
   * Leave the air for something only the operator can fix, and say so plainly. Used when
   * another studio holds the queue: retrying would just generate the show twice.
   */
  private standDown(reason: string) {
    this.stop();
    this.set({ error: reason || 'Another studio is on air.' });
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
      this.active < this.policy.concurrency &&
      this.needsFootage() &&
      this.draft.length
    ) {
      const draft = this.draft[0];
      // Include committed footage, but never count a finished frame held during an underrun twice.
      const startsAt =
        this.playedSeconds +
        (this.state.current && !this.ended ? this.state.current.duration : 0) +
        this.state.slots.reduce(
          (seconds, slot) =>
            seconds +
            (slot.clip?.duration ?? shotDuration(slot.text, slot.gesture)),
          0,
        );
      // Precise gesture timing may wait only when enough playable footage protects the air.
      // Otherwise render this line normally and leave the gesture due for a later short turn.
      const deferGesture =
        this.gestures.isDue(draft.speaker, isBeat(draft.text), startsAt) &&
        this.state.slots.some((slot) => slot.status !== 'ready');
      if (
        deferGesture &&
        readySeconds(this.state.slots) >= this.policy.startupSeconds
      )
        break;
      this.draft.shift();
      const decorated =
        this.sponsorProgram?.decorate(
          draft,
          this.state.slots.at(-1)?.speaker ?? this.state.current?.speaker,
        ) ?? draft;
      const gesture =
        deferGesture || decorated.wardrobe
          ? undefined
          : this.gestures.reserve(
              draft.speaker,
              isBeat(draft.text),
              startsAt,
              draft.id,
            );
      const line: Line = { ...decorated, gesture };
      this.set({
        slots: [...this.state.slots, { ...line, status: 'rendering' }],
      });
      this.launch(line, run);
    }
    if (!this.draft.length) {
      this.draftRequestId = undefined;
      this.draftSponsorId = undefined;
    }
    if (
      this.state.phase === 'buffering' &&
      readySeconds(this.state.slots) >= this.policy.startupSeconds
    ) {
      this.advance();
      return;
    }
    if (
      this.state.phase === 'waiting' &&
      readySeconds(this.state.slots) >= this.policy.recoverySeconds
    ) {
      this.advance();
      return;
    }
    if (
      this.draft.length === 0 &&
      this.needsFootage() &&
      !this.writing &&
      !this.state.error
    ) {
      void this.writeNext(run);
    }
  }
  private needsFootage() {
    const committed = this.state.slots.reduce(
      (seconds, slot) =>
        seconds +
        (slot.clip?.duration ?? shotDuration(slot.text, slot.gesture)),
      0,
    );
    return (
      this.state.slots.length < this.policy.maxSlots &&
      committed < this.policy.targetSeconds
    );
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
          if (!this.state.slots.some((slot) => slot.id === line.id)) {
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
        async (e) => {
          if (run !== this.run) return;
          if (line.sponsorship || line.wardrobe) {
            await this.sponsorProgram?.failedRender(line, e);
            if (run === this.run)
              this.rejectPlacement({ ...line, status: 'failed' });
            return;
          }
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
    const paidEligible =
      !this.paidBuffered && this.playedSeconds - this.lastPaidAt >= 120;
    const sponsorship = paidEligible
      ? this.sponsorProgram?.nextCue(this.playedSeconds)
      : undefined;
    const request =
      !sponsorship && paidEligible
        ? nextQueued(this.state.requests)
        : undefined;
    const topic = request || sponsorship ? undefined : pickTopic(this.queue);
    if (topic) this.queue = markTopic(this.queue, topic.id, 'writing');
    this.inflightRequestId = request?.id;
    this.inflightSponsorId = sponsorship?.orderId;
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
        sponsorship,
      );
      if (run !== this.run) return;
      if (epoch !== this.writingEpoch) {
        if (sponsorship) this.sponsorProgram?.failedWrite(sponsorship);
        // A paid request cancelled this batch; the topic goes back on the wire.
        if (topic) {
          this.queue = markTopic(this.queue, topic.id, 'queued');
          this.set({ topics: this.queue.topics });
        }
        if (request)
          this.set({
            requests: markRequest(this.state.requests, request.id, 'queued'),
          });
        return;
      }
      // The writer now chooses who speaks, so the show only checks that the batch is
      // four sequential turns by real characters and that neither one holds the floor
      // for more than two shots in a row, counting the last line already committed.
      if (
        lines.length !== 4 ||
        lines.some(
          (l, i) =>
            l.id !== next + i ||
            (l.speaker !== 'host' && l.speaker !== 'guest'),
        ) ||
        !runsOk(
          lines.map((l) => l.speaker),
          recent.at(-1)?.speaker,
        )
      )
        throw Error('Writer returned out-of-order dialogue');
      this.draft = sponsorship
        ? this.sponsorProgram!.written(sponsorship, lines)
        : lines;
      this.draftRequestId = request?.id;
      this.draftSponsorId = sponsorship?.orderId;
      if (request || sponsorship) this.paidBuffered = true;
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
      if (sponsorship) this.sponsorProgram?.failedWrite(sponsorship);
      if (run === this.run) {
        if (topic) this.queue = markTopic(this.queue, topic.id, 'queued');
        // A rejected exchange is common enough that the show writes another one
        // instead of stopping. Only a run of failures is worth interrupting for.
        const giveUp = ++this.writeFailures >= 3;
        if (giveUp && sponsorship) {
          await this.sponsorProgram?.failedExchange(sponsorship, next, e);
          if (run !== this.run) return;
          this.writeFailures = 0;
        }
        this.set({
          error:
            giveUp && !sponsorship
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
        this.inflightSponsorId = undefined;
        this.set({ writing: false });
        this.pump();
      }
    }
  }
}
