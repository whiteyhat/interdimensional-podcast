/**
 * Which clip each pooled video layer shows.
 *
 * The on-air player keeps a small, fixed set of <video> elements and hands clips to them,
 * instead of mounting a fresh element per clip. Chromium keeps every element the audio bus has
 * routed (its MediaElementAudioSourceNode, decoder and media threads) alive until the
 * AudioContext closes, so an element per clip grew the broadcast box by one decoded player per
 * take until the container ran out of threads about forty minutes in.
 *
 * A clip keeps the layer it has; a layer whose clip is gone goes to the next newcomer; the pool
 * grows only when every layer is taken. Its size is therefore the most clips the show ever held
 * at once (the previous shot, the current one and the ready slots), not the number aired.
 * Returns the same array when nothing moves, so an unchanged layout keeps its identity.
 */
export function assignLayers(
  layers: readonly (string | null)[],
  urls: readonly string[],
): readonly (string | null)[] {
  const next = layers.map((url) => (url && urls.includes(url) ? url : null));
  for (const url of urls) {
    if (next.includes(url)) continue;
    const free = next.indexOf(null);
    if (free < 0) next.push(url);
    else next[free] = url;
  }
  return next.length === layers.length &&
    next.every((url, i) => url === layers[i])
    ? layers
    : next;
}
