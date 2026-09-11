import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

// railway.mjs reads and writes .dev.vars in the working directory, and the operator's real one
// holds the live box's ids and tokens. Every test here runs in a scratch folder instead, with
// nothing inherited from the shell that could point it at a real service.
const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRATCH = await mkdtemp(join(tmpdir(), 'railway-test-'));
process.chdir(SCRATCH);
process.on('exit', () => rmSync(SCRATCH, { recursive: true, force: true }));
for (const name of Object.keys(process.env))
  if (/^(RAILWAY_|SPONSOR_)/.test(name)) delete process.env[name];

const railway = await import('../scripts/railway.mjs');
const media = await import('../scripts/media.mjs');

const BOX_VARS = [
  'RAILWAY_TOKEN=test-token',
  'RAILWAY_PROJECT_ID=proj-1',
  'RAILWAY_ENVIRONMENT_ID=env-1',
  'RAILWAY_SERVICE_ID=box-1',
  'FAL_KEY=fal-keep-me',
  '',
].join('\n');
const BOX = { id: 'box-1', name: 'broadcast-box' };
const STAGING =
  'https://interdimensional-podcast-staging.leonardo-chekup.workers.dev';

let calls = [];

/**
 * A Railway that answers from `services` and `domains`, recording every request. Deployments
 * report `statuses` in turn, and https://media.example/health answers `mediaHealth`.
 */
async function fresh({
  vars = BOX_VARS,
  services = [BOX],
  domains = [],
  statuses = ['SUCCESS'],
  mediaHealth = { status: 200, body: {} },
  serviceVars = {},
} = {}) {
  await writeFile('.dev.vars', vars);
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = typeof url === 'string' ? url : url.href;
    if (href.startsWith('https://media.example/')) {
      calls.push({ media: href, headers: init.headers ?? {} });
      return new Response(JSON.stringify(mediaHealth.body), {
        status: mediaHealth.status,
      });
    }
    if (href.startsWith('https://backboard.railway.com/project/')) {
      calls.push({ upload: href, body: Buffer.from(init.body) });
      return new Response(
        JSON.stringify({ deploymentId: 'dep-1', url: 'https://railway/x' }),
      );
    }
    assert.equal(href, 'https://backboard.railway.com/graphql/v2');
    const { query, variables } = JSON.parse(init.body);
    calls.push({ query, variables });
    const reply = (data) => new Response(JSON.stringify({ data }));
    const edges = () => ({ edges: services.map((node) => ({ node })) });
    if (/projects\s*\{/.test(query))
      return reply({
        projects: {
          edges: [
            {
              node: {
                id: 'proj-1',
                name: 'interdimensional-podcast',
                environments: {
                  edges: [{ node: { id: 'env-1', name: 'production' } }],
                },
                services: edges(),
              },
            },
          ],
        },
      });
    if (/project\(id:/.test(query))
      return reply({ project: { services: edges() } });
    if (/serviceCreate/.test(query)) {
      const node = {
        id: `svc-${variables.input.name}`,
        name: variables.input.name,
      };
      services.push(node);
      return reply({ serviceCreate: { id: node.id } });
    }
    if (/variableCollectionUpsert/.test(query))
      return reply({ variableCollectionUpsert: true });
    if (/variables\(projectId/.test(query))
      return reply({ variables: serviceVars[variables.serviceId] ?? {} });
    if (/serviceInstanceUpdate/.test(query))
      return reply({ serviceInstanceUpdate: true });
    if (/domains\(/.test(query))
      return reply({ domains: { serviceDomains: domains } });
    if (/serviceDomainCreate/.test(query))
      return reply({
        serviceDomainCreate: {
          domain: `${variables.input.serviceId}.up.railway.app`,
        },
      });
    if (/serviceDomainUpdate/.test(query))
      return reply({ serviceDomainUpdate: true });
    if (/deployment\(id:/.test(query))
      return reply({
        deployment: {
          id: variables.id,
          status: statuses.length > 1 ? statuses.shift() : statuses[0],
        },
      });
    if (/buildLogs|deploymentLogs/.test(query))
      return reply({
        buildLogs: [{ message: 'the build log tail  ', severity: 'error' }],
        deploymentLogs: [{ message: 'the run log tail', severity: 'info' }],
      });
    throw Error(`Unexpected query: ${query}`);
  };
}

/** Run `fn` with console output captured instead of printed. */
async function quietly(fn) {
  const printed = [];
  const { log, error } = console;
  console.log = (...args) => printed.push(args.join(' '));
  console.error = (...args) => printed.push(args.join(' '));
  try {
    return { result: await fn(), printed: printed.join('\n') };
  } finally {
    Object.assign(console, { log, error });
  }
}

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const gqlCalls = (pattern) =>
  calls.filter((c) => c.query && pattern.test(c.query));
const devVars = () => readFile('.dev.vars', 'utf8');
const mediaIds = {
  projectId: 'proj-1',
  environmentId: 'env-1',
  serviceId: 'media-1',
  service: 'sponsor-media-devnet',
};

/** The file entries of a gzipped tarball, read by hand so the test trusts nothing it tests. */
function entries(gz) {
  const tar = gunzipSync(gz);
  const found = [];
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) => {
      const raw = header.subarray(start, start + length);
      const end = raw.indexOf(0);
      return raw.subarray(0, end === -1 ? length : end).toString('utf8');
    };
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12).trim(), 8);
    found.push({
      name: prefix ? `${prefix}/${name}` : name,
      type: field(156, 1) || '0',
      bytes: tar.subarray(at + 512, at + 512 + size),
    });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return found;
}

void test('the box is still reached through its saved ids, with no lookup at all', async () => {
  await fresh();
  const ids = await railway.target();
  assert.deepEqual(ids, {
    projectId: 'proj-1',
    environmentId: 'env-1',
    serviceId: 'box-1',
    service: 'broadcast-box',
  });
  assert.equal(calls.length, 0);
  assert.equal(await devVars(), BOX_VARS);
});

void test('a named service is found by name and is never handed the box id', async () => {
  await fresh({
    services: [BOX, { id: 'media-1', name: 'sponsor-media-devnet' }],
  });
  const ids = await railway.target({ service: 'sponsor-media-devnet' });
  assert.equal(ids.serviceId, 'media-1');
  assert.notEqual(ids.serviceId, 'box-1');
  assert.equal(gqlCalls(/serviceCreate/).length, 0, 'nothing is created');
  const file = await devVars();
  assert.match(file, /^RAILWAY_SERVICE_ID=box-1$/m, 'the box id is untouched');
  assert.match(file, /^RAILWAY_SERVICE_ID_SPONSOR_MEDIA_DEVNET=media-1$/m);
});

void test('a new service is created and remembered under its own key, and only that', async () => {
  await fresh();
  const ids = await railway.target({ service: 'sponsor-media-devnet' });
  assert.equal(ids.serviceId, 'svc-sponsor-media-devnet');
  const [create] = gqlCalls(/serviceCreate/);
  assert.deepEqual(create.variables.input, {
    projectId: 'proj-1',
    environmentId: 'env-1',
    name: 'sponsor-media-devnet',
  });
  assert.equal(
    await devVars(),
    `${BOX_VARS}RAILWAY_SERVICE_ID_SPONSOR_MEDIA_DEVNET=svc-sponsor-media-devnet\n`,
    'one line added; every other line exactly as it was',
  );
});

void test('on a machine that never set up the box, a named service leaves the box keys unwritten', async () => {
  await fresh({ vars: 'RAILWAY_TOKEN=test-token\n', services: [BOX] });
  const ids = await railway.target({ service: 'sponsor-media-devnet' });
  assert.equal(ids.projectId, 'proj-1', 'the existing project is adopted');
  const file = await devVars();
  assert.doesNotMatch(file, /^RAILWAY_SERVICE_ID=/m);
  assert.doesNotMatch(file, /^RAILWAY_PROJECT_ID=/m);
  assert.match(file, /^RAILWAY_SERVICE_ID_SPONSOR_MEDIA_DEVNET=svc-/m);
});

void test('a name that resolves to the box id is refused before anything is remembered', async () => {
  await fresh({ services: [{ id: 'box-1', name: 'sponsor-media-devnet' }] });
  await assert.rejects(
    railway.target({ service: 'sponsor-media-devnet' }),
    /broadcast box/,
  );
  assert.equal(await devVars(), BOX_VARS);
});

void test('looking up without create finds nothing and makes nothing', async () => {
  await fresh();
  assert.equal(
    await railway.target({ service: 'sponsor-media-devnet', create: false }),
    null,
  );
  assert.equal(gqlCalls(/serviceCreate/).length, 0);
  assert.equal(await devVars(), BOX_VARS);
});

void test('a new service has its variables merged, never replaced', async () => {
  await fresh();
  await railway.upsertVariables(mediaIds, { MEDIA_QUEUE: 6, SPONSOR_X: 'y' });
  const [upsert] = gqlCalls(/variableCollectionUpsert/);
  const input = upsert.variables.input;
  assert.equal('replace' in input, false);
  assert.equal(input.serviceId, 'media-1');
  assert.deepEqual(input.variables, { MEDIA_QUEUE: '6', SPONSOR_X: 'y' });
  await assert.rejects(
    railway.setVariables(mediaIds, { A: 'b' }),
    /upsertVariables/,
  );
  await assert.rejects(
    railway.upsertVariables(mediaIds, { SPONSOR_MEDIA_TOKEN: '' }),
    /no value/,
  );
  assert.equal(gqlCalls(/variableCollectionUpsert/).length, 1);
});

void test('the box still has its variables replaced outright, as air.mjs expects', async () => {
  await fresh();
  await railway.setVariables(await railway.target(), { FAL_KEY: 'x' });
  const [upsert] = gqlCalls(/variableCollectionUpsert/);
  assert.equal(upsert.variables.input.replace, true);
  assert.equal(upsert.variables.input.serviceId, 'box-1');
});

void test('setup never swaps a live service token for one .dev.vars just made', async () => {
  // Run from a folder without the tokens, setup makes new ones; the live service keeps its own.
  await fresh({
    services: [
      BOX,
      { id: 'svc-sponsor-media-devnet', name: 'sponsor-media-devnet' },
    ],
    serviceVars: {
      'svc-sponsor-media-devnet': { SPONSOR_MEDIA_TOKEN: 'a'.repeat(64) },
    },
  });
  await assert.rejects(
    quietly(() => media.setup('devnet')),
    /already has a SPONSOR_MEDIA_TOKEN that differs/,
  );
  assert.equal(
    gqlCalls(/variableCollectionUpsert/).length,
    0,
    'nothing was written',
  );
  // Asked outright, it replaces the token.
  await quietly(() => media.setup('devnet', '--rotate'));
  assert.ok(gqlCalls(/variableCollectionUpsert/).length > 0);
});

void test('a JSON log line reads as its fields, since Railway files it with an empty message', async () => {
  await fresh();
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const { query } = JSON.parse(init.body ?? '{}');
    if (/deploymentLogs/.test(query ?? ''))
      return new Response(
        JSON.stringify({
          data: {
            deploymentLogs: [
              { message: 'Reconciler returned 401.', severity: 'error' },
              {
                message: '',
                severity: 'info',
                attributes: [
                  { key: 'level', value: '"info"' },
                  { key: 'ok', value: 'true' },
                  { key: 'checked', value: '9' },
                ],
              },
            ],
          },
        }),
      );
    return real(url, init);
  };
  assert.deepEqual(await railway.logs('dep-1', 'run', 2), [
    'Reconciler returned 401.',
    'ok=true checked=9',
  ]);
});
void test('configure sends the service its own settings and a draining time, never a config file', async () => {
  await fresh();
  await railway.configure(mediaIds, {
    dockerfilePath: 'broadcast/Dockerfile.sponsor-media',
    drainingSeconds: 120,
    healthcheckPath: '/health',
  });
  const [update] = gqlCalls(/serviceInstanceUpdate/);
  assert.equal(update.variables.serviceId, 'media-1');
  assert.deepEqual(update.variables.input, {
    dockerfilePath: 'broadcast/Dockerfile.sponsor-media',
    drainingSeconds: 120,
    healthcheckPath: '/health',
  });
  await assert.rejects(
    railway.configure(mediaIds, { drainingSeconds: 1.5 }),
    /whole number/,
  );
  // Railway refuses config-as-code for a service now; saying so offline beats a half-set-up
  // service.
  await assert.rejects(
    railway.configure(mediaIds, {
      railwayConfigFile: 'broadcast/railway.sponsor-media.json',
    }),
    /no longer accepts a config file/,
  );
});

void test('the public address points at the port the service listens on', async () => {
  await fresh();
  const url = await railway.domain(mediaIds, 4017);
  assert.equal(url, 'https://media-1.up.railway.app');
  const [create] = gqlCalls(/serviceDomainCreate/);
  assert.equal(create.variables.input.targetPort, 4017);
  assert.equal(create.variables.input.serviceId, 'media-1');
  await assert.rejects(railway.domain(mediaIds), /listens on/);
  await assert.rejects(railway.domain(mediaIds, 0), /not a port/);

  // An address that already exists but aims elsewhere is re-aimed, not duplicated.
  await fresh({
    domains: [
      { id: 'dom-1', domain: 'media.up.railway.app', targetPort: 8080 },
    ],
  });
  assert.equal(
    await railway.domain(mediaIds, 4017),
    'https://media.up.railway.app',
  );
  const [update] = gqlCalls(/serviceDomainUpdate/);
  assert.equal(update.variables.input.targetPort, 4017);
  assert.equal(update.variables.input.serviceDomainId, 'dom-1');
  assert.equal(gqlCalls(/serviceDomainCreate/).length, 0);
});

void test("the box's address keeps its 8080 default and is never re-aimed", async () => {
  await fresh();
  await railway.domain(await railway.target());
  assert.equal(
    gqlCalls(/serviceDomainCreate/)[0].variables.input.targetPort,
    8080,
  );
  await fresh({
    domains: [{ id: 'dom-b', domain: 'box.up.railway.app', targetPort: null }],
  });
  assert.equal(
    await railway.domain(await railway.target()),
    'https://box.up.railway.app',
  );
  assert.equal(gqlCalls(/serviceDomainUpdate/).length, 0);
});

void test('the media upload is exactly what its Dockerfile copies, plus its two config files', async () => {
  await fresh({
    services: [BOX, { id: 'media-1', name: 'sponsor-media-devnet' }],
  });
  const ids = await railway.target({ service: 'sponsor-media-devnet' });
  const files = await media.uploadFiles('media');
  await railway.deploy(ids, { files, root: media.ROOT });
  const [upload] = calls.filter((c) => c.upload);
  assert.match(
    upload.upload,
    /\/project\/proj-1\/environment\/env-1\/up\?serviceId=media-1$/,
  );
  const archived = entries(upload.body);
  const names = archived.map((e) => e.name).sort(byName);

  // What the Dockerfile copies, read here independently of scripts/media.mjs.
  const dockerfile = await readFile(
    join(REPO, 'broadcast/Dockerfile.sponsor-media'),
    'utf8',
  );
  const sources = [...dockerfile.matchAll(/^COPY\s+(.+)$/gm)]
    .map(([, rest]) => rest.trim().split(/\s+/))
    .filter((parts) => !parts.some((p) => p.startsWith('--from')))
    .flatMap((parts) => parts.filter((p) => !p.startsWith('--')).slice(0, -1));
  const expected = new Set([
    'broadcast/Dockerfile.sponsor-media',
    'broadcast/railway.sponsor-media.json',
  ]);
  for (const source of sources) {
    const full = join(REPO, source);
    if ((await stat(full)).isFile()) expected.add(source);
    else
      for (const entry of await readdir(full, {
        recursive: true,
        withFileTypes: true,
      }))
        if (entry.isFile() && entry.name !== '.DS_Store')
          expected.add(
            posix.join(
              source,
              relative(full, join(entry.parentPath, entry.name)),
            ),
          );
  }
  assert.deepEqual(names, [...expected].sort(byName));

  // The files the image cannot run without, named outright.
  for (const needed of [
    'broadcast/sponsor-media.mjs',
    'scripts/wearable-render.py',
    'scripts/wearable_panel.py',
    'public/wearables/caps-v1-qualification.json',
    'public/wearables/pepe-cap-v1.json',
    'public/wearables/pepe-cap-v1.png',
    'public/wearables/gigachad-cap-v1.json',
    'public/wearables/gigachad-cap-v1.png',
  ])
    assert.ok(names.includes(needed), `${needed} is uploaded`);
  for (const name of names) {
    assert.doesNotMatch(name, /(^|\/)(node_modules|work|\.git|dist)\//);
    assert.doesNotMatch(name, /(^|\/)(\.dev\.vars|\.env)/);
  }
  assert.equal(
    names.includes('railway.json'),
    false,
    "the box's config stays home",
  );
  assert.equal(
    names.includes('Dockerfile'),
    false,
    "the box's image stays home",
  );
  assert.ok(names.length < 40, 'a few files, not the repository');

  // Byte for byte what is on disk, and readable by the ordinary tar Railway would use.
  for (const entry of archived) {
    assert.equal(entry.type, '0');
    assert.ok(
      entry.bytes.equals(await readFile(join(REPO, entry.name))),
      `${entry.name} is archived intact`,
    );
  }
  const listed = spawnSync('tar', ['-tzf', '-'], { input: upload.body });
  assert.equal(listed.status, 0, String(listed.stderr));
  assert.deepEqual(
    String(listed.stdout).trim().split('\n').sort(byName),
    names,
  );
});

void test('the reconciler upload is its Dockerfile, its config and its one script', async () => {
  assert.deepEqual(await media.uploadFiles('reconcile'), [
    'broadcast/Dockerfile.sponsor-reconcile',
    'broadcast/railway.sponsor-reconcile.json',
    'scripts/sponsor-reconcile.mjs',
  ]);
});

void test('a named service never uploads the whole repository, and secrets never leave', async () => {
  await fresh();
  await assert.rejects(railway.deploy(mediaIds), /whole repository/);
  for (const bad of [
    '.dev.vars',
    '.env.production',
    'node_modules/typescript/package.json',
    'work/tests/engine.js',
    '../outside.txt',
    '/etc/hosts',
  ])
    await assert.rejects(
      railway.pack(REPO, [bad]),
      /never leave|not a path/,
      bad,
    );
  assert.equal(calls.length, 0);
});

void test('the upload follows COPY and ADD lines, but not other stages or remote files', () => {
  assert.deepEqual(
    media.copySources(
      [
        'FROM node:22 AS node',
        'FROM python:3.12',
        'COPY --from=node /usr/local/bin/node /usr/local/bin/node',
        'COPY --chown=media:media broadcast/a.mjs broadcast/b.mjs broadcast/',
        'COPY ["scripts/x.py", "scripts/"]',
        'ADD https://example.com/tool.tgz /opt/',
        'COPY public/wearables \\',
        '  public/wearables',
        'RUN echo COPY nothing',
      ].join('\n'),
    ),
    ['broadcast/a.mjs', 'broadcast/b.mjs', 'scripts/x.py', 'public/wearables'],
  );
});

void test('each service reads its own config file, which never inherits the box settings', async () => {
  const mediaConfig = JSON.parse(
    await readFile(join(REPO, 'broadcast/railway.sponsor-media.json'), 'utf8'),
  );
  assert.equal(mediaConfig.build.builder, 'DOCKERFILE');
  assert.equal(
    mediaConfig.build.dockerfilePath,
    'broadcast/Dockerfile.sponsor-media',
  );
  assert.equal(mediaConfig.deploy.healthcheckPath, '/health');
  assert.equal(mediaConfig.deploy.drainingSeconds, 120);
  assert.equal(mediaConfig.deploy.sleepApplication, false);
  const reconcileConfig = JSON.parse(
    await readFile(
      join(REPO, 'broadcast/railway.sponsor-reconcile.json'),
      'utf8',
    ),
  );
  assert.equal(
    reconcileConfig.build.dockerfilePath,
    'broadcast/Dockerfile.sponsor-reconcile',
  );
  assert.equal(
    reconcileConfig.deploy.healthcheckPath,
    undefined,
    'the reconciler has no port to check',
  );
  assert.equal(reconcileConfig.deploy.restartPolicyType, 'ALWAYS');
  assert.equal(reconcileConfig.deploy.sleepApplication, false);
});

void test('setup gives both devnet services their own tokens, config and address, and leaves the box alone', async () => {
  await fresh();
  const printed = [];
  const log = console.log;
  console.log = (...args) => printed.push(args.join(' '));
  try {
    await media.setup('devnet');
  } finally {
    console.log = log;
  }

  assert.deepEqual(
    gqlCalls(/serviceCreate/).map((c) => c.variables.input.name),
    ['sponsor-media-devnet', 'sponsor-reconcile-devnet'],
  );
  const upserts = gqlCalls(/variableCollectionUpsert/).map(
    (c) => c.variables.input,
  );
  assert.equal(upserts.length, 2);
  for (const input of upserts) assert.equal('replace' in input, false);
  const [mediaVars, reconcileVars] = upserts.map((u) => u.variables);
  assert.equal(upserts[0].serviceId, 'svc-sponsor-media-devnet');
  assert.equal(upserts[1].serviceId, 'svc-sponsor-reconcile-devnet');
  assert.match(mediaVars.SPONSOR_MEDIA_TOKEN, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    { ...mediaVars, SPONSOR_MEDIA_TOKEN: 'x' },
    {
      SPONSOR_MEDIA_TOKEN: 'x',
      SPONSOR_SITE_ORIGIN: STAGING,
      MEDIA_CONCURRENCY: '2',
      MEDIA_QUEUE: '6',
      PORT: '4017',
      SPONSOR_MEDIA_PORT: '4017',
    },
  );
  assert.match(reconcileVars.SPONSOR_RECONCILE_TOKEN, /^[0-9a-f]{64}$/);
  assert.equal(reconcileVars.SPONSOR_ORIGIN, STAGING);
  assert.notEqual(
    reconcileVars.SPONSOR_RECONCILE_TOKEN,
    mediaVars.SPONSOR_MEDIA_TOKEN,
  );

  const [mediaUpdate, reconcileUpdate] = gqlCalls(/serviceInstanceUpdate/);
  assert.equal('railwayConfigFile' in mediaUpdate.variables.input, false);
  assert.equal(
    mediaUpdate.variables.input.dockerfilePath,
    'broadcast/Dockerfile.sponsor-media',
  );
  assert.equal(mediaUpdate.variables.input.healthcheckPath, '/health');
  assert.equal(mediaUpdate.variables.input.drainingSeconds, 120);
  assert.equal(
    reconcileUpdate.variables.input.dockerfilePath,
    'broadcast/Dockerfile.sponsor-reconcile',
  );
  assert.equal('healthcheckPath' in reconcileUpdate.variables.input, false);
  const [address] = gqlCalls(/serviceDomainCreate/);
  assert.equal(address.variables.input.serviceId, 'svc-sponsor-media-devnet');
  assert.equal(address.variables.input.targetPort, Number(mediaVars.PORT));
  assert.equal(
    gqlCalls(/serviceDomainCreate/).length,
    1,
    'the reconciler gets no address',
  );

  for (const call of calls)
    assert.equal(JSON.stringify(call.variables ?? {}).includes('box-1'), false);
  const file = await devVars();
  assert.ok(file.startsWith(BOX_VARS), 'every existing line kept as it was');
  assert.match(
    file,
    new RegExp(
      `^SPONSOR_MEDIA_TOKEN_DEVNET=${mediaVars.SPONSOR_MEDIA_TOKEN}$`,
      'm',
    ),
  );
  assert.match(
    file,
    new RegExp(
      `^SPONSOR_RECONCILE_TOKEN_DEVNET=${reconcileVars.SPONSOR_RECONCILE_TOKEN}$`,
      'm',
    ),
  );
  assert.match(
    file,
    /^SPONSOR_MEDIA_URL_DEVNET=https:\/\/svc-sponsor-media-devnet\.up\.railway\.app$/m,
  );
  assert.match(
    file,
    /^RAILWAY_SERVICE_ID_SPONSOR_MEDIA_DEVNET=svc-sponsor-media-devnet$/m,
  );
  assert.match(
    file,
    /^RAILWAY_SERVICE_ID_SPONSOR_RECONCILE_DEVNET=svc-sponsor-reconcile-devnet$/m,
  );

  const output = printed.join('\n');
  assert.equal(
    output.includes(mediaVars.SPONSOR_MEDIA_TOKEN),
    false,
    'tokens are never printed',
  );
  assert.equal(output.includes(reconcileVars.SPONSOR_RECONCILE_TOKEN), false);
  assert.match(output, /DEVNET_SPONSOR_MEDIA_TOKEN/);
  assert.match(output, /SITE_URL/);

  // Run again: the same services, the same tokens, nothing new created.
  const services = [
    BOX,
    { id: 'svc-sponsor-media-devnet', name: 'sponsor-media-devnet' },
    { id: 'svc-sponsor-reconcile-devnet', name: 'sponsor-reconcile-devnet' },
  ];
  const before = file;
  await fresh({
    vars: before,
    services,
    domains: [
      {
        id: 'd',
        domain: 'svc-sponsor-media-devnet.up.railway.app',
        targetPort: 4017,
      },
    ],
  });
  console.log = () => {};
  try {
    await media.setup('devnet');
  } finally {
    console.log = log;
  }
  assert.equal(gqlCalls(/serviceCreate/).length, 0);
  assert.equal(
    gqlCalls(/variableCollectionUpsert/)[0].variables.input.variables
      .SPONSOR_MEDIA_TOKEN,
    mediaVars.SPONSOR_MEDIA_TOKEN,
  );
  assert.equal(await devVars(), before);
});

void test('a short token someone typed by hand is refused rather than sent', async () => {
  await fresh({ vars: `${BOX_VARS}SPONSOR_MEDIA_TOKEN_DEVNET=short\n` });
  const log = console.log;
  console.log = () => {};
  try {
    await assert.rejects(media.setup('devnet'), /shorter than 32/);
  } finally {
    console.log = log;
  }
  assert.equal(calls.length, 0, 'Railway is not touched at all');
});

void test('service names and their keys', () => {
  assert.equal(
    media.serviceName('media', 'production'),
    'sponsor-media-production',
  );
  assert.equal(
    railway.serviceKey('sponsor-reconcile-production'),
    'RAILWAY_SERVICE_ID_SPONSOR_RECONCILE_PRODUCTION',
  );
  assert.throws(
    () => media.serviceName('media', 'mainnet'),
    /devnet or production/,
  );
  assert.throws(() => media.serviceName('box', 'devnet'), /media or reconcile/);
});

const MEDIA_SERVICES = () => [
  BOX,
  { id: 'media-1', name: 'sponsor-media-devnet' },
  { id: 'rec-1', name: 'sponsor-reconcile-devnet' },
];

void test('deploy sends each service its own files and follows the build to the end', async () => {
  await fresh({
    services: MEDIA_SERVICES(),
    statuses: ['BUILDING', 'DEPLOYING', 'SUCCESS'],
  });
  const { result, printed } = await quietly(() =>
    media.deployRole('devnet', 'reconcile', { every: 0 }),
  );
  assert.equal(result, true);
  const [upload] = calls.filter((c) => c.upload);
  assert.match(upload.upload, /serviceId=rec-1$/);
  assert.deepEqual(
    entries(upload.body)
      .map((e) => e.name)
      .sort(byName),
    await media.uploadFiles('reconcile'),
  );
  assert.match(printed, /building[\s\S]*deploying[\s\S]*success/);

  await fresh({ services: MEDIA_SERVICES(), statuses: ['BUILDING', 'FAILED'] });
  const failed = await quietly(() =>
    media.deployRole('devnet', 'media', { every: 0 }),
  );
  assert.equal(failed.result, false);
  assert.match(failed.printed, /the build log tail/);
  assert.match(calls.find((c) => c.upload).upload, /serviceId=media-1$/);
});

void test('deploy refuses a service that setup has not made, and creates nothing', async () => {
  await fresh();
  await assert.rejects(
    quietly(() => media.deployRole('devnet', 'media', { every: 0 })),
    /setup devnet/,
  );
  assert.equal(gqlCalls(/serviceCreate/).length, 0);
  assert.equal(calls.filter((c) => c.upload).length, 0);
});

void test('health reads the media service report and says whether a cap can sell', async () => {
  const vars = `${BOX_VARS}SPONSOR_MEDIA_URL_DEVNET=https://media.example\n`;
  const report = {
    ready: true,
    capQualified: true,
    templateVersion: 'caps-v1',
  };
  await fresh({ vars, mediaHealth: { status: 200, body: report } });
  const ok = await quietly(() => media.health('devnet', { reconciler: false }));
  assert.equal(ok.result, true);
  assert.match(ok.printed, /Ready to sell caps/);
  assert.equal(calls[0].media, 'https://media.example/health');

  await fresh({
    vars,
    mediaHealth: { status: 200, body: { ...report, ready: false } },
  });
  const down = await quietly(() =>
    media.health('devnet', { reconciler: false }),
  );
  assert.equal(down.result, false);
  assert.match(down.printed, /Not ready/);
});
