/**
 * The one celebratory moment in checkout: a payment the viewer just watched confirm.
 *
 * The rest of the site moves in decisive clean cuts, so this stays brief and deliberate
 * rather than a party: one upward burst from the pass, then two smaller ones angled in from
 * its sides 140ms later, all emitted inside 150ms and settled in under two seconds, in the
 * show's own warm palette. Loaded only when it fires, so no page pays for it up front, and
 * skipped entirely for anyone who asked their system for less motion.
 */
const COLORS = ['#dc936b', '#e3aa82', '#d4b77f', '#efece4', '#c0d69e'];

export async function celebratePayment(anchor: Element | null) {
  if (typeof window === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const { default: confetti } = await import('canvas-confetti');
  const rect = anchor?.getBoundingClientRect();
  // Burst from the top of the pass the viewer is looking at; the viewport centre otherwise.
  const x = rect ? (rect.left + rect.width / 2) / window.innerWidth : 0.5;
  const y = rect ? Math.max(0.12, rect.top / window.innerHeight) : 0.4;
  const base = {
    colors: COLORS,
    ticks: 160,
    gravity: 1.1,
    scalar: 0.9,
    decay: 0.92,
    disableForReducedMotion: true,
    zIndex: 1000,
  };
  void confetti({
    ...base,
    particleCount: 70,
    spread: 70,
    startVelocity: 36,
    origin: { x, y },
  });
  window.setTimeout(() => {
    void confetti({
      ...base,
      particleCount: 34,
      angle: 60,
      spread: 55,
      startVelocity: 30,
      origin: { x: Math.max(0.05, x - 0.14), y: y + 0.06 },
    });
    void confetti({
      ...base,
      particleCount: 34,
      angle: 120,
      spread: 55,
      startVelocity: 30,
      origin: { x: Math.min(0.95, x + 0.14), y: y + 0.06 },
    });
  }, 140);
}
