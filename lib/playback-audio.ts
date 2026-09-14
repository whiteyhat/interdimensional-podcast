/** One audible source, with the verified speech boundary enforced on the audio clock. */
export class PlaybackAudio {
  private readonly gain: GainNode;
  private readonly sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  private current?: HTMLMediaElement;
  private source?: MediaElementAudioSourceNode;
  private end = 0;
  constructor(readonly context: AudioContext = new AudioContext()) {
    this.gain = context.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(context.destination);
  }
  attach(video: HTMLMediaElement, speechEnd: number) {
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
    source.connect(this.gain);
  }
  resume() { return this.context.resume(); }
  /**
   * Volume never jumps. A step from silence to full at the first sample of a take, or back
   * to silence mid-waveform, is a click on air; a few milliseconds of ramp from wherever the
   * gain is right now is inaudible. The ramp to silence at the verified boundary stays where
   * it was: it must end exactly there.
   */
  private rampTo(level: number, seconds: number, now: number) {
    const from = this.gain.gain.value;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(from, now);
    this.gain.gain.linearRampToValueAtTime(level, now + seconds);
    return now + seconds;
  }
  silence(video?: HTMLMediaElement) {
    if (video && video !== this.current) return;
    this.rampTo(0, 0.008, this.context.currentTime);
  }
  sync(video: HTMLMediaElement) {
    if (video !== this.current) return;
    if (video.paused || video.ended || video.seeking || this.context.state !== 'running') {
      this.silence();
      return;
    }
    const left = (this.end - video.currentTime) / video.playbackRate;
    if (!(left > 0) || !Number.isFinite(left)) {
      this.silence();
      return;
    }
    const now = this.context.currentTime;
    const fade = Math.min(0.012, left);
    const rise = Math.min(0.015, Math.max(0, left - fade));
    const up = this.rampTo(1, rise, now);
    this.gain.gain.setValueAtTime(1, Math.max(up, now + left - fade));
    this.gain.gain.linearRampToValueAtTime(0, now + left);
  }
  async close() {
    this.silence();
    this.source?.disconnect();
    this.gain.disconnect();
    await this.context.close();
  }
}
