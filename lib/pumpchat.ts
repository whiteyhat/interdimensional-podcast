// The pump.fun livestream chat, read over a raw WebSocket. The server speaks Engine.IO 4
// with Socket.IO 4 on top, which is a handful of string prefixes; framing them by hand
// keeps the studio free of a socket.io client. Reading needs no login. Sending is out of scope.
import type { Comment } from './topics';
import type { CommentSource, Deliver } from './chat';
import { shortWallet } from './requests';

export const CHAT_URL = 'wss://livechat.pump.fun/socket.io/?EIO=4&transport=websocket';
export const CHAT_ORIGIN = 'https://pump.fun';
/** How many messages the panel keeps. */
export const CHAT_KEEP = 60;
const BATCH_MS = 4000;
const WATCHDOG_MS = 45000;
const TEXT_LIMIT = 280;

export type FrameKind = 'open' | 'ping' | 'pong' | 'connected' | 'event' | 'other';
export type Frame = { kind: FrameKind; name?: string; payload?: unknown };
export type ChatStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'off';
export type ChatMessage = Comment & { wallet?: string };
export type ChatState = {
  status: ChatStatus;
  /** Newest last. */
  messages: ChatMessage[];
  viewers: number | null;
  attempts: number;
  error: string;
};
export type PumpChatOptions = {
  socket?: typeof WebSocket;
  batchMs?: number;
  url?: string;
  /** Log unknown event names once each. Defaults to development builds only. */
  debug?: boolean;
};

const ENGINE: Record<string, string> = {
  '1': 'close',
  '4': 'message',
  '5': 'upgrade',
  '6': 'noop',
};
const SOCKET: Record<string, string> = {
  '1': 'disconnect',
  '3': 'ack',
  '4': 'error',
  '5': 'binary-event',
  '6': 'binary-ack',
};

function json(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
/** One frame off the wire: Engine.IO type digit, then the Socket.IO packet inside a message. */
export function parseFrame(raw: unknown): Frame {
  if (typeof raw !== 'string' || !raw) return { kind: 'other', name: 'empty' };
  const type = raw[0];
  if (type === '0') return { kind: 'open', payload: json(raw.slice(1)) };
  if (type === '2') return { kind: 'ping' };
  if (type === '3') return { kind: 'pong' };
  if (type !== '4') return { kind: 'other', name: ENGINE[type] ?? 'unknown' };
  const packet = raw[1];
  // A packet may carry a namespace ("/nsp,") and an ack id (digits) before its body.
  const body = raw.slice(2).replace(/^\/[^,]*,/, '').replace(/^\d+/, '');
  if (packet === '0') return { kind: 'connected', payload: json(body) };
  if (packet === '2') {
    const parsed = json(body);
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') {
      return { kind: 'other', name: 'malformed' };
    }
    return {
      kind: 'event',
      name: parsed[0],
      payload: parsed.length > 2 ? parsed.slice(1) : parsed[1],
    };
  }
  return { kind: 'other', name: SOCKET[packet] ?? 'unknown', payload: json(body) };
}
export function handshakeFrame(now = Date.now()) {
  return `40${JSON.stringify({ origin: CHAT_ORIGIN, timestamp: now, token: null })}`;
}
export function joinFrame(mint: string) {
  return `42${JSON.stringify(['joinRoom', { roomId: mint, username: '' }])}`;
}
/** 1s, 2s, 4s … 30s, with an optional slice of jitter (pass Math.random()). Never above 30s. */
export function backoffMs(attempt: number, random = 0) {
  const step = Math.max(0, Math.min(10, Math.floor(attempt) - 1));
  const base = Math.min(30000, 1000 * 2 ** step);
  const jitter = Math.max(0, Math.min(1, random)) * 0.25 * base;
  return Math.min(30000, Math.round(base + jitter));
}

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const clean = (v: unknown, limit: number) => str(v).replace(/\s+/g, ' ').trim().slice(0, limit);
function when(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  }
  return undefined;
}
function hash(text: string) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
/**
 * A `newMessage` payload as the chat sends it: {id, roomId, username, userAddress, message,
 * timestamp, messageType, replyToId?, profile_image?}. Tolerates the older names too.
 * Null for system notices and anything without a body or a name.
 */
export function toComment(payload: unknown, now = Date.now()): ChatMessage | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const kind = str(p.messageType ?? p.type).toUpperCase();
  if (kind === 'SYSTEM') return null;
  const text = clean(p.message ?? p.text ?? p.content, TEXT_LIMIT);
  if (!text) return null;
  const wallet = str(p.userAddress ?? p.walletAddress ?? p.address ?? p.wallet).trim();
  const author =
    clean(p.username ?? p.displayName ?? p.userName ?? p.name, 40) ||
    (wallet ? shortWallet(wallet) : '');
  if (!author) return null;
  const at = when(p.timestamp ?? p.createdAt ?? p.created_at ?? p.at) ?? now;
  const id = str(p.id ?? p._id ?? p.messageId) || `${at}-${hash(`${author}:${text}`)}`;
  return {
    id,
    author,
    text,
    platform: 'pumpfun',
    at,
    ...(wallet ? { wallet } : {}),
  };
}
function viewerCount(payload: unknown): number | null {
  if (typeof payload === 'number') return Number.isFinite(payload) && payload >= 0 ? payload : null;
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const n = Number(p.count ?? p.viewers ?? p.viewerCount ?? p.numParticipants);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function isDev() {
  const meta = (import.meta as { env?: { DEV?: boolean; MODE?: string } }).env;
  if (meta && typeof meta === 'object') return meta.DEV === true || meta.MODE === 'development';
  return typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';
}
// Seen on the wire: newMessage, messageHistory, viewerCount, userLeft, messageReactionUpdated.
const KNOWN = new Set([
  'newMessage',
  'messageHistory',
  'viewerCount',
  'userJoined',
  'userLeft',
  'messageReactionUpdated',
]);
/** True unless the payload names another room than ours. */
function ours(payload: unknown, mint: string) {
  const room = (payload as { roomId?: unknown } | null)?.roomId;
  return typeof room !== 'string' || !room || room === mint;
}
const IDLE: ChatState = { status: 'idle', messages: [], viewers: null, attempts: 0, error: '' };

/**
 * One room, one socket. Comments are batched for the engine every few seconds so the ranker
 * sees a slice of the room rather than one line at a time; the panel gets every message as it
 * lands through subscribe/getState (a stable reference until something changes).
 */
export class PumpChatSource implements CommentSource {
  readonly name = 'pumpfun';
  private readonly url: string;
  private readonly batchMs: number;
  private readonly debug: boolean;
  private readonly Socket?: typeof WebSocket;
  private state: ChatState = IDLE;
  private listeners = new Set<() => void>();
  private ws?: WebSocket;
  private deliver?: Deliver;
  private stopped = true;
  private pending: ChatMessage[] = [];
  private seen = new Set<string>();
  private logged = new Set<string>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private watchdogMs = WATCHDOG_MS;
  constructor(
    readonly mint: string,
    options: PumpChatOptions = {},
  ) {
    this.url = options.url ?? CHAT_URL;
    this.batchMs = options.batchMs ?? BATCH_MS;
    this.debug = options.debug ?? isDev();
    this.Socket =
      options.socket ?? (typeof WebSocket === 'undefined' ? undefined : WebSocket);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getState = () => this.state;
  start(deliver: Deliver) {
    this.deliver = deliver;
    if (!this.stopped) return;
    this.stopped = false;
    this.set({ attempts: 0, error: '' });
    this.connect();
  }
  stop() {
    this.stopped = true;
    this.deliver = undefined;
    this.pending = [];
    clearTimeout(this.flushTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.watchdog);
    this.flushTimer = this.retryTimer = this.watchdog = undefined;
    this.detach();
    this.set({ status: 'off', attempts: 0, error: '' });
  }
  private set(patch: Partial<ChatState>) {
    const next = { ...this.state, ...patch };
    const keys = Object.keys(next) as (keyof ChatState)[];
    if (keys.every((key) => Object.is(next[key], this.state[key]))) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  private detach() {
    const ws = this.ws;
    if (!ws) return;
    this.ws = undefined;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      // Already gone.
    }
  }
  private connect() {
    if (this.stopped) return;
    if (!this.Socket) {
      this.set({ status: 'off', error: 'No WebSocket in this environment' });
      return;
    }
    this.set({ status: this.state.attempts ? 'reconnecting' : 'connecting' });
    let ws: WebSocket;
    try {
      ws = new this.Socket(this.url);
    } catch (error) {
      this.dropped(error instanceof Error ? error.message : 'Cannot open the socket');
      return;
    }
    this.ws = ws;
    this.arm();
    ws.onmessage = (event: MessageEvent) => {
      if (this.ws === ws) this.onFrame(ws, event.data);
    };
    ws.onerror = () => {
      if (this.ws === ws) this.set({ error: 'Socket error' });
    };
    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.dropped(event?.reason || this.state.error || 'Disconnected');
    };
  }
  /** Engine.IO pings on a schedule; a silent socket past that window is a dead one. */
  private arm() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (!this.ws) return;
      this.detach();
      this.dropped('No heartbeat');
    }, this.watchdogMs);
  }
  private dropped(reason: string) {
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
    if (this.stopped) return;
    const attempts = this.state.attempts + 1;
    this.set({ status: 'reconnecting', attempts, error: reason });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, backoffMs(attempts, Math.random()));
  }
  private onFrame(ws: WebSocket, data: unknown) {
    this.arm();
    const frame = parseFrame(data);
    switch (frame.kind) {
      case 'open': {
        // The server pings every pingInterval (25s live); two missed pings mean a dead socket.
        // Its pingTimeout is five minutes, far too slow to wait for.
        const open = (frame.payload ?? {}) as { pingInterval?: number };
        const interval = Number(open.pingInterval);
        if (Number.isFinite(interval) && interval > 1000) this.watchdogMs = interval * 2 + 5000;
        ws.send(handshakeFrame(Date.now()));
        return;
      }
      case 'ping':
        ws.send('3');
        // The first server ping proves the session is real; only then does the backoff reset.
        if (this.state.attempts) this.set({ attempts: 0 });
        return;
      case 'connected':
        ws.send(joinFrame(this.mint));
        this.set({ status: 'live', error: '' });
        return;
      case 'event':
        if (this.state.attempts) this.set({ attempts: 0 });
        this.onEvent(frame.name ?? '', frame.payload);
        return;
      default:
        if (frame.name === 'error' || frame.name === 'disconnect') {
          // The server refused or ended the session without closing the transport: a drop.
          const detail = frame.payload as { message?: string } | undefined;
          this.detach();
          this.dropped(
            detail?.message ||
              (frame.name === 'error' ? 'Chat refused the connection' : 'Chat ended the session'),
          );
        }
    }
  }
  private onEvent(name: string, payload: unknown) {
    if (name === 'newMessage') {
      if (!ours(payload, this.mint)) return;
      const comment = toComment(payload);
      if (comment && this.remember(comment)) {
        this.pending.push(comment);
        this.show([comment]);
        this.flushTimer ??= setTimeout(() => this.flush(), this.batchMs);
      }
      return;
    }
    if (name === 'messageHistory') {
      // A replay of what the room said before we joined: shown, never delivered to the hosts.
      const list = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as { messages?: unknown })?.messages)
          ? ((payload as { messages: unknown[] }).messages)
          : [];
      const fresh: ChatMessage[] = [];
      for (const item of list) {
        const comment = toComment(item);
        if (comment && this.remember(comment)) fresh.push(comment);
      }
      fresh.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      this.show(fresh);
      return;
    }
    if (name === 'viewerCount') {
      if (!ours(payload, this.mint)) return;
      const count = viewerCount(payload);
      if (count !== null) this.set({ viewers: count });
      return;
    }
    if (!KNOWN.has(name) && this.debug && !this.logged.has(name)) {
      this.logged.add(name);
      console.debug(`[pumpchat] unhandled event "${name}"`, payload);
    }
  }
  private remember(comment: ChatMessage) {
    if (this.seen.has(comment.id)) return false;
    this.seen.add(comment.id);
    if (this.seen.size > 500) {
      for (const id of this.seen) {
        this.seen.delete(id);
        if (this.seen.size <= 400) break;
      }
    }
    return true;
  }
  private show(comments: ChatMessage[]) {
    if (!comments.length) return;
    this.set({ messages: [...this.state.messages, ...comments].slice(-CHAT_KEEP) });
  }
  private flush() {
    this.flushTimer = undefined;
    const batch = this.pending;
    this.pending = [];
    if (batch.length && !this.stopped) this.deliver?.(batch);
  }
}
