// Live-chat plumbing. Only the manual studio source exists today; a real platform
// adapter (X live, Pump.fun) implements CommentSource and nothing else changes.
import type { Comment } from './topics';
export type Deliver = (batch: Comment[]) => void;
export type CommentSource = {
  readonly name: string;
  start(deliver: Deliver): void;
  stop(): void;
};
export function parseChatLines(
  text: string,
  fallbackAuthor: string,
  now = Date.now(),
): Comment[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const named = /^([^:]{1,40}):\s*(.+)$/.exec(line);
      return {
        id: `${now}-${index}`,
        author: named ? named[1].trim() : fallbackAuthor,
        text: named ? named[2].trim() : line,
        at: now,
        platform: 'manual',
      };
    });
}
export class ManualCommentSource implements CommentSource {
  readonly name = 'manual';
  private deliver?: Deliver;
  start(deliver: Deliver) {
    this.deliver = deliver;
  }
  stop() {
    this.deliver = undefined;
  }
  push(text: string, fallbackAuthor = 'studio') {
    const batch = parseChatLines(text, fallbackAuthor);
    if (batch.length) this.deliver?.(batch);
  }
}
