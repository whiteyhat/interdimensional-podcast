'use client';
import { memo, useSyncExternalStore } from 'react';
import type { ChatStatus, PumpChatSource } from '@/lib/pumpchat';
import { formatCount } from '@/lib/format';
const LABEL: Record<ChatStatus, string> = {
  idle: 'IDLE',
  connecting: 'CONNECTING',
  live: 'LIVE',
  reconnecting: 'RECONNECTING',
  off: 'OFF',
};
/** The stagger budget for a burst of new rows: five steps of 40ms, newest first. */
const delay = (index: number) => `${Math.min(index, 4) * 40}ms`;
/**
 * The pump.fun room as the studio sees it: who is watching, who is talking, and which
 * lines the hosts have already picked up. Newest at the top so nothing needs to scroll.
 * Memoised: the engine ticks many times a clip, and only a new chat or queue changes this.
 */
export const ChatPanel = memo(function ChatPanel({
  source,
  queuedIds,
}: {
  source: PumpChatSource;
  queuedIds: Set<string>;
}) {
  const state = useSyncExternalStore(source.subscribe, source.getState, source.getState);
  const rows = state.messages.slice().reverse();
  const note =
    state.status === 'reconnecting'
      ? `Reconnecting to the chat${state.attempts > 1 ? ` · try ${state.attempts}` : ''}${state.error ? ` · ${state.error}` : ''}`
      : (state.status === 'off' || state.status === 'connecting') && state.error
        ? state.error
        : '';
  return (
    <section className="chat-panel" aria-label="pump.fun live chat">
      <div className="chat-head">
        <span className="eyebrow">PUMP.FUN CHAT</span>
        <span className={`feed-pill ${state.status}`}>
          <i />
          CHAT: {LABEL[state.status]}
        </span>
        {state.viewers !== null && (
          <span className="chat-viewers">{formatCount(state.viewers)} WATCHING</span>
        )}
      </div>
      {note && <output className="chat-note">{note}</output>}
      {rows.length === 0 ? (
        <p className="empty-note">Waiting for the pump.fun chat…</p>
      ) : (
        <ol className="chat-list">
          {rows.map((m, index) => {
            const onWire = queuedIds.has(m.id);
            return (
              <li
                key={m.id}
                className={`chat-row${onWire ? ' queued' : ''}`}
                style={{ animationDelay: delay(index) }}
              >
                <b className="chat-author">{m.author}</b>
                <span className="chat-text">{m.text}</span>
                {onWire && <span className="badge paid">ON THE WIRE</span>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
});
