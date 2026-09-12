import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const { boxClient, minutesFlag, boxInstance } =
  await import('../scripts/box.mjs');
const { rehearsalIngest } = await import('../scripts/cfapi.mjs');
const railway = await import('../scripts/railway.mjs');

void test('the minutes flag is optional, and nonsense is refused rather than sent', () => {
  assert.equal(minutesFlag([]), undefined);
  assert.equal(minutesFlag(['--minutes', '90']), 90);
  assert.throws(() => minutesFlag(['--minutes']), /whole number/);
  assert.throws(() => minutesFlag(['--minutes', 'soon']), /whole number/);
  assert.equal(boxInstance.healthcheckPath, '/air/health');
});

void test('a box client sends the studio token, and says what to run on a fresh machine', async (t) => {
  process.env.STUDIO_TOKEN = 'studio-secret';
  process.env.TEST_BOX_URL = 'https://box.test/';
  t.after(() => {
    delete process.env.STUDIO_TOKEN;
    delete process.env.TEST_BOX_URL;
  });
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push({ url, init });
    if (String(url).endsWith('/air/off'))
      return Response.json({ error: 'not on air' }, { status: 409 });
    return Response.json({ ok: true, status: 'on' });
  });
  const box = boxClient('TEST_BOX_URL', 'node scripts/test.mjs setup');
  const data = await box.call('/air/on', {
    method: 'POST',
    body: { minutes: 5 },
  });
  assert.deepEqual(data, { ok: true, status: 'on' });
  assert.equal(seen[0].url, 'https://box.test/air/on');
  assert.equal(seen[0].init.headers['x-studio-token'], 'studio-secret');
  assert.equal(seen[0].init.body, '{"minutes":5}');
  await assert.rejects(
    box.call('/air/off', { method: 'POST', body: {} }),
    /not on air/,
  );
  delete process.env.TEST_BOX_URL;
  await assert.rejects(
    boxClient('TEST_BOX_URL', 'node scripts/test.mjs setup').call(
      '/air/status',
    ),
    /node scripts\/test\.mjs setup/,
  );
});

void test('a rehearsal never talks into the show input or a simulcast input', async (t) => {
  // devVar falls back to the .dev.vars in the working directory; run from an empty one.
  const cwd = process.cwd();
  process.chdir(await mkdtemp(join(tmpdir(), 'vars-')));
  t.after(() => process.chdir(cwd));
  Object.assign(process.env, {
    CF_ACCOUNT_ID: 'acct',
    CF_STREAM_TOKEN: 'stream-token',
    CF_LIVE_INPUT_ID: 'show-input',
    AIR_RTMP_INPUT: 'show-input',
  });
  t.after(() => {
    for (const name of [
      'CF_ACCOUNT_ID',
      'CF_STREAM_TOKEN',
      'CF_LIVE_INPUT_ID',
      'AIR_RTMP_INPUT',
    ])
      delete process.env[name];
  });
  let outputs = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).endsWith('/outputs'))
      return Response.json({ success: true, result: outputs });
    return Response.json({
      success: true,
      result: { rtmps: { url: 'rtmps://live/', streamKey: 'key' } },
    });
  });
  await assert.rejects(rehearsalIngest(), /show's own live input/);
  process.env.AIR_RTMP_INPUT = 'rehearsal-input';
  outputs = [{ id: 'x-simulcast' }];
  await assert.rejects(rehearsalIngest(), /simulcast output/);
  outputs = [];
  assert.deepEqual(await rehearsalIngest(), {
    url: 'rtmps://live/',
    key: 'key',
    uid: 'rehearsal-input',
  });
  delete process.env.AIR_RTMP_INPUT;
  await assert.rejects(rehearsalIngest(), /Set AIR_RTMP_INPUT/);
});

void test('following a deployment ends on success or on any dead state, skipped included', async (t) => {
  process.env.RAILWAY_TOKEN = 'rw';
  t.after(() => delete process.env.RAILWAY_TOKEN);
  const quiet = t.mock.method(console, 'log', () => {});
  const errors = t.mock.method(console, 'error', () => {});
  let statuses = ['BUILDING', 'DEPLOYING', 'SUCCESS'];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { query } = JSON.parse(init.body);
    if (/deployment\(id:/.test(query))
      return Response.json({
        data: {
          deployment: {
            id: 'dep',
            status: statuses.length > 1 ? statuses.shift() : statuses[0],
          },
        },
      });
    return Response.json({
      data: { buildLogs: [{ message: 'npm ERR! boom' }], deploymentLogs: [] },
    });
  });
  assert.equal(
    await railway.follow({ id: 'dep' }, 'the box', { every: 1, attempts: 10 }),
    true,
  );
  assert.deepEqual(
    quiet.mock.calls.map((c) => c.arguments[0].trim()),
    ['building', 'deploying', 'success'],
  );
  statuses = ['SKIPPED'];
  assert.equal(
    await railway.follow({ id: 'dep' }, 'the box', { every: 1, attempts: 10 }),
    false,
  );
  assert.ok(
    errors.mock.calls.some((c) => /skipped/.test(String(c.arguments[0]))),
    'a skipped build is reported, not polled for 20 minutes',
  );
  assert.ok(
    errors.mock.calls.some((c) => /npm ERR! boom/.test(String(c.arguments[0]))),
    'the build tail is shown',
  );
  statuses = ['BUILDING'];
  assert.equal(
    await railway.follow({ id: 'dep' }, 'the box', { every: 1, attempts: 3 }),
    false,
  );
  assert.ok(
    errors.mock.calls.some((c) => /still going/.test(String(c.arguments[0]))),
  );
});

void test('a repository upload is what git tracks, minus secrets and what .dockerignore drops', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repo-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  await writeFile(join(root, '.gitignore'), 'scratch/\n');
  await writeFile(
    join(root, '.dockerignore'),
    'docs\n*.tsbuildinfo\n.dev.vars.*\n!.dev.vars.example\n',
  );
  for (const file of [
    'package.json',
    'docs/notes.md',
    'lib/a.js',
    'tsconfig.tsbuildinfo',
    '.dev.vars',
    '.dev.vars.example',
    'scratch/big.bin',
    'work/out.mp4',
    'nested/x.tsbuildinfo',
  ])
    await writeFile(
      join(
        root,
        file.includes('/')
          ? await import('node:fs/promises').then((fs) =>
              fs
                .mkdir(join(root, file.split('/')[0]), { recursive: true })
                .then(() => file),
            )
          : file,
      ),
      'x',
    );
  git('add', 'package.json', 'lib/a.js');
  const files = await railway.repositoryFiles(root);
  // .dev.vars.example is un-ignored for Docker, but FORBIDDEN is broader on purpose: nothing
  // named like a secrets file leaves the machine, example or not.
  assert.deepEqual(files.sort(), [
    '.dockerignore',
    '.gitignore',
    'lib/a.js',
    'nested/x.tsbuildinfo',
    'package.json',
  ]);
});
