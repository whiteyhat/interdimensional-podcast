import type { Gesture } from './gestures';

/** What plays after the verified line on a faded clip: studio air, and a small sound for the gesture. */
export type AudioBed = { gesture?: Gesture };

/** One audible source, with the verified speech boundary enforced on the audio clock. */
export class PlaybackAudio {
  private readonly gain: GainNode;
  private readonly master: GainNode;
  private readonly sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  private current?: HTMLMediaElement;
  private source?: MediaElementAudioSourceNode;
  private end = 0;
  private bed?: AudioBed;
  /** Every node of the running bed, sources included, so one sweep silences and releases it. */
  private bedNodes: AudioNode[] = [];
  private muted = false;
  private brown?: AudioBuffer;
  private white?: AudioBuffer;
  constructor(readonly context: AudioContext = new AudioContext()) {
    this.master = context.createGain();
    this.master.connect(context.destination);
    this.gain = context.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(this.master);
  }
  attach(video: HTMLMediaElement, speechEnd: number, bed?: AudioBed) {
    this.silence();
    this.source?.disconnect();
    let source = this.sources.get(video);
    if (!source) {
      source = this.context.createMediaElementSource(video);
      this.sources.set(video, source);
    }
    this.current = video;
    this.source = source;
    this.end = speechEnd;
    this.bed = Number.isFinite(speechEnd) ? bed : undefined;
    source.connect(this.gain);
  }
  /** Synthesized sources bypass the element's own mute, so the mute button drives the master gain. */
  setMuted(muted: boolean) {
    this.muted = muted;
    this.master.gain.setValueAtTime(muted ? 0 : 1, this.context.currentTime);
    // Unmuting re-syncs the clip, which rebuilds the bed for whatever tail is left.
    if (muted) this.stopBed();
  }
  resume() { return this.context.resume(); }
  silence(video?: HTMLMediaElement) {
    if (video && video !== this.current) return;
    const now = this.context.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(0, now);
    this.stopBed();
  }
  sync(video: HTMLMediaElement) {
    if (video !== this.current) return;
    this.silence();
    if (video.paused || video.ended || video.seeking || this.context.state !== 'running') return;
    const now = this.context.currentTime;
    if (this.end === Infinity) {
      // No boundary: the whole soundtrack airs.
      this.gain.gain.setValueAtTime(1, now);
      return;
    }
    const left = (this.end - video.currentTime) / video.playbackRate;
    if (left > 0 && Number.isFinite(left)) {
      const fade = Math.min(0.012, left);
      this.gain.gain.setValueAtTime(1, now);
      this.gain.gain.setValueAtTime(1, now + left - fade);
      this.gain.gain.linearRampToValueAtTime(0, now + left);
    }
    if (this.bed) this.startBed(video);
  }
  async close() {
    this.silence();
    this.source?.disconnect();
    this.gain.disconnect();
    this.master.disconnect();
    await this.context.close();
  }
  private stopBed() {
    for (const node of this.bedNodes) {
      if (node instanceof AudioScheduledSourceNode) {
        try { node.stop(); } catch { /* already stopped */ }
      }
      node.disconnect();
    }
    this.bedNodes = [];
  }
  /** A faded tail is never dead air: studio room tone runs to the cut, and a gesture gets its sound. */
  private startBed(video: HTMLMediaElement) {
    if (this.muted) return;
    const now = this.context.currentTime;
    const rate = video.playbackRate;
    const remaining = Number.isFinite(video.duration)
      ? (video.duration - video.currentTime) / rate
      : 12;
    const until = now + Math.max(0, remaining);
    const from = now + Math.max(0, (this.end - video.currentTime) / rate);
    if (until <= from) return;
    this.room(from, until);
    const cue = this.bed?.gesture;
    // The cue lives on the clip's own timeline, 0.4 s after the verified line: a resync inside
    // the tail (a stall, a mute toggle, the sound button) must never play it a second time.
    const cueAt = now + (this.end + 0.4 - video.currentTime) / rate;
    if (cue && cueAt >= now && cueAt + 0.1 < until) this.foley(cue, cueAt, until);
  }
  /** Dull noise for the room: white noise through a one-pole low-pass keeps the hiss out. */
  private brownBuffer() {
    if (this.brown) return this.brown;
    const buffer = this.context.createBuffer(1, this.context.sampleRate * 2, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      last = last * 0.9 + (Math.random() * 2 - 1) * 0.1;
      data[i] = last;
    }
    this.brown = buffer;
    return buffer;
  }
  /** Full-band noise for the foley bursts; the filters in burst() do the shaping. */
  private whiteBuffer() {
    if (this.white) return this.white;
    const buffer = this.context.createBuffer(1, this.context.sampleRate * 2, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.white = buffer;
    return buffer;
  }
  private chain(source: AudioScheduledSourceNode, ...nodes: AudioNode[]) {
    let last: AudioNode = source;
    for (const node of nodes) last = last.connect(node);
    last.connect(this.master);
    this.bedNodes.push(source, ...nodes);
  }
  private burst(start: number, seconds: number, peak: number, filter: { type: BiquadFilterType; frequency: number; q?: number }, attack = 0.005) {
    const source = this.context.createBufferSource();
    source.buffer = this.whiteBuffer();
    source.loop = true;
    const shape = this.context.createBiquadFilter();
    shape.type = filter.type;
    shape.frequency.value = filter.frequency;
    if (filter.q) shape.Q.value = filter.q;
    const envelope = this.context.createGain();
    // Attack, a body that holds, then a tail: a burst that only decays is gone before it is heard.
    const hold = start + attack + (seconds - attack) * 0.55;
    envelope.gain.value = 0;
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(peak, start + attack);
    envelope.gain.setValueAtTime(peak, hold);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
    this.chain(source, shape, envelope);
    source.start(start);
    source.stop(start + seconds + 0.05);
  }
  private ping(start: number, frequency: number, seconds: number, peak: number) {
    const osc = this.context.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    const envelope = this.context.createGain();
    envelope.gain.value = 0;
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(peak, start + 0.003);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
    this.chain(osc, envelope);
    osc.start(start);
    osc.stop(start + seconds + 0.05);
  }
  private room(from: number, until: number) {
    const source = this.context.createBufferSource();
    source.buffer = this.brownBuffer();
    source.loop = true;
    const shape = this.context.createBiquadFilter();
    shape.type = 'lowpass';
    shape.frequency.value = 2500;
    const envelope = this.context.createGain();
    // Ramps shrink on a short tail so the automation stays in order and the tone still plays.
    const span = until - from;
    const rise = Math.min(0.25, span / 2);
    const fall = Math.min(0.3, span / 2);
    envelope.gain.value = 0;
    envelope.gain.setValueAtTime(0, from);
    envelope.gain.linearRampToValueAtTime(0.02, from + rise);
    envelope.gain.setValueAtTime(0.02, until - fall);
    envelope.gain.linearRampToValueAtTime(0, until);
    this.chain(source, shape, envelope);
    source.start(from);
    source.stop(until + 0.05);
  }
  private foley(gesture: Gesture, at: number, until: number) {
    const fits = (offset: number, seconds: number) => at + offset + seconds < until;
    switch (gesture) {
      case 'cigar':
        // Two lighter flicks, a flame, then a slow draw.
        if (fits(0, 0.05)) this.burst(at, 0.04, 0.026, { type: 'highpass', frequency: 3000 }, 0.002);
        if (fits(0.18, 0.05)) this.burst(at + 0.18, 0.04, 0.028, { type: 'highpass', frequency: 3200 }, 0.002);
        if (fits(0.3, 0.9)) this.burst(at + 0.3, 0.9, 0.05, { type: 'bandpass', frequency: 900, q: 0.7 }, 0.15);
        if (fits(1.6, 1.4)) this.burst(at + 1.6, 1.4, 0.07, { type: 'lowpass', frequency: 700 }, 0.5);
        break;
      case 'tea':
        // Cup meets saucer, then a sip.
        if (fits(0, 0.16)) { this.ping(at, 2600, 0.16, 0.02); this.ping(at + 0.01, 3900, 0.12, 0.012); }
        if (fits(0.9, 0.5)) this.burst(at + 0.9, 0.5, 0.06, { type: 'lowpass', frequency: 900 }, 0.12);
        break;
      default:
        // Headphones, watch, beard, shoulders: a soft brush of cloth or hair.
        if (fits(0, 0.35)) this.burst(at, 0.35, 0.075, { type: 'bandpass', frequency: 1800, q: 0.8 }, 0.06);
        if (fits(0.6, 0.45)) this.burst(at + 0.6, 0.45, 0.07, { type: 'bandpass', frequency: 1500, q: 0.8 }, 0.05);
    }
  }
}
