import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['show']);
const { parseLines } = await import('../work/tests/show.js');

// A bolded label was missed, its asterisks were stripped afterwards, and the turn fell back to
// alternating speakers: Pepe read "GigaChad: This one is sponsored" aloud in his own voice.
void test('a bolded speaker label still says who is talking and is never read aloud', () => {
  for (const [a, b] of [
    ['**GigaChad:**', '**Pepe:**'],
    ['**GigaChad**:', '**Pepe**:'],
    ['*GigaChad:*', '_Pepe_:'],
  ]) {
    const lines = parseLines(
      [
        `${a} This one is sponsored by Alice, thank you.`,
        `${b} Alice paid for this, and I respect it.`,
        `${a} The team says Orbit tracks household bills.`,
        `${b} I track my bills by how scared I feel.`,
      ].join('\n'),
      0,
    );
    assert.deepEqual(
      lines.map((l) => l.speaker),
      ['guest', 'host', 'guest', 'host'],
      `labels ${a} ${b}`,
    );
    for (const line of lines)
      assert.doesNotMatch(line.text, /^(pepe|gigachad)\b/i, line.text);
  }
});
