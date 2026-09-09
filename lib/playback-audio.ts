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
  silence(video?: HTMLMediaElement) {
    if (video && video !== this.current) return;
    const now = this.context.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(0, now);
  }
  sync(video: HTMLMediaElement) {
    if (video !== this.current) return;
    this.silence();
    if (video.paused || video.ended || video.seeking || this.context.state !== 'running') return;
    const left = (this.end - video.currentTime) / video.playbackRate;
    if (!(left > 0) || !Number.isFinite(left)) return;
    const now = this.context.currentTime;
    const fade = Math.min(0.012, left);
    this.gain.gain.setValueAtTime(1, now);
    this.gain.gain.setValueAtTime(1, now + left - fade);
    this.gain.gain.linearRampToValueAtTime(0, now + left);
  }
  async close() {
    this.silence();
    this.source?.disconnect();
    this.gain.disconnect();
    await this.context.close();
  }
}
