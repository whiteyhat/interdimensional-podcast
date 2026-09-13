// A leased order as the site hands it to the studio, and a four-turn exchange to air it on.
export const lease = (product = 'spotlight') => ({
  id: 'order1',
  leaseToken: 'lease1',
  leaseUntil: Date.now() + 45000,
  draft: {
    product,
    name: 'alice',
    message: 'We make tools for artists.',
    projectName: 'Canvas',
    target: 'host',
    assetId: 'design1',
  },
  assetUrl: 'https://site.test/preview.png',
  assetMetadata: {
    sourceUrl: 'https://site.test/cap.png',
    sha256: 'design1',
    templateVersion: 'caps-v1',
  },
  fulfillment: {
    visibleMs: 0,
    appearances: 0,
    intro: false,
    callback: false,
    startedAt: null,
    completedAt: null,
  },
});
export const lines = (start = 0) =>
  Array.from({ length: 4 }, (_, i) => ({
    id: start + i,
    speaker: i % 2 ? 'guest' : 'host',
    text: 'An ordinary spoken line.',
  }));
