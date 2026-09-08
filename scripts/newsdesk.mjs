#!/usr/bin/env node
// The crypto news desk: a loopback HTTP wrapper around the Grok CLI, which the Worker
// cannot spawn itself. Deliberately dumb — prompt in, raw CLI envelope out. Every prompt
// lives in lib/newsdesk.ts and every parser in lib/topics.ts, where the tests can reach them.
//
// Policy (model, turns, cwd, sandbox, tool denylist, timeout) is fixed here and never taken
// from the request: that is what makes a local endpoint that spends money safe to run.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.NEWSDESK_PORT || 8791);
const TOKEN = process.env.NEWSDESK_TOKEN || 'local';
const GROK = process.env.GROK_BIN || path.join(os.homedir(), '.grok', 'bin', 'grok');
const AUTH = path.join(os.homedir(), '.grok', 'auth.json');
const MCP_OFF = JSON.stringify({
  disabled_mcp_servers: (
    process.env.NEWSDESK_DISABLE_MCP ||
    'mcp-search,cloudflare-docs,cloudflare-bindings,cloudflare-builds,cloudflare-observability,context7,chrome-devtools,shadcn,playwright,vercel,posthog,sentry'
  )
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean),
});
const SCRATCH = path.join(os.tmpdir(), 'pepe-newsdesk');
const SPEND = path.join(SCRATCH, 'spend.json');
const TIMEOUT_MS = Number(process.env.NEWSDESK_TIMEOUT_MS || 170000);
// Off by default: the subscription is prepaid, so these exist only as a brake if it ever bites.
const MAX_PER_HOUR = Number(process.env.NEWSDESK_MAX_PER_HOUR || 0);
const MAX_SPEND_USD = Number(process.env.NEWSDESK_MAX_SPEND_USD || 0);
// Exact tool ids read off the CLI's own init event. Everything that touches the machine.
const DENY = [
  'run_terminal_command',
  'search_replace',
  'write',
  'read_file',
  'list_dir',
  'grep',
  'spawn_subagent',
  'kill_command_or_subagent',
  'get_command_or_subagent_output',
  'scheduler_create',
  'scheduler_delete',
  'scheduler_list',
  'monitor',
  'workflow',
  'todo_write',
  'image_gen',
  'image_edit',
  'image_to_video',
  'reference_to_video',
  'ask_user_question',
  'enter_plan_mode',
  'exit_plan_mode',
].join(',');

let inflight = false;
let calls = [];
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req, cap = 64 * 1024) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > cap) reject(Error('Request too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
function authorized(req) {
  // The Worker's fetch carries neither header; every cross-origin browser request carries both.
  if (req.headers.origin || req.headers['sec-fetch-site']) return false;
  const given = Buffer.from(String(req.headers['x-newsdesk-token'] || ''));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}
async function spend() {
  try {
    const saved = JSON.parse(await readFile(SPEND, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    return saved.day === today ? saved : { day: today, usd: 0, calls: 0 };
  } catch {
    return { day: new Date().toISOString().slice(0, 10), usd: 0, calls: 0 };
  }
}
async function recordSpend(usd) {
  const current = await spend();
  current.usd += usd || 0;
  current.calls += 1;
  await writeFile(SPEND, JSON.stringify(current));
  return current;
}
async function auth() {
  try {
    const data = JSON.parse(await readFile(AUTH, 'utf8'));
    const entry = Object.values(data)[0];
    if (!entry?.key) return { authed: false, reason: 'not-authed' };
    // The CLI refreshes silently; a stale stamp only matters once refresh itself fails.
    return { authed: true, expiresAt: entry.expires_at ?? null };
  } catch {
    return { authed: false, reason: 'not-authed' };
  }
}
function runGrok(promptFile) {
  return new Promise((resolve) => {
    const args = [
      '--prompt-file', promptFile,
      '--verbatim',
      '--output-format', 'json',
      '--max-turns', '6',
      '--cwd', SCRATCH,
      '--no-plan',
      '--no-subagents',
      '--no-auto-update',
      '--disallowed-tools', DENY,
    ];
    const child = execFile(
      GROK,
      args,
      {
        cwd: SCRATCH,
        env: {
          PATH: process.env.PATH,
          HOME: os.homedir(),
          GROK_MEMORY: '0', // an injected instruction must never persist into ~/.grok/memory
          GROK_CONFIG: MCP_OFF,
          GROK_DISABLE_AUTOUPDATER: '1',
          RUST_LOG: 'error',
          NO_COLOR: '1',
          TERM: 'dumb',
        },
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        clearTimeout(hard);
        clearTimeout(soft);
        resolve({ error, stdout, stderr });
      },
    );
    child.stdin?.end();
    const soft = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    const hard = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS + 5000);
    const stop = () => child.kill('SIGKILL');
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      const [state, today] = await Promise.all([auth(), spend()]);
      return json(res, 200, { ok: true, busy: inflight, ...state, today });
    }
    if (req.method !== 'POST' || req.url !== '/run')
      return json(res, 404, { error: 'Not found' });
    if (!authorized(req)) return json(res, 401, { error: 'Not authorized' });
    if (inflight)
      return json(res, 409, { error: 'A research call is already running', retryAfterMs: 20000 });

    const state = await auth();
    if (!state.authed)
      return json(res, 503, {
        error: 'Grok is not signed in. Run: grok login',
        reason: 'not-authed',
      });
    const today = await spend();
    const hourAgo = Date.now() - 3600000;
    calls = calls.filter((t) => t > hourAgo);
    if (MAX_PER_HOUR && calls.length >= MAX_PER_HOUR)
      return json(res, 429, { error: 'Hourly limit reached', retryAfterMs: 600000 });
    if (MAX_SPEND_USD && today.usd >= MAX_SPEND_USD)
      return json(res, 429, { error: 'Daily spend limit reached', retryAfterMs: 3600000 });

    const body = JSON.parse((await readBody(req)) || '{}');
    const prompt = typeof body.prompt === 'string' ? body.prompt.slice(0, 12000) : '';
    if (body.kind !== 'research' || !prompt)
      return json(res, 400, { error: 'Expected {kind:"research", prompt}' });

    inflight = true;
    calls.push(Date.now());
    const started = Date.now();
    const promptFile = path.join(SCRATCH, 'prompt.txt');
    await writeFile(promptFile, prompt);
    const { error, stdout, stderr } = await runGrok(promptFile);
    inflight = false;
    const ms = Date.now() - started;
    const tail = String(stderr || '').slice(-2000);

    if (error && !stdout) {
      if (error.code === 'ENOENT')
        return json(res, 503, {
          error: `Grok CLI not found at ${GROK}`,
          reason: 'not-installed',
        });
      if (error.killed)
        return json(res, 504, { error: `Timed out after ${ms}ms`, stderrTail: tail, ms });
      // Narrow on purpose: MCP servers log their own AuthRequired errors to this stream.
      if (/\b(grok login|not (signed|logged) in|session expired|refresh token)\b/i.test(tail))
        return json(res, 503, {
          error: 'Grok login expired. Run: grok login',
          reason: 'not-authed',
        });
      return json(res, 502, { error: 'The Grok CLI failed', stderrTail: tail, ms });
    }
    let envelope;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      return json(res, 502, { error: 'The Grok CLI did not return JSON', stderrTail: tail, ms });
    }
    // The CLI reports API failures as a JSON error object on stdout, so a readable
    // envelope is not the same as a successful call. Quota and auth must be told
    // apart from a transient blip: only the transient kind is worth retrying.
    if (envelope.type === 'error' || envelope.error) {
      const detail = String(envelope.message || envelope.error || 'unknown');
      if (/402|payment required|balance exhausted|out of credit|quota/i.test(detail))
        return json(res, 503, {
          error:
            'Grok Build balance is exhausted, so the crypto desk is paused. Top up your xAI plan or wait for the weekly reset.',
          reason: 'no-credit',
          detail: detail.slice(0, 300),
          ms,
        });
      if (/401|403|unauthor|not signed in|login/i.test(detail))
        return json(res, 503, {
          error: 'Grok login expired. Run: grok login',
          reason: 'not-authed',
          detail: detail.slice(0, 300),
          ms,
        });
      return json(res, 502, { error: `The Grok CLI failed: ${detail.slice(0, 200)}`, ms });
    }
    if (!String(envelope.text ?? '').trim())
      return json(res, 502, {
        error: 'The Grok CLI returned an empty answer',
        stopReason: envelope.stopReason,
        stderrTail: tail,
        ms,
      });
    const totalCostUsd = envelope.total_cost_usd ?? 0;
    const today2 = await recordSpend(totalCostUsd);
    console.log(
      `[newsdesk] ok ms=${ms} usd=${totalCostUsd.toFixed(4)} today=$${today2.usd.toFixed(2)} calls=${today2.calls}`,
    );
    return json(res, 200, {
      ok: true,
      text: String(envelope.text ?? '').slice(0, 200000),
      structuredOutput: envelope.structuredOutput ?? null,
      stopReason: envelope.stopReason,
      usage: envelope.usage,
      totalCostUsd,
      ms,
    });
  } catch (e) {
    inflight = false;
    return json(res, 500, { error: e instanceof Error ? e.message : 'Desk failure' });
  }
});

await mkdir(SCRATCH, { recursive: true });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[newsdesk] listening on http://127.0.0.1:${PORT} (grok: ${GROK})`);
});
