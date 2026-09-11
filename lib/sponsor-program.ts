import type { Line, Speaker } from './show';
import type {
  SponsorFulfillment,
  SponsorLease,
  SponsorStatus,
} from './sponsorship';

export type SponsorReference = { orderId: string; leaseToken: string };
export type SponsorCue = SponsorReference & {
  stage: 'intro' | 'callback';
  at: number;
};
export type SponsorTurn = SponsorReference & {
  stage: 'intro' | 'callback';
  exchangeId: number;
  first: boolean;
  last: boolean;
  product: SponsorLease['draft']['product'];
  name: string;
  projectName?: string;
  projectUrl?: string;
  assetUrl?: string | null;
};
export type Wardrobe = SponsorReference & {
  target: Speaker;
  assetId: string;
  designHash: string;
  sourceUrl: string;
  templateVersion: string;
};
export type SponsorEvent = SponsorReference & {
  eventId: string;
  type: 'prepare' | 'start' | 'progress' | 'complete' | 'paused';
  stage?: 'intro' | 'callback';
  appearanceId?: string;
  visibleMs?: number;
};
export type SponsorDelivery = SponsorLease & {
  phase: 'queued' | 'writing' | 'buffered' | 'playing' | 'paused' | 'fulfilled';
  error?: string;
};
export type SponsorServices = {
  sync: () => Promise<SponsorLease[]>;
  event: (event: SponsorEvent) => Promise<{
    status?: SponsorStatus;
    fulfillment?: SponsorFulfillment | null;
  }>;
  offline?: () => Promise<void>;
};
type Placement = SponsorDelivery & {
  firstShot?: number;
  firstAppliedShot?: number;
  pending?: 'intro' | 'callback';
  retired?: boolean;
};
/** The program owns delivery decisions. Only playback callbacks can advance its counters. */
export class SponsorProgram {
  private orders = new Map<string, Placement>();
  private lastPaidAt = -Infinity;
  private serial: Promise<unknown> = Promise.resolve();
  private played = new Set<string>();
  private active = new Set<string>();
  private epoch = 0;
  private pendingSync?: Promise<void>;
  private quarantined = new Set<string>();
  private pendingPauses = new Map<
    string,
    { order: Placement; eventId: string }
  >();
  constructor(
    private service: SponsorServices,
    private changed: () => void = () => {},
  ) {}
  snapshot(): SponsorDelivery[] {
    return [...this.orders.values()].map((o) => ({
      ...o,
      fulfillment: { ...o.fulfillment },
    }));
  }
  beginRun() {
    this.lastPaidAt = -Infinity;
  }
  sync() {
    if (!this.pendingSync)
      this.pendingSync = this.refresh().finally(() => {
        this.pendingSync = undefined;
      });
    return this.pendingSync;
  }
  private async refresh() {
    const epoch = this.epoch;
    await this.serial.catch(() => {});
    await this.drainPauses();
    if (this.pendingPauses.size)
      throw Error(
        'Sponsorship recovery is waiting for a pause acknowledgment. Delivery leases are not being renewed.',
      );
    const leases = await this.service.sync();
    if (epoch !== this.epoch) return;
    const present = new Set(leases.map((o) => o.id));
    for (const order of this.orders.values()) {
      if (
        !present.has(order.id) &&
        !['fulfilled', 'paused'].includes(order.phase)
      ) {
        order.phase = 'paused';
        order.error = 'Delivery ownership changed. Awaiting reschedule.';
        this.active.delete(order.id);
      }
    }
    for (const lease of leases) {
      if (this.quarantined.has(lease.leaseToken)) continue;
      const previous = this.orders.get(lease.id);
      if (
        previous?.leaseToken === lease.leaseToken &&
        previous.phase !== 'paused'
      ) {
        previous.leaseUntil = lease.leaseUntil;
        // A pull may have begun just before a played event; never replace its newer counters.
      } else {
        const resumeCap =
          lease.draft.product === 'cap' && lease.fulfillment.intro;
        this.orders.set(lease.id, {
          ...lease,
          phase: resumeCap ? 'buffered' : 'queued',
          ...(resumeCap ? { firstShot: 0 } : {}),
        });
      }
    }
    this.changed();
  }
  canSchedulePaid(at: number) {
    return at - this.lastPaidAt >= 120;
  }
  reservePaid(at: number) {
    this.lastPaidAt = Math.max(this.lastPaidAt, at);
  }
  nextCue(at: number): SponsorCue | undefined {
    if (!this.canSchedulePaid(at)) return;
    for (const order of this.orders.values()) {
      if (order.pending || ['paused', 'fulfilled'].includes(order.phase))
        continue;
      const stage = !order.fulfillment.intro
        ? 'intro'
        : order.draft.product === 'cap' &&
            !order.fulfillment.callback &&
            order.fulfillment.visibleMs >= 500000
          ? 'callback'
          : undefined;
      if (!stage) continue;
      order.pending = stage;
      order.phase = 'writing';
      this.changed();
      return { orderId: order.id, leaseToken: order.leaseToken, stage, at };
    }
  }
  failedWrite(cue: SponsorCue) {
    const order = this.orders.get(cue.orderId);
    if (
      order?.leaseToken === cue.leaseToken &&
      !['paused', 'fulfilled'].includes(order.phase)
    ) {
      order.pending = undefined;
      order.phase = this.active.has(order.id) ? 'playing' : 'queued';
      this.changed();
    }
  }
  written(cue: SponsorCue, lines: Line[]): Line[] {
    const order = this.required(cue);
    this.reservePaid(cue.at);
    order.phase = 'buffered';
    if (cue.stage === 'intro') order.firstShot = lines[0].id;
    this.changed();
    return lines.map((line, index) => ({
      ...line,
      sponsorship: {
        orderId: order.id,
        leaseToken: order.leaseToken,
        stage: cue.stage,
        exchangeId: lines[0].id,
        first: index === 0,
        last: index === lines.length - 1,
        product: order.draft.product,
        name: order.draft.name,
        projectName: order.draft.projectName,
        projectUrl: order.draft.projectUrl,
        assetUrl: order.assetUrl,
      },
    }));
  }
  /** A wardrobe identity is pinned once, before submitting each render job. */
  decorate(line: Line, previousSpeaker?: Speaker): Line {
    for (const order of this.orders.values()) {
      if (
        order.draft.product !== 'cap' ||
        order.draft.target !== line.speaker ||
        ['paused', 'fulfilled', 'queued'].includes(order.phase) ||
        order.firstShot === undefined ||
        line.id < order.firstShot
      )
        continue;
      if (
        order.firstAppliedShot === undefined &&
        previousSpeaker === line.speaker
      )
        continue;
      const metadata = order.assetMetadata;
      if (
        !metadata ||
        typeof metadata.sourceUrl !== 'string' ||
        typeof metadata.sha256 !== 'string' ||
        typeof metadata.templateVersion !== 'string' ||
        !order.draft.assetId
      )
        continue;
      order.firstAppliedShot ??= line.id;
      return {
        ...line,
        gesture: undefined,
        wardrobe: {
          orderId: order.id,
          leaseToken: order.leaseToken,
          target: line.speaker,
          sourceUrl: metadata.sourceUrl,
          designHash: metadata.sha256,
          templateVersion: metadata.templateVersion,
          assetId: order.draft.assetId,
        },
      };
    }
    return line;
  }
  private required(ref: SponsorReference) {
    const order = this.orders.get(ref.orderId);
    if (
      !order ||
      this.quarantined.has(ref.leaseToken) ||
      order.leaseToken !== ref.leaseToken ||
      order.phase === 'paused' ||
      (order.phase === 'fulfilled' && order.retired)
    )
      throw Error('This placement was cancelled or rescheduled.');
    return order;
  }
  private enqueue<T>(work: () => Promise<T>) {
    const operation = this.serial.then(work, work);
    this.serial = operation.catch(() => {});
    return operation;
  }
  private async event(
    order: Placement,
    event: Omit<SponsorEvent, keyof SponsorReference>,
  ) {
    const result = await this.service.event({
      ...event,
      orderId: order.id,
      leaseToken: order.leaseToken,
    });
    if (result.fulfillment) order.fulfillment = { ...result.fulfillment };
    if (result.status === 'fulfilled') {
      order.phase = 'fulfilled';
      this.active.delete(order.id);
    }
    this.changed();
  }
  private id(order: Placement, shot: number, kind: string) {
    return `${order.leaseToken}:${shot}:${kind}`;
  }
  needsGate(line: Line) {
    return (
      !!line.sponsorship ||
      !!line.wardrobe ||
      this.active.size > 0 ||
      [...this.orders.values()].some(
        (o) =>
          o.draft.product === 'cap' && o.phase === 'fulfilled' && !o.retired,
      )
    );
  }
  private references(line?: Line) {
    const refs = new Map<string, SponsorReference>();
    for (const id of this.active) {
      const order = this.orders.get(id)!;
      refs.set(id, { orderId: id, leaseToken: order.leaseToken });
    }
    if (line?.sponsorship) refs.set(line.sponsorship.orderId, line.sponsorship);
    if (line?.wardrobe) refs.set(line.wardrobe.orderId, line.wardrobe);
    return refs;
  }
  private queuePauses(
    refs: Iterable<SponsorReference>,
    shot: number,
    error: unknown,
  ) {
    for (const ref of refs) {
      const order = this.orders.get(ref.orderId);
      if (
        !order ||
        order.leaseToken !== ref.leaseToken ||
        order.phase === 'fulfilled'
      )
        continue;
      if (!this.quarantined.has(ref.leaseToken))
        this.pendingPauses.set(ref.leaseToken, {
          order,
          eventId: this.id(order, shot, 'compensating-pause'),
        });
      this.quarantined.add(ref.leaseToken);
      order.phase = 'paused';
      order.pending = undefined;
      order.error =
        error instanceof Error ? error.message : 'Delivery was interrupted.';
      this.active.delete(order.id);
    }
    this.changed();
  }
  private async drainPauses() {
    for (const [lease, intent] of this.pendingPauses) {
      try {
        const result = await this.service.event({
          orderId: intent.order.id,
          leaseToken: lease,
          eventId: intent.eventId,
          type: 'paused',
        });
        if (result.status !== 'paused') continue;
        if (result.fulfillment)
          intent.order.fulfillment = { ...result.fulfillment };
        this.pendingPauses.delete(lease);
      } catch (error) {
        // The server has explicitly established that this old lease cannot authorize playback.
        if ((error as { code?: string }).code === 'LEASE')
          this.pendingPauses.delete(lease);
      }
    }
    this.changed();
  }
  before(line: Line) {
    return this.enqueue(async () => {
      for (const order of this.orders.values())
        if (order.phase === 'fulfilled' && order.draft.target !== line.speaker)
          order.retired = true;
      const refs = this.references(line);
      try {
        for (const ref of refs.values()) {
          const order = this.required(ref);
          // A finished cap can persist until the cut to the other host, so it never pops off mid-camera.
          if (order.phase === 'fulfilled') continue;
          await this.event(order, {
            eventId: this.id(order, line.id, 'prepare'),
            type: 'prepare',
          });
          this.required(ref);
          if (
            order.draft.product !== 'cap' ||
            line.wardrobe?.orderId === order.id ||
            this.active.has(order.id)
          ) {
            await this.event(order, {
              eventId: this.id(order, line.id, 'start'),
              type: 'start',
            });
            this.required(ref);
            order.phase = 'playing';
            if (order.draft.product === 'cap') this.active.add(order.id);
          }
        }
      } catch (error) {
        // Earlier refs may already have committed start, including when their response was lost.
        this.queuePauses(refs.values(), line.id, error);
        await this.drainPauses();
        throw error;
      }
    });
  }
  ended(line: Line & { duration: number }) {
    return this.enqueue(async () => {
      const refs = new Set(this.active);
      if (line.sponsorship) refs.add(line.sponsorship.orderId);
      for (const id of refs) {
        const order = this.orders.get(id);
        if (!order || order.phase !== 'playing') continue;
        const eventId = this.id(order, line.id, 'played');
        if (this.played.has(eventId)) continue;
        const stage =
          line.sponsorship?.orderId === id && line.sponsorship.last
            ? line.sponsorship.stage
            : undefined;
        try {
          await this.event(order, {
            eventId,
            type: 'progress',
            visibleMs:
              order.draft.product === 'cap'
                ? Math.floor(line.duration * 1000)
                : 0,
            ...(line.wardrobe?.orderId === id
              ? { appearanceId: this.id(order, line.id, 'appearance') }
              : {}),
            ...(stage ? { stage } : {}),
          });
          this.played.add(eventId);
          if (stage) order.pending = undefined;
          const f = order.fulfillment;
          if (
            f.intro &&
            (order.draft.product !== 'cap' ||
              (f.callback && f.visibleMs >= 600000 && f.appearances >= 6))
          ) {
            await this.event(order, {
              eventId: this.id(order, line.id, 'complete'),
              type: 'complete',
            });
            order.phase = 'fulfilled';
            this.active.delete(order.id);
          }
        } catch (error) {
          this.queuePauses(
            [{ orderId: order.id, leaseToken: order.leaseToken }],
            line.id,
            error,
          );
          await this.drainPauses();
        }
      }
      this.changed();
    });
  }
  /** Pause relinquishes delivery; a new lease resumes the unfinished work where it stopped. */
  failedRender(line: Line, error: unknown) {
    this.queuePauses(this.references(line).values(), line.id, error);
    return this.enqueue(() => this.drainPauses());
  }
  playbackFailed(line: Line, error: unknown) {
    const refs = this.references(line);
    if (!refs.size) return false;
    this.queuePauses(refs.values(), line.id, error);
    void this.enqueue(() => this.drainPauses());
    return true;
  }
  failedExchange(cue: SponsorCue, shot: number, error: unknown) {
    return this.failedPlacement(cue, shot, error);
  }
  private failedPlacement(
    reference: SponsorReference,
    shot: number,
    error: unknown,
  ) {
    this.queuePauses([reference], shot, error);
    return this.enqueue(() => this.drainPauses());
  }
  /** Pause relinquishes delivery; a new lease resumes the unfinished work where it stopped. */
  stop() {
    ++this.epoch;
    this.queuePauses(
      [...this.orders.values()]
        .filter((o) => o.phase !== 'fulfilled')
        .map((o) => ({ orderId: o.id, leaseToken: o.leaseToken })),
      -this.epoch,
      Error('The producer paused delivery.'),
    );
    const pendingSync = this.pendingSync;
    return this.enqueue(async () => {
      // An in-flight heartbeat must settle before the final offline announcement.
      await pendingSync?.catch(() => {});
      await this.drainPauses();
      this.active.clear();
      this.changed();
      // Even an offline heartbeat renews leases on the server; never send one while pause is ambiguous.
      if (!this.pendingPauses.size)
        await this.service.offline?.().catch(() => {});
    });
  }
}
