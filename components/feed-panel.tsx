'use client';
import { useState } from 'react';
import { Radio } from 'lucide-react';
import type { FeedState, Topic } from '@/lib/topics';
const SAMPLE = `deb: why is the whole timeline mad at the SEC again
maxi: ask chad if he has ever taken profit in his life
anon: what actually happened with that bridge last night`;
function ago(at: number) {
  if (!at) return 'never';
  const seconds = Math.round((Date.now() - at) / 1000);
  return seconds < 90 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}
export function FeedPanel({
  feed,
  topics,
  onToggleFeed,
  onChat,
}: {
  feed: FeedState;
  topics: Topic[];
  onToggleFeed: (enabled: boolean) => void;
  onChat: (text: string) => void;
}) {
  const [chat, setChat] = useState('');
  const live = feed.status !== 'off';
  const tracked = topics.filter((t) => t.status !== 'dropped').slice(-6).reverse();
  return (
    <div className="feed-panel">
      <div className="feed-head">
        <span className={`feed-pill ${feed.status}`}>
          <i />
          FEED: {feed.status.toUpperCase()}
        </span>
        <span className="feed-stats">
          {ago(feed.lastResearchAt)} · {feed.calls} calls · ~$
          {feed.costUsd.toFixed(2)}
        </span>
        <button className="quiet" onClick={() => onToggleFeed(!live)}>
          <Radio size={13} /> {live ? 'Pause feed' : 'Resume feed'}
        </button>
      </div>
      {feed.error && <p className="feed-error">{feed.error}</p>}
      {tracked.length > 0 && (
        <table className="topic-table">
          <tbody>
            {tracked.map((topic) => (
              <tr key={topic.id}>
                <td>
                  <span className={`badge ${topic.source}`}>
                    {topic.source === 'chat'
                      ? 'CHAT'
                      : topic.source.toUpperCase()}
                  </span>
                </td>
                <td className="topic-name">{topic.title}</td>
                <td>{topic.score}</td>
                <td className="topic-status">{topic.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="chat-sim">
        <span className="eyebrow">SIMULATE LIVE CHAT</span>
        <textarea
          aria-label="Chat comments to rank"
          value={chat}
          onChange={(e) => setChat(e.target.value)}
          placeholder={SAMPLE}
          rows={3}
        />
        <button
          className="quiet"
          disabled={!chat.trim()}
          onClick={() => {
            onChat(chat);
            setChat('');
          }}
        >
          Rank and queue
        </button>
      </div>
    </div>
  );
}
