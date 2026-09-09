import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['pumpchat', 'requests']);
const P = await import('../work/tests/pumpchat.js');

const WALLET = '7xK9abcdefghijkmnopqrstuvwxyzABCDEFGH123456';
const OPEN =
  '0{"sid":"abc","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}';
const CONNECTED = '40{"sid":"xyz"}';
const event = (name, payload) => `42${JSON.stringify([name, payload])}`;
const message = (over = {}) => ({
  id: 'm1',
  roomId: 'MINT',
  username: 'deb',
  userAddress: WALLET,
  message: 'why is chad never selling',
  timestamp: '2026-09-08T10:00:00.000Z',
  messageType: 'REGULAR',
  ...over,
});

/** A WebSocket stand-in the tests drive by hand. */
class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  receive(raw) {
    this.onmessage?.({ data: raw });
  }
  drop(reason = '') {
    this.onclose?.({ code: 1006, reason });
  }
}
const last = () => FakeSocket.instances[FakeSocket.instances.length - 1];
function open(source) {
  const delivered = [];
  source.start((batch) => delivered.push(batch));
  const ws = last();
  ws.receive(OPEN);
  ws.receive(CONNECTED);
  return { ws, delivered };
}

test('frames are told apart by their engine.io and socket.io prefixes', () => {
  const opened = P.parseFrame(OPEN);
  assert.equal(opened.kind, 'open');
  assert.equal(opened.payload.pingInterval, 25000);
  assert.deepEqual(P.parseFrame('2'), { kind: 'ping' });
  assert.deepEqual(P.parseFrame('3'), { kind: 'pong' });
  const connected = P.parseFrame(CONNECTED);
  assert.equal(connected.kind, 'connected');
  assert.equal(connected.payload.sid, 'xyz');
  const evt = P.parseFrame(event('newMessage', { id: '1' }));
  assert.deepEqual(evt, { kind: 'event', name: 'newMessage', payload: { id: '1' } });
  assert.deepEqual(P.parseFrame('42["multi",1,2]'), { kind: 'event', name: 'multi', payload: [1, 2] });
  assert.deepEqual(P.parseFrame('42["bare"]'), { kind: 'event', name: 'bare', payload: undefined });
  const withAck = P.parseFrame('42/chat,7["evt",{"a":1}]');
  assert.equal(withAck.kind, 'event');
  assert.equal(withAck.name, 'evt');
  assert.deepEqual(withAck.payload, { a: 1 });
  const ack = P.parseFrame('431["ok"]');
  assert.equal(ack.kind, 'other');
  assert.equal(ack.name, 'ack');
  assert.deepEqual(ack.payload, ['ok']);
  const refused = P.parseFrame('44{"message":"nope"}');
  assert.equal(refused.kind, 'other');
  assert.equal(refused.name, 'error');
  assert.equal(refused.payload.message, 'nope');
  assert.equal(P.parseFrame('42{').kind, 'other');
  assert.equal(P.parseFrame('42[1]').kind, 'other');
  assert.equal(P.parseFrame('1').name, 'close');
  assert.equal(P.parseFrame('').kind, 'other');
  assert.equal(P.parseFrame(undefined).kind, 'other');
  assert.equal(P.parseFrame(new Uint8Array(2)).kind, 'other');
});

test('the handshake and the room join are the exact strings the server accepts', () => {
  assert.equal(
    P.handshakeFrame(1700000000000),
    '40{"origin":"https://pump.fun","timestamp":1700000000000,"token":null}',
  );
  assert.equal(P.joinFrame('MINT'), '42["joinRoom",{"roomId":"MINT","username":""}]');
  assert.equal(P.parseFrame(P.joinFrame('MINT')).name, 'joinRoom');
  assert.equal(P.CHAT_URL, 'wss://livechat.pump.fun/socket.io/?EIO=4&transport=websocket');
});

test('a chat payload becomes a comment, system notices and junk do not', () => {
  const c = P.toComment(message(), 5);
  assert.deepEqual(c, {
    id: 'm1',
    author: 'deb',
    text: 'why is chad never selling',
    platform: 'pumpfun',
    at: Date.parse('2026-09-08T10:00:00.000Z'),
    wallet: WALLET,
  });
  assert.equal(P.toComment(message({ messageType: 'SYSTEM' })), null);
  assert.equal(P.toComment(message({ messageType: 'system' })), null);
  assert.equal(P.toComment(message({ message: '' })), null);
  assert.equal(P.toComment(message({ message: '   ' })), null);
  assert.equal(P.toComment(message({ message: undefined })), null);
  assert.equal(P.toComment(null), null);
  assert.equal(P.toComment('hello'), null);
  assert.equal(P.toComment([message()]), null);
  assert.equal(P.toComment({}), null);
  // Older field names still map.
  const alt = P.toComment({ id: 9, displayName: 'maxi', text: 'gm ser', timestamp: 1700000000 });
  assert.equal(alt.id, '9');
  assert.equal(alt.author, 'maxi');
  assert.equal(alt.text, 'gm ser');
  assert.equal(alt.at, 1700000000000, 'seconds become milliseconds');
  assert.equal(alt.wallet, undefined);
  // No name: the wallet stands in; no name and no wallet: nothing to react to.
  assert.equal(P.toComment(message({ username: '' })).author, '7xK9…3456');
  assert.equal(P.toComment(message({ username: '', userAddress: '' })), null);
  // No timestamp: now.
  assert.equal(P.toComment(message({ timestamp: undefined }), 777).at, 777);
  assert.equal(P.toComment(message({ timestamp: 'not a date' }), 777).at, 777);
  // Whitespace collapses and long rants are cut.
  assert.equal(P.toComment(message({ message: '  so   much \n space ' })).text, 'so much space');
  assert.equal(P.toComment(message({ message: 'x'.repeat(500) })).text.length, 280);
  assert.equal(P.toComment(message({ username: 'n'.repeat(80) })).author.length, 40);
  // No id: a stable one from the author and the text.
  const a = P.toComment(message({ id: undefined }), 1);
  const b = P.toComment(message({ id: undefined }), 1);
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, P.toComment(message({ id: undefined, message: 'other words' }), 1).id);
});

test('backoff doubles from one second and stops at thirty', () => {
  assert.equal(P.backoffMs(0), 1000);
  assert.equal(P.backoffMs(1), 1000);
  assert.equal(P.backoffMs(2), 2000);
  assert.equal(P.backoffMs(3), 4000);
  assert.equal(P.backoffMs(5), 16000);
  assert.equal(P.backoffMs(6), 30000);
  assert.equal(P.backoffMs(40), 30000);
  assert.equal(P.backoffMs(1, 1), 1250);
  assert.equal(P.backoffMs(1, 0.5), 1125);
  assert.equal(P.backoffMs(6, 1), 30000, 'jitter never pushes past the cap');
  for (let i = 1; i < 12; i++) assert.ok(P.backoffMs(i + 1) >= P.backoffMs(i));
});

test('the source handshakes, joins, answers pings and batches comments', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = new P.PumpChatSource('MINT', { socket: FakeSocket, batchMs: 100, debug: false });
  t.after(() => source.stop());
  const idle = source.getState();
  assert.equal(idle.status, 'idle');
  const delivered = [];
  source.start((batch) => delivered.push(batch));
  assert.equal(source.getState().status, 'connecting');
  const ws = last();
  assert.equal(ws.url, P.CHAT_URL);
  assert.deepEqual(ws.sent, [], 'nothing is sent before the open frame');
  ws.receive(OPEN);
  assert.equal(ws.sent.length, 1);
  assert.ok(ws.sent[0].startsWith('40{"origin":"https://pump.fun","timestamp":'));
  assert.equal(JSON.parse(ws.sent[0].slice(2)).token, null);
  ws.receive('2');
  assert.equal(ws.sent[1], '3', 'a ping is answered with a pong');
  ws.receive(CONNECTED);
  assert.equal(ws.sent[2], P.joinFrame('MINT'));
  assert.equal(source.getState().status, 'live');

  ws.receive(event('newMessage', message()));
  ws.receive(event('newMessage', message({ id: 'sys', messageType: 'SYSTEM', message: 'joined' })));
  ws.receive(event('newMessage', message({ id: 'm2', username: 'maxi', message: 'ask chad about profit' })));
  ws.receive(event('newMessage', message({ id: 'm2', message: 'duplicate id' })));
  ws.receive(event('newMessage', message({ id: 'elsewhere', roomId: 'OTHER' })));
  ws.receive(event('newMessage', { nothing: true }));
  ws.receive(event('messageReactionUpdated', { roomId: 'MINT', messageId: 'm1', emojiKey: ':fire:' }));
  const shown = source.getState().messages;
  assert.deepEqual(shown.map((m) => m.id), ['m1', 'm2'], 'newest last, no system, no repeats, no other rooms');
  assert.equal(delivered.length, 0, 'the engine waits for the batch');
  t.mock.timers.tick(99);
  assert.equal(delivered.length, 0);
  t.mock.timers.tick(1);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].map((c) => [c.author, c.platform]), [['deb', 'pumpfun'], ['maxi', 'pumpfun']]);
  ws.receive(event('newMessage', message({ id: 'm3', message: 'third one later' })));
  t.mock.timers.tick(100);
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1][0].id, 'm3');

  ws.receive(event('viewerCount', { roomId: 'MINT', count: 42, livestreamId: 'x' }));
  assert.equal(source.getState().viewers, 42);
  ws.receive(event('viewerCount', { roomId: 'OTHER', count: 7 }));
  assert.equal(source.getState().viewers, 42, 'another room does not count');
  ws.receive(event('userLeft', { roomId: 'MINT' }));
  ws.receive(event('somethingNew', { x: 1 }));
  ws.receive(event('messageHistory', [message({ id: 'h1', message: 'from before we joined' }), message({ id: 'm1' })]));
  assert.deepEqual(source.getState().messages.map((m) => m.id), ['m1', 'm2', 'm3', 'h1']);
  t.mock.timers.tick(100);
  assert.equal(delivered.length, 2, 'history is shown, not sent to the hosts');
});

test('getState is a stable reference until something changes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = new P.PumpChatSource('MINT', { socket: FakeSocket, batchMs: 100, debug: false });
  t.after(() => source.stop());
  let notified = 0;
  const unsubscribe = source.subscribe(() => notified++);
  const { ws } = open(source);
  const live = source.getState();
  assert.equal(live.status, 'live');
  const seen = notified;
  ws.receive('2');
  ws.receive(event('userLeft', { roomId: 'MINT' }));
  ws.receive(event('viewerCount', { roomId: 'MINT', count: 0 }));
  ws.receive(event('viewerCount', { roomId: 'MINT', count: 0 }));
  assert.notEqual(source.getState(), live, 'the first viewer count is a change');
  const after = source.getState();
  const count = notified;
  ws.receive('2');
  ws.receive(event('newMessage', { messageType: 'SYSTEM', message: 'x', username: 'y' }));
  assert.equal(source.getState(), after, 'nothing changed, same object');
  assert.equal(notified, count, 'and nobody was woken');
  assert.ok(notified > seen);
  unsubscribe();
  ws.receive(event('newMessage', message()));
  assert.equal(notified, count, 'unsubscribed listeners stay quiet');
});

test('a dropped socket comes back with backoff, and stop() ends that', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  FakeSocket.instances.length = 0;
  const source = new P.PumpChatSource('MINT', { socket: FakeSocket, batchMs: 100, debug: false });
  t.after(() => source.stop());
  const { ws, delivered } = open(source);
  ws.receive(event('newMessage', message()));
  ws.drop('bye');
  let state = source.getState();
  assert.equal(state.status, 'reconnecting');
  assert.equal(state.attempts, 1);
  assert.equal(state.error, 'bye');
  assert.equal(state.viewers, null);
  assert.equal(FakeSocket.instances.length, 1, 'not before the backoff');
  t.mock.timers.tick(999);
  assert.equal(FakeSocket.instances.length, 1);
  t.mock.timers.tick(251);
  assert.equal(FakeSocket.instances.length, 2, 'a fresh socket after 1s (+ jitter)');
  const again = last();
  assert.notEqual(again, ws);
  again.receive(OPEN);
  again.receive(CONNECTED);
  state = source.getState();
  assert.equal(state.status, 'live');
  assert.equal(state.attempts, 1, 'the backoff only resets once the session proves itself');
  assert.equal(state.error, '');
  assert.equal(again.sent[1], P.joinFrame('MINT'), 'the room is joined again');
  again.receive(event('newMessage', message()));
  assert.equal(source.getState().attempts, 0, 'a real event proves the session');
  assert.equal(source.getState().messages.length, 1, 'a replayed message is not shown twice');
  t.mock.timers.tick(100);
  assert.equal(delivered.length, 1, 'nor delivered twice');
  assert.equal(delivered[0].length, 1);

  // Second failure backs off longer.
  again.drop();
  assert.equal(source.getState().attempts, 1);
  t.mock.timers.tick(1250);
  assert.equal(FakeSocket.instances.length, 3);
  last().drop('again');
  assert.equal(source.getState().attempts, 2);
  t.mock.timers.tick(1250);
  assert.equal(FakeSocket.instances.length, 3, 'attempt two waits two seconds');
  t.mock.timers.tick(1250);
  assert.equal(FakeSocket.instances.length, 4);

  // A silent socket is treated as dead once two pings (25s each) plus slack have passed.
  const quiet = last();
  quiet.receive(OPEN);
  quiet.receive(CONNECTED);
  assert.equal(source.getState().status, 'live');
  t.mock.timers.tick(30000);
  quiet.receive('2');
  assert.equal(quiet.sent[quiet.sent.length - 1], '3');
  t.mock.timers.tick(54999);
  assert.equal(source.getState().status, 'live', 'a ping resets the clock');
  t.mock.timers.tick(1);
  assert.equal(source.getState().status, 'reconnecting');
  assert.equal(source.getState().error, 'No heartbeat');
  assert.equal(quiet.closed, true);

  source.stop();
  state = source.getState();
  assert.equal(state.status, 'off');
  assert.equal(state.attempts, 0);
  const before = FakeSocket.instances.length;
  t.mock.timers.tick(120000);
  assert.equal(FakeSocket.instances.length, before, 'no reconnect after stop');
  quiet.drop('late close');
  assert.equal(source.getState().status, 'off', 'a late close does not revive it');
  assert.equal(source.getState().messages.length, 1, 'the log survives for the panel');
});

test('stop() closes a live socket and drops the pending batch', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = new P.PumpChatSource('MINT', { socket: FakeSocket, batchMs: 100, debug: false });
  const { ws, delivered } = open(source);
  ws.receive(event('newMessage', message({ id: 'p1' })));
  source.stop();
  assert.equal(ws.closed, true);
  t.mock.timers.tick(1000);
  assert.equal(delivered.length, 0);
  ws.receive(event('newMessage', message({ id: 'p2' })));
  assert.equal(source.getState().messages.length, 1, 'frames after stop are ignored');
  // It can be started again.
  const count = FakeSocket.instances.length;
  source.start(() => {});
  assert.equal(FakeSocket.instances.length, count + 1);
  assert.equal(source.getState().status, 'connecting');
  source.stop();
});

test('without a WebSocket class the source reports itself off instead of throwing', () => {
  const source = new P.PumpChatSource('MINT', { socket: undefined, debug: false });
  const saved = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { value: undefined, configurable: true, writable: true });
  try {
    const bare = new P.PumpChatSource('MINT', { debug: false });
    bare.start(() => {});
    assert.equal(bare.getState().status, 'off');
    assert.match(bare.getState().error, /WebSocket/);
    bare.stop();
  } finally {
    Object.defineProperty(globalThis, 'WebSocket', { value: saved, configurable: true, writable: true });
  }
  source.stop();
});

test('a refused or ended session reconnects instead of hanging, and the panel can say why', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  FakeSocket.instances.length = 0;
  const source = new P.PumpChatSource('MINT', { socket: FakeSocket, batchMs: 100, debug: false });
  t.after(() => source.stop());
  const { ws } = open(source);
  ws.receive('44{"message":"unauthorized"}');
  let state = source.getState();
  assert.equal(state.status, 'reconnecting');
  assert.equal(state.error, 'unauthorized');
  assert.equal(state.attempts, 1);
  t.mock.timers.tick(1300);
  assert.equal(FakeSocket.instances.length, 2, 'a fresh socket after the backoff');
  const again = last();
  again.receive(OPEN);
  again.receive(CONNECTED);
  again.receive('41');
  state = source.getState();
  assert.equal(state.status, 'reconnecting', 'a namespace disconnect is a drop too');
  assert.equal(state.attempts, 2, 'and the backoff keeps climbing until a session proves itself');
});
