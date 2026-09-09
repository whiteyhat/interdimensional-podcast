import type { Speaker } from './show';

/** Seconds of show playback, with extra room for the props to settle before the cut. */
export const gestureConfig = {
  tea: { speaker: 'guest', interval: 70, duration: 8 },
  cigar: { speaker: 'host', interval: 90, duration: 10 },
  headphones: { speaker: 'host', interval: 150, duration: 6 },
  watch: { speaker: 'host', interval: 230, duration: 6 },
  beard: { speaker: 'guest', interval: 170, duration: 6 },
  shoulders: { speaker: 'guest', interval: 250, duration: 7 },
  gap: 12,
} as const;

export type Gesture = Exclude<keyof typeof gestureConfig, 'gap'>;
export const gestureNames = Object.keys(gestureConfig).filter(
  (key): key is Gesture => key !== 'gap',
);

export const gestureDirections: Record<Gesture, string> = {
  tea: 'with his right hand (on the left side of the image), he picks up the existing dark mug by its handle, takes one unhurried sip of tea, and sets the mug down in its original spot with the handle and logo facing exactly as before. His hand returns to its resting position on the desk. Keep the mug solid and consistent throughout.',
  cigar:
    'while sitting upright in the same place, he lifts a cigar with his right hand and a silver lighter with his left, lights the cigar, lowers the lighter below the frame, and takes one small puff. His right hand then takes the cigar away from his mouth and lowers it below the frame. He exhales a thin wisp to the side and returns both empty hands to their original resting spots. The smoke clears before the final second. His left wristwatch stays unchanged. His movements are small enough to fit comfortably in the original wide view; the lamp, desk edge and both forearms remain visible throughout.',
  headphones:
    'he raises his right hand to the existing right ear cup, makes one small comfort adjustment without lifting the headphones off his head, and lowers his hand to its original resting spot on the desk. His left hand stays still. Keep his head, headphones and the rest of the room at the same size and position.',
  watch:
    'he turns his left wrist a little and glances down at the gold wristwatch he already wears, then looks back toward his partner and returns his wrist to the desk. His right hand stays relaxed. Keep the watch attached to the same wrist; do not change its face or add another prop.',
  beard:
    'he raises his right hand, smooths the lower edge of his existing beard once with his fingertips, and returns the hand to its original place on the desk. Keep the beard shape and length unchanged. This is a brief habitual movement while listening, with his torso still.',
  shoulders:
    'he eases his shoulders down and back once to get comfortable, keeping his forearms on the desk, then settles into his original seated posture. Keep his head at the same distance from the microphone. Use a small shoulder movement, without leaning toward the lens, moving the chair or lifting the microphone.',
};

/** Only the director's known actions can reach the video prompt. */
export function readGesture(
  speaker: Speaker,
  value: unknown,
): Gesture | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !gestureNames.includes(value as Gesture) ||
    gestureConfig[value as Gesture].speaker !== speaker
  )
    throw Error('Invalid character gesture');
  return value as Gesture;
}

/** Reserve only committed shots. Retrying a slot reuses its reservation. */
export class GestureSchedule {
  private due = Object.fromEntries(
    gestureNames.map((name) => [name, gestureConfig[name].interval]),
  ) as Record<Gesture, number>;
  private availableAt = 0;
  private latest?: { id: number; startsAt: number };

  isDue(speaker: Speaker, shortLine: boolean, startsAt: number): boolean {
    return this.next(speaker, shortLine, startsAt) !== undefined;
  }

  private next(
    speaker: Speaker,
    shortLine: boolean,
    startsAt: number,
  ): Gesture | undefined {
    if (!shortLine || startsAt < this.availableAt) return undefined;
    // Oldest due action wins, so the less frequent room gestures also get their turn.
    return gestureNames
      .filter(
        (name) =>
          gestureConfig[name].speaker === speaker && startsAt >= this.due[name],
      )
      .sort((a, b) => this.due[a] - this.due[b])[0];
  }

  reserve(
    speaker: Speaker,
    shortLine: boolean,
    startsAt: number,
    id: number,
  ): Gesture | undefined {
    const gesture = this.next(speaker, shortLine, startsAt);
    if (!gesture) return undefined;
    const config = gestureConfig[gesture];
    this.due[gesture] = startsAt + config.interval;
    this.availableAt = startsAt + config.duration + gestureConfig.gap;
    this.latest = { id, startsAt };
    return gesture;
  }

  /** Resolve the reserved ending before another gesture is allowed to depend on it. */
  rendered(id: number, duration: number) {
    if (this.latest?.id === id)
      this.availableAt = this.latest.startsAt + duration + gestureConfig.gap;
  }
}
