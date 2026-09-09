/** A WebRTC opening is kept from frame zero until it goes on air. Chrome/OBS WebM path. */
export class DirectorMedia {
  private static owners = new WeakMap<AudioNode, DirectorMedia>();
  readonly video = document.createElement('video');
  private readonly input = document.createElement('video');
  readonly gain: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly source: MediaElementAudioSourceNode;
  private readonly samples = new Float32Array(1024);
  private readonly media = new MediaSource();
  private readonly url: string;
  private readonly lifecycle = new AbortController();
  private buffer?: SourceBuffer;
  private recorder?: MediaRecorder;
  private stream?: MediaStream;
  private inputAudio?: MediaStreamAudioSourceNode;
  private recordingAudio?: MediaStreamAudioDestinationNode;
  private pending: ArrayBuffer[] = [];
  private pendingBytes = 0;
  private lastRemoved = 0;
  private writing = Promise.resolve();
  private closed = false;
  private faulted = false;
  private quietSince = 0;
  private lastPosition = 0;
  private advancedAt = performance.now();
  private onAir = false;
  private frameAt = 0;
  constructor(
    stage: HTMLDivElement,
    private context: AudioContext,
    private master: AudioNode,
    private onError: (error: Error) => void,
  ) {
    const mime = 'video/webm;codecs=vp8,opus';
    if (
      !MediaRecorder.isTypeSupported(mime) ||
      !MediaSource.isTypeSupported(mime)
    )
      throw Error(
        'Director requires Chrome or an OBS browser source with WebM playback.',
      );
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.preload = 'auto';
    Object.assign(this.video.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      opacity: '0',
    });
    this.gain = context.createGain();
    this.gain.gain.value = 0;
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source = context.createMediaElementSource(this.video);
    this.source.connect(this.analyser);
    this.analyser.connect(this.gain);
    this.gain.connect(master);
    this.url = URL.createObjectURL(this.media);
    this.video.src = this.url;
    stage.appendChild(this.video);
    this.media.addEventListener(
      'sourceopen',
      () => {
        if (this.closed) return;
        try {
          this.buffer = this.media.addSourceBuffer(mime);
          this.buffer.addEventListener('updateend', () => this.pump(), {
            signal: this.lifecycle.signal,
          });
          this.buffer.addEventListener(
            'error',
            () => this.fail('Director footage could not be decoded.'),
            { signal: this.lifecycle.signal },
          );
          this.pump();
        } catch {
          this.fail('Director playback buffer could not start.');
        }
      },
      { once: true, signal: this.lifecycle.signal },
    );
    this.video.addEventListener(
      'error',
      () => this.fail('Director video playback failed.'),
      { signal: this.lifecycle.signal },
    );
  }
  ingest(stream: MediaStream) {
    if (this.closed || this.recorder) return;
    this.stream = stream;
    // Chromium's remote audio source needs a playout consumer before MediaRecorder receives
    // samples. This input stays muted; only the separately buffered output reaches the mixer.
    this.input.muted = true;
    this.input.playsInline = true;
    this.input.srcObject = stream;
    void this.input
      .play()
      .catch(() => this.fail('Director input playback could not start.'));
    try {
      this.inputAudio = this.context.createMediaStreamSource(stream);
      this.recordingAudio = this.context.createMediaStreamDestination();
      this.inputAudio.connect(this.recordingAudio);
      const recordable = new MediaStream([
        ...stream.getVideoTracks(),
        ...this.recordingAudio.stream.getAudioTracks(),
      ]);
      this.recorder = new MediaRecorder(recordable, {
        mimeType: 'video/webm;codecs=vp8,opus',
        videoBitsPerSecond: 3000000,
        audioBitsPerSecond: 128000,
      });
      this.recorder.addEventListener(
        'dataavailable',
        ({ data }) => {
          if (this.closed || this.faulted || !data.size) return;
          this.pendingBytes += data.size;
          if (this.pendingBytes > 32 * 1024 * 1024) {
            this.fail('Director recording queue exceeded its memory limit.');
            return;
          }
          this.writing = this.writing
            .then(async () => {
              const bytes = await data.arrayBuffer();
              if (this.closed || this.faulted) return;
              this.pending.push(bytes);
              this.pump();
            })
            .catch(() => this.fail('Director recording could not be read.'));
        },
        { signal: this.lifecycle.signal },
      );
      this.recorder.addEventListener(
        'error',
        () => this.fail('Director recording failed.'),
        { signal: this.lifecycle.signal },
      );
      this.recorder.start(500);
    } catch {
      this.fail('Director recording could not start.');
    }
  }
  ready() {
    return (
      !this.closed &&
      !this.faulted &&
      this.video.readyState >= 2 &&
      this.buffered() >= 8
    );
  }
  buffered() {
    const ranges = this.video.buffered;
    const time = this.video.currentTime;
    for (let i = 0; i < ranges.length; i++)
      if (ranges.start(i) <= time + 0.1 && ranges.end(i) > time)
        return ranges.end(i) - time;
    return 0;
  }
  quiet() {
    if (!this.onAir || this.video.paused || this.context.state !== 'running')
      return false;
    this.analyser.getFloatTimeDomainData(this.samples);
    let power = 0;
    for (const value of this.samples) power += value * value;
    if (Math.sqrt(power / this.samples.length) >= 0.012) {
      this.quietSince = 0;
      return false;
    }
    this.quietSince ||= performance.now();
    return performance.now() - this.quietSince >= 400;
  }
  stalled() {
    if (!this.onAir || this.closed) return false;
    if (this.video.currentTime > this.lastPosition + 0.02) {
      this.lastPosition = this.video.currentTime;
      this.advancedAt = performance.now();
    }
    return (
      performance.now() - this.advancedAt > 10000 ||
      (this.frameAt > 0 && performance.now() - this.frameAt > 10000)
    );
  }
  async take(old: DirectorMedia | undefined, valid: () => boolean) {
    const check = () => {
      if (this.closed || !valid())
        throw new DOMException('Handover cancelled', 'AbortError');
    };
    check();
    // Prime a displayed frame without sound, then rewind the retained opening before transfer.
    this.video.muted = true;
    await this.bounded(this.video.play());
    check();
    await this.frame();
    check();
    this.video.pause();
    const start = this.video.buffered.start(0);
    if (this.video.currentTime > start + 0.001) {
      const seeked = this.event('seeked');
      this.video.currentTime = start;
      await seeked;
      check();
    }
    // Both changes share one audio clock: the outgoing gain reaches zero before the incoming gain rises.
    DirectorMedia.owners.set(this.master, this);
    const time = this.context.currentTime;
    old?.gain.gain.cancelScheduledValues(time);
    old?.gain.gain.setValueAtTime(0, time);
    old?.video.pause();
    if (old) {
      old.onAir = false;
      old.video.style.opacity = '0';
    }
    this.video.style.opacity = '1';
    this.video.muted = false;
    this.gain.gain.cancelScheduledValues(time);
    this.gain.gain.setValueAtTime(0, time);
    this.gain.gain.linearRampToValueAtTime(1, time + 0.012);
    try {
      await this.bounded(this.video.play());
      check();
    } catch (error) {
      this.gain.gain.cancelScheduledValues(this.context.currentTime);
      this.gain.gain.value = 0;
      this.video.pause();
      if (!this.closed) this.video.style.opacity = '0';
      if (
        old &&
        !old.closed &&
        DirectorMedia.owners.get(this.master) === this
      ) {
        DirectorMedia.owners.set(this.master, old);
        old.video.style.opacity = '1';
        old.gain.gain.value = 1;
        old.onAir = true;
        void old.video.play().catch(() => {});
      }
      throw error;
    }
    this.onAir = true;
    this.advancedAt = performance.now();
    this.lastPosition = this.video.currentTime;
    const observe = () => {
      if (!this.closed && this.onAir) {
        this.frameAt = performance.now();
        this.video.requestVideoFrameCallback(observe);
      }
    };
    this.video.requestVideoFrameCallback(observe);
  }
  stopInput() {
    if (this.recorder?.state === 'recording') this.recorder.stop();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.lifecycle.abort();
    this.stopInput();
    this.gain.gain.cancelScheduledValues(this.context.currentTime);
    this.gain.gain.value = 0;
    this.input.pause();
    this.input.srcObject = null;
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
    this.inputAudio?.disconnect();
    this.recordingAudio?.stream.getTracks().forEach((t) => t.stop());
    this.source.disconnect();
    this.analyser.disconnect();
    this.gain.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.pending = [];
    this.pendingBytes = 0;
    URL.revokeObjectURL(this.url);
  }
  private pump() {
    if (
      this.closed ||
      this.faulted ||
      !this.buffer ||
      this.buffer.updating ||
      this.media.readyState !== 'open'
    )
      return;
    const cut = this.video.currentTime - 15;
    try {
      // A remote recording can begin after zero. Decode its first playable timestamp
      // while waiting off air; otherwise ready() can wait forever outside the range.
      if (!this.onAir && this.video.paused && this.video.buffered.length) {
        const first = this.video.buffered.start(0);
        if (this.video.currentTime < first) this.video.currentTime = first;
      }
      if (cut > this.lastRemoved + 10) {
        this.lastRemoved = cut;
        this.buffer.remove(0, cut);
        return;
      }
      if (this.buffered() > 150) {
        this.fail('Director playback fell too far behind its live input.');
        return;
      }
      const bytes = this.pending.shift();
      if (bytes) {
        this.pendingBytes -= bytes.byteLength;
        this.buffer.appendBuffer(bytes);
      }
    } catch {
      this.fail('Director playback buffer could not accept more footage.');
    }
  }
  private fail(message: string) {
    if (this.closed || this.faulted) return;
    this.faulted = true;
    this.stopInput();
    this.onError(Error(message));
  }
  private event(name: string) {
    return this.bounded(
      new Promise<void>((resolve) =>
        this.video.addEventListener(name, () => resolve(), {
          once: true,
          signal: this.lifecycle.signal,
        }),
      ),
    );
  }
  private frame() {
    return this.bounded(
      new Promise<void>((resolve) =>
        this.video.requestVideoFrameCallback(() => resolve()),
      ),
    );
  }
  private bounded<T>(promise: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const signal = this.lifecycle.signal;
      const abort = () =>
        finish(() => reject(new DOMException('Director closed', 'AbortError')));
      const timeout = setTimeout(
        () => finish(() => reject(Error('Director playback did not start.'))),
        5000,
      );
      const finish = (fn: () => void) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        fn();
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      promise.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  }
}
