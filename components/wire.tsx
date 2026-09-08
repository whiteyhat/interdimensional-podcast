'use client';
import { ArrowUpRight, X } from 'lucide-react';
import type { FeedState, Topic } from '@/lib/topics';
import { orderTopics, sourceLabel } from '@/lib/topics';
const EMPTY: Record<FeedState['status'], string> = {
  off: 'The feed is paused. Resume it to pull live topics.',
  idle: 'The news desk is standing by.',
  searching: 'Reading X and the news…',
  live: 'Nothing new on the wire yet.',
  error: 'The crypto desk is down. The show keeps going on news and your prompts.',
};
export function Wire({
  topics,
  feed,
  running,
  onPromote,
  onDismiss,
}: {
  topics: Topic[];
  feed: FeedState;
  running: boolean;
  onPromote: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  // Same ordering the engine uses, so the top item really is the one coming next.
  const queued = orderTopics({ topics } as Parameters<typeof orderTopics>[0]);
  return (
    <div className="wire">
      <span className="eyebrow">
        ON THE WIRE
        {feed.status === 'searching' && <em> · searching</em>}
      </span>
      {queued.length === 0 ? (
        <p className="wire-empty">{feed.error || EMPTY[feed.status]}</p>
      ) : (
        <ul>
          {queued.slice(0, 6).map((topic, index) => (
            <li
              className={`wire-item${topic.pinned ? ' pinned' : ''}`}
              key={topic.id}
              style={{ animationDelay: `${Math.min(index, 5) * 40}ms` }}
            >
              <button
                className="wire-open"
                disabled={!running}
                title="Send this to the studio next"
                onClick={() => onPromote(topic.id)}
              >
                <span className={`badge ${topic.source}`}>
                  {topic.source === 'chat' ? 'CHAT' : topic.source.toUpperCase()}
                </span>
                <span className="wire-title">{topic.title}</span>
                <span className="wire-meta">
                  {topic.pinned ? 'Up next' : sourceLabel(topic)}
                  <ArrowUpRight className="wire-go" size={13} />
                </span>
                <span className="wire-score" aria-hidden="true">
                  <i style={{ width: `${topic.score}%` }} />
                </span>
              </button>
              <button
                className="wire-drop"
                title="Drop this topic"
                aria-label={`Drop ${topic.title}`}
                onClick={() => onDismiss(topic.id)}
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
