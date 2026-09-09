// Reviewed historical facts, not a live price feed. Sources checked 2026-09-09.
// Keep dates in the brief so they survive queue sanitization and reach the writer.
import { similar, type TopicDraft } from './topics';

export const storyTopics: TopicDraft[] = [
  {
    title: 'History: BONK arrives during Solana winter, December 2022',
    brief: 'HISTORICAL — December 2022, not current news. The Solana Foundation recounts BONK arriving in community wallets for participation in Solana apps, projects and events. Its December 2023 review describes BONK as part of the community-led resurgence. No current price or returns are supplied.',
    angle: 'Pepe remembers dismissing a dog token during the winter; Chad challenges whether conviction only appeared after the timeline got loud. Keep the community comeback central.',
    url: 'https://solana.com/news/solana-solstice-2023-community-review',
    handle: 'Solana Foundation', source: 'web', category: 'crypto', score: 35,
  },
  {
    title: 'History: Solana Saga sells out in December 2023',
    brief: 'HISTORICAL — December 2023, not current news. The Solana Foundation reports that its Saga phone sold out in December as community excitement grew, in a year its review associates with BONK mania. This source does not supply phone prices, token allocations or buyer profits.',
    angle: 'Pepe tries to explain shopping for hardware during dog-coin mania; Chad interrogates his sudden interest in phone specifications. The sold-out phone must drive the bit.',
    url: 'https://solana.com/news/solana-solstice-2023-community-review',
    handle: 'Solana Foundation', source: 'web', category: 'crypto', score: 35,
  },
  {
    title: 'History: dogwifhat fans fund a Sphere campaign, March 2024',
    brief: 'HISTORICAL — March 13, 2024, not current news. The Defiant reported dogwifhat supporters exceeded a 650,000 dollar goal, raising over 691,000 USDC to seek a Las Vegas Sphere display. This is a report of fundraising, NOT proof an ad ran or a booking was secured. No later campaign outcome is supplied.',
    angle: 'A dog wearing a hat inspires a giant advertising budget. Pepe sees community ambition; Chad questions why conviction requires a building. Do not claim the display happened.',
    url: 'https://thedefiant.io/news/cefi/dogwifhat-community-raises-usd690k-to-put-meme-on-vegas-sphere',
    handle: 'The Defiant', source: 'web', category: 'crypto', score: 35,
  },
  {
    title: 'History: Solana halts for about five hours, February 2024',
    brief: 'HISTORICAL — February 6, 2024, not a current outage. Anza reported Solana block finalization halted at 09:53 UTC and consensus resumed at 14:55 UTC after a validator upgrade and coordinated restart. The cause was an infinite recompilation loop. The incident lasted approximately five hours.',
    angle: 'Pepe confuses being unable to transact with finally having diamond hands; Chad calls involuntary patience discipline. The restart punctures that excuse. Invent no lost trades.',
    url: 'https://solana.com/news/02-06-24-solana-mainnet-beta-outage-report',
    handle: 'Anza / Solana', source: 'web', category: 'crypto', score: 35,
  },
];

/** Fresh reporting leads; history fills quiet periods, with one callback on a busy wire. */
export function withHistory(live: TopicDraft[], avoid: string[], rotation: number): TopicDraft[] {
  const covered = (title: string) => avoid.some(a => similar(a, title));
  const fresh = live.filter(t => !covered(t.title));
  const offset = ((Math.trunc(rotation) % storyTopics.length) + storyTopics.length) % storyTopics.length;
  const history = [...storyTopics.slice(offset), ...storyTopics.slice(0, offset)]
    .filter(t => !covered(t.title) && !fresh.some(f => similar(f.title, t.title)))
    .slice(0, Math.max(1, 3 - fresh.length));
  return [...fresh, ...history];
}
