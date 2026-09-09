import { createFalClient } from '@fal-ai/client';
import {
  wma,
  type RealtimeOpenOptions,
  type WmaOptions,
} from '@fal-ai/client/realtime';
import { cast } from './show';
import { DirectorMedia } from './director-media';
import { DirectorProgram, type DirectorBrief } from './director-program';
import {
  DirectorRotation,
  type DirectorEvents,
  type DirectorSession,
} from './director-rotation';
const fal = createFalClient({
  proxyUrl: '/api/director',
  retry: { maxRetries: 0 },
});
type Connection = { send(message: object): void; close(): Promise<void> };
type Connect = (options: RealtimeOpenOptions & WmaOptions) => Connection;
const connectFal: Connect = (options) =>
  fal.realtime.open(wma('minimax/h3-max/director'), options);
export class LiveDirectorSession implements DirectorSession {
  readonly media: DirectorMedia;
  private handle?: Connection;
  private muteTimers = new Map<
    MediaStreamTrack,
    ReturnType<typeof setTimeout>
  >();
  private lifecycle = new AbortController();
  private ended = false;
  private closed = false;
  private closing?: Promise<void>;
  private version = 1;
  private nextDirection = Infinity;
  private directing = false;
  private received = new MediaStream();
  constructor(
    readonly id: number,
    stage: HTMLDivElement,
    context: AudioContext,
    master: AudioNode,
    private events: DirectorEvents,
    readonly brief: DirectorBrief,
    private program: DirectorProgram,
    private onBrief: (brief: DirectorBrief) => void,
    private connect: Connect = connectFal,
  ) {
    this.media = new DirectorMedia(stage, context, master, (error) =>
      this.fail(error.message),
    );
  }
  open(signal: AbortSignal) {
    signal.throwIfAborted();
    signal.addEventListener(
      'abort',
      () => {
        void this.close();
      },
      { once: true, signal: this.lifecycle.signal },
    );
    let configured = false;
    this.handle = this.connect({
      receive: ['video', 'audio'],
      negotiationTimeoutMs: 90000,
      abortSignal: this.lifecycle.signal,
      onState: (state) => {
        if (state === 'live' && !configured && !this.closed) {
          configured = true;
          this.handle?.send({
            type: 'configure',
            protocol_version: 1,
            prompt_version: 1,
            prompt: this.brief.prompt,
            image_url: cast.host.source,
            seed: cast.host.seed,
            resolution: '768p',
            aspect_ratio: '16:9',
            memory: 12,
            audio_bitrate: 128000,
          });
        }
      },
      onMedia: (stream) => {
        const accept = () => {
          if (this.closed || this.ended) return;
          for (const track of stream.getTracks())
            if (!this.received.getTracks().includes(track)) {
              this.received.addTrack(track);
              track.addEventListener(
                'unmute',
                () => {
                  clearTimeout(this.muteTimers.get(track));
                  this.muteTimers.delete(track);
                  accept();
                },
                { signal: this.lifecycle.signal },
              );
              track.addEventListener(
                'mute',
                () => {
                  clearTimeout(this.muteTimers.get(track));
                  this.muteTimers.set(
                    track,
                    setTimeout(() => {
                      this.muteTimers.delete(track);
                      if (track.muted)
                        this.fail(`Director ${track.kind} delivery stopped.`);
                    }, 10000),
                  );
                },
                { signal: this.lifecycle.signal },
              );
              track.addEventListener(
                'ended',
                () => this.fail('Director media track ended.'),
                { signal: this.lifecycle.signal },
              );
            }
          if (
            this.received.getVideoTracks().some((t) => !t.muted) &&
            this.received.getAudioTracks().some((t) => !t.muted)
          )
            this.media.ingest(this.received);
        };
        stream.addEventListener('addtrack', accept, {
          signal: this.lifecycle.signal,
        });
        accept();
      },
      onData: (raw) => {
        if (this.closed || this.ended) return;
        let data: {
          type?: string;
          max_session_seconds?: number;
          reason?: string;
          code?: string;
          error?: string;
        };
        try {
          data = JSON.parse(raw);
        } catch {
          return;
        }
        if (!data || typeof data !== 'object') return;
        if (
          data.type === 'session_info' &&
          typeof data.max_session_seconds === 'number'
        )
          this.events.limit(data.max_session_seconds);
        if (data.type === 'stream_exhausted')
          this.fail(`Director stream ended: ${data.reason ?? 'unknown'}.`);
        if (data.type === 'error')
          this.fail(
            data.error || 'Director generation failed.',
            [
              'balance_unavailable',
              'content_policy',
              'immutable_settings',
              'invalid_initial_image',
              'invalid_message',
            ].includes(data.code || ''),
          );
      },
      onError: (error) =>
        this.fail(
          error instanceof Error
            ? error.message
            : 'Director connection failed.',
        ),
    });
  }
  ready = () => !this.ended && this.media.ready();
  quiet = () => this.media.quiet();
  stalled = () => this.media.stalled();
  buffered = () => this.media.buffered();
  async take(old: LiveDirectorSession | undefined, valid: () => boolean) {
    await this.media.take(old?.media, valid);
    if (!valid()) return;
    this.onBrief(this.brief);
    this.nextDirection = performance.now() + 120000;
  }
  tick() {
    if (
      this.closed ||
      this.ended ||
      this.directing ||
      performance.now() < this.nextDirection
    )
      return;
    this.directing = true;
    this.nextDirection = performance.now() + 120000;
    void this.program
      .next(this.lifecycle.signal)
      .then((brief) => {
        if (this.closed || this.ended) return;
        this.handle?.send({
          type: 'prompt',
          prompt_version: ++this.version,
          prompt: brief.prompt,
          replan: false,
        });
        this.onBrief(brief);
      })
      .catch(() => {})
      .finally(() => {
        this.directing = false;
      });
  }
  private fail(message: string, fatal = false) {
    if (this.closed || this.ended) return;
    this.ended = true;
    this.clearMuteTimers();
    this.media.stopInput();
    void this.handle?.close().catch(() => {});
    this.events.ended(message, fatal);
  }
  private clearMuteTimers() {
    this.muteTimers.forEach(clearTimeout);
    this.muteTimers.clear();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    let finish!: () => void;
    // Install the shared promise before abort listeners can re-enter close().
    this.closing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.closed = true;
    this.clearMuteTimers();
    try {
      if (!this.ended) this.handle?.send({ type: 'stop' });
    } catch {
      /* A dead channel is already closed. */
    }
    this.lifecycle.abort();
    this.media.close();
    this.received.getTracks().forEach((track) => track.stop());
    try {
      void Promise.resolve(this.handle?.close())
        .catch(() => {})
        .finally(finish);
    } catch {
      finish();
    }
    return this.closing;
  }
}
export function createDirector(
  stage: HTMLDivElement,
  context: AudioContext,
  master: AudioNode,
  sessionSeconds: number,
  onBrief: (brief: DirectorBrief) => void,
) {
  const program = new DirectorProgram();
  const feeds = new Map<number, LiveDirectorSession>();
  const rotation = new DirectorRotation<LiveDirectorSession>({
    sessionSeconds,
    create: async (id, signal, events) => {
      const brief = await program.next(signal);
      signal.throwIfAborted();
      const feed = new LiveDirectorSession(
        id,
        stage,
        context,
        master,
        events,
        brief,
        program,
        onBrief,
      );
      feeds.set(id, feed);
      signal.addEventListener('abort', () => feeds.delete(id), { once: true });
      try {
        feed.open(signal);
        return feed;
      } catch (error) {
        await feed.close();
        throw error;
      }
    },
    take: (next, old, valid) => next.take(old, valid),
  });
  return {
    rotation,
    tick() {
      rotation.tick();
      feeds.get(rotation.getSnapshot().activeId ?? -1)?.tick();
    },
  };
}
