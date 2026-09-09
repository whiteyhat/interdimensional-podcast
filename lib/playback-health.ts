/** A decoded clip must keep making media-time progress while the producer says it is playing. */
export class PlaybackHealth {
  private position = 0;
  private lastProgress: number;
  constructor(
    now: number,
    private graceMs = 8000,
  ) {
    this.lastProgress = now;
  }
  stalled(position: number, now: number) {
    if (Number.isFinite(position) && position > this.position + 0.03) {
      this.position = position;
      this.lastProgress = now;
    }
    return now - this.lastProgress >= this.graceMs;
  }
}
