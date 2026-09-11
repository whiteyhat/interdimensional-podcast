// The two sponsorship services each site depends on, hosted on Railway beside the broadcast box.
//
//   node scripts/media.mjs setup  <devnet|production>   create both services, their secrets,
//                                                       settings and the media address
//   node scripts/media.mjs deploy <devnet|production> [media|reconcile]
//                                                       upload what each image needs and build it
//   node scripts/media.mjs status <devnet|production>   what Railway has for both, and what the
//                                                       site still needs
//   node scripts/media.mjs health <devnet|production>   ask the media service whether it can
//                                                       sell a cap
//
// sponsor-media-<env> normalizes logos, previews caps and composites the paid take; the site
// calls it with a shared token and stores what it returns. sponsor-reconcile-<env> asks the site
// to recover payments and reschedule paused placements every 20 seconds, so neither job waits on
// a studio being on air. Neither service holds a payment key.
//
// They share the box's Railway project and never touch the box. Each is found by name, reads its
// own config file (broadcast/railway.sponsor-*.json), is sent only the files its Dockerfile
// copies, and has its variables merged rather than replaced.
import { randomBytes } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { devVar, remember, VARS } from './devvars.mjs';
import * as railway from './railway.mjs';

/** The repository, wherever the script is run from: uploads are read from here. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The public site each pair of services works for. */
export const SITES = {
  devnet: {
    origin:
      'https://interdimensional-podcast-staging.leonardo-chekup.workers.dev',
  },
  production: { origin: 'https://frogclench.fun' },
};

/** The media service listens here, and its public address points here. */
export const MEDIA_PORT = 4017;

/** Each service's config-as-code file. Its Dockerfile, and so its upload, follow from it. */
export const ROLES = {
  media: 'broadcast/railway.sponsor-media.json',
  reconcile: 'broadcast/railway.sponsor-reconcile.json',
};

// The settings from a config file that are also written onto the service itself, so the
// dashboard shows them before the first build and a config file Railway failed to find still
// leaves the service configured.
const MIRRORED = [
  'startCommand',
  'numReplicas',
  'healthcheckPath',
  'healthcheckTimeout',
  'restartPolicyType',
  'restartPolicyMaxRetries',
  'sleepApplication',
  'overlapSeconds',
  'drainingSeconds',
];

function checkEnv(env) {
  if (!Object.hasOwn(SITES, env))
    throw Error('Say which site: devnet or production.');
  return env;
}

function checkRole(role) {
  if (!Object.hasOwn(ROLES, role))
    throw Error(`Say which service: ${Object.keys(ROLES).join(' or ')}.`);
  return role;
}

export const serviceName = (role, env) =>
  `sponsor-${checkRole(role)}-${checkEnv(env)}`;

async function readConfig(role) {
  return JSON.parse(await readFile(join(ROOT, ROLES[checkRole(role)]), 'utf8'));
}

/** The Railway service settings a role's config file asks for. */
export async function instanceSettings(role) {
  const { build = {}, deploy = {} } = await readConfig(role);
  const settings = {
    railwayConfigFile: ROLES[role],
    dockerfilePath: build.dockerfilePath,
  };
  for (const key of MIRRORED)
    if (deploy[key] !== undefined) settings[key] = deploy[key];
  return settings;
}

/**
 * Every path a Dockerfile takes from the build context with COPY or ADD. Sources from another
 * stage or image (`--from`) and remote ADD URLs are not in the context, so they are skipped.
 */
export function copySources(dockerfile) {
  const sources = [];
  for (const line of dockerfile.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const match = /^\s*(COPY|ADD)\s+(.+)$/i.exec(line);
    if (!match) continue;
    let rest = match[2].trim();
    const flags = [];
    while (rest.startsWith('--')) {
      const [flag] = rest.split(/\s/, 1);
      flags.push(flag);
      rest = rest.slice(flag.length).trim();
    }
    if (flags.some((flag) => flag.startsWith('--from'))) continue;
    if (rest.startsWith('<<'))
      throw Error('A heredoc COPY has no source file to upload.');
    const parts = rest.startsWith('[') ? JSON.parse(rest) : rest.split(/\s+/);
    for (const source of parts.slice(0, -1))
      if (!/^https?:\/\//.test(source)) sources.push(source);
  }
  return sources;
}

// Local clutter that no image wants, even when it sits inside a copied folder.
const CLUTTER = new Set(['.DS_Store', '__pycache__']);

/** One COPY source as the files under it, relative to the repository. */
async function expand(source) {
  const path = posix.normalize(source.replace(/^\.\//, '')).replace(/\/+$/, '');
  if (
    !path ||
    path === '.' ||
    path.startsWith('/') ||
    path.split('/').includes('..') ||
    /[*?[\]]/.test(path)
  )
    throw Error(
      `The Dockerfile copies "${source}". The upload is exactly what the Dockerfile copies, ` +
        'so it has to name files or folders: not the whole context, and not a pattern.',
    );
  const info = await stat(join(ROOT, path)).catch(() => null);
  if (!info)
    throw Error(`The Dockerfile copies ${path}, which does not exist.`);
  if (info.isFile()) return [path];
  if (!info.isDirectory()) throw Error(`${path} is not a file or a folder.`);
  const files = [];
  const entries = await readdir(join(ROOT, path), { withFileTypes: true });
  for (const entry of entries) {
    if (CLUTTER.has(entry.name)) continue;
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await expand(child)));
    else if (entry.isFile()) files.push(child);
    else throw Error(`${child} is a link; copy the file itself.`);
  }
  return files;
}

// A relative import the Dockerfile does not copy builds fine and then crashes on start, which
// for the reconciler (no healthcheck) looks like a service quietly restarting forever.
const RELATIVE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.\.?\/[^'"]+)['"]/g;
async function checkImports(files, dockerfile) {
  const shipped = new Set(files);
  for (const file of files.filter((f) => /\.(mjs|cjs|js)$/.test(f))) {
    const source = await readFile(join(ROOT, file), 'utf8');
    for (const [, specifier] of source.matchAll(RELATIVE_IMPORT)) {
      const needed = posix.normalize(
        posix.join(posix.dirname(file), specifier),
      );
      if (!shipped.has(needed))
        throw Error(
          `${file} imports ${needed}, which ${dockerfile} does not copy into the image.`,
        );
    }
  }
}

/**
 * The files one service's upload carries: its config file, its Dockerfile, and exactly what
 * that Dockerfile copies, read from the Dockerfile itself so the two cannot drift apart.
 * Nothing else leaves the machine.
 */
export async function uploadFiles(role) {
  const config = await readConfig(role);
  const dockerfile = config.build?.dockerfilePath;
  if (!dockerfile) throw Error(`${ROLES[role]} names no Dockerfile.`);
  const files = new Set([ROLES[role], dockerfile]);
  const text = await readFile(join(ROOT, dockerfile), 'utf8');
  for (const source of copySources(text))
    for (const file of await expand(source)) files.add(file);
  const list = [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  await checkImports(list, dockerfile);
  return list;
}

/** A shared secret, made once per site and kept in .dev.vars so setup can be run again. */
async function secret(name) {
  const existing = await devVar(name);
  if (existing) {
    if (existing.length < 32)
      throw Error(
        `${name} in ${VARS} is shorter than 32 characters. Delete that line and run setup again for a new one.`,
      );
    return existing;
  }
  const value = randomBytes(32).toString('hex');
  await remember({ [name]: value });
  return value;
}

/** What the media service is told. MEDIA_CONCURRENCY and MEDIA_QUEUE bound its render desk. */
export function mediaVariables(env, token) {
  const port = String(MEDIA_PORT);
  return {
    SPONSOR_MEDIA_TOKEN: token,
    SPONSOR_SITE_ORIGIN: SITES[checkEnv(env)].origin,
    MEDIA_CONCURRENCY: '2',
    MEDIA_QUEUE: '6',
    // Railway's healthcheck and the public address both go to PORT. The image has always read
    // SPONSOR_MEDIA_PORT, so both names carry the one number and can never disagree.
    PORT: port,
    SPONSOR_MEDIA_PORT: port,
  };
}

export const mask = (value) =>
  value ? `****${value.slice(-4)} (${value.length} characters)` : 'missing';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- commands ---------------------------------------------------------------------------

/** The worker's half of each secret, and how to put it there. Tokens are never printed whole. */
async function nextSteps(env) {
  const key = env.toUpperCase();
  const url = await devVar(`SPONSOR_MEDIA_URL_${key}`);
  const origin = SITES[env].origin;
  const from = (name) => `"$(grep '^${name}_${key}=' ${VARS} | cut -d= -f2-)"`;
  console.log(`\nThe ${env} site needs these (tokens are in ${VARS}):`);
  console.log(`  SPONSOR_MEDIA_URL        ${url || 'none yet: run setup'}`);
  console.log(
    `  SPONSOR_MEDIA_TOKEN      ${mask(await devVar(`SPONSOR_MEDIA_TOKEN_${key}`))}`,
  );
  console.log(
    `  SPONSOR_RECONCILE_TOKEN  ${mask(await devVar(`SPONSOR_RECONCILE_TOKEN_${key}`))}`,
  );
  console.log(`  SITE_URL                 ${origin}`);
  if (!url) {
    console.log(`\nRun node scripts/media.mjs setup ${env} first.`);
    return;
  }
  if (env === 'devnet') {
    console.log(
      '\nThe "Deploy devnet" workflow puts them on the worker every run. Store them in GitHub once:',
    );
    console.log(`  gh variable set DEVNET_SPONSOR_MEDIA_URL --body '${url}'`);
    console.log(
      `  printf '%s' ${from('SPONSOR_MEDIA_TOKEN')} | gh secret set DEVNET_SPONSOR_MEDIA_TOKEN`,
    );
    console.log(
      `  printf '%s' ${from('SPONSOR_RECONCILE_TOKEN')} | gh secret set DEVNET_SPONSOR_RECONCILE_TOKEN`,
    );
    console.log(`  gh variable set DEVNET_ORIGIN --body '${origin}'`);
    console.log('  gh workflow run deploy-devnet.yml --ref main');
  } else {
    const put = (name) =>
      `npx wrangler secret put ${name} --config dist/server/wrangler.json`;
    console.log(
      '\nPut them on the production worker from a production build (npm run build first):',
    );
    console.log(`  printf '%s' '${url}' | ${put('SPONSOR_MEDIA_URL')}`);
    console.log(
      `  printf '%s' ${from('SPONSOR_MEDIA_TOKEN')} | ${put('SPONSOR_MEDIA_TOKEN')}`,
    );
    console.log(
      `  printf '%s' ${from('SPONSOR_RECONCILE_TOKEN')} | ${put('SPONSOR_RECONCILE_TOKEN')}`,
    );
    console.log(`  printf '%s' '${origin}' | ${put('SITE_URL')}`);
  }
}

export async function setup(env) {
  checkEnv(env);
  const key = env.toUpperCase();
  // Secrets first: a bad value in .dev.vars stops setup before Railway has anything half-made.
  const mediaVars = mediaVariables(
    env,
    await secret(`SPONSOR_MEDIA_TOKEN_${key}`),
  );
  const reconcileVars = {
    SPONSOR_ORIGIN: SITES[env].origin,
    SPONSOR_RECONCILE_TOKEN: await secret(`SPONSOR_RECONCILE_TOKEN_${key}`),
  };
  const media = await railway.target({ service: serviceName('media', env) });
  const reconcile = await railway.target({
    service: serviceName('reconcile', env),
  });
  await railway.upsertVariables(media, mediaVars);
  await railway.upsertVariables(reconcile, reconcileVars);
  await railway.configure(media, await instanceSettings('media'));
  await railway.configure(reconcile, await instanceSettings('reconcile'));
  const url = await railway.domain(media, Number(mediaVars.PORT));
  await remember({ [`SPONSOR_MEDIA_URL_${key}`]: url });

  console.log(`${media.service} is at ${url} (port ${mediaVars.PORT}).`);
  console.log(
    `${reconcile.service} has no public address; it only calls ${SITES[env].origin}.`,
  );
  console.log(
    `Sent ${Object.keys(mediaVars).length} settings to the media service and ` +
      `${Object.keys(reconcileVars).length} to the reconciler; nothing else on either was changed or removed.`,
  );
  await nextSteps(env);
  console.log(`\nNext: node scripts/media.mjs deploy ${env}`);
}

const BROKEN = ['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED'];

/** Upload one service's files, then follow its deployment to the end. True when it is live. */
export async function deployRole(
  env,
  role,
  { every = 10_000, attempts = 150 } = {},
) {
  const name = serviceName(role, env);
  const ids = await railway.target({ service: name, create: false });
  if (!ids)
    throw Error(
      `Railway has no ${name} yet. Run: node scripts/media.mjs setup ${env}`,
    );
  const files = await uploadFiles(role);
  console.log(`\n${name}: uploading ${files.length} files...`);
  const started = await railway.deploy(ids, { files, root: ROOT });
  console.log(
    `Building ${started.megabytes} MB as deployment ${started.id.slice(0, 8)}.`,
  );
  let last = '';
  for (let i = 0; i < attempts; i++) {
    await sleep(every);
    const state = await railway.deployment(started.id).catch(() => null);
    if (!state) continue;
    if (state.status !== last) {
      console.log(`  ${state.status.toLowerCase()}`);
      last = state.status;
    }
    if (state.status === 'SUCCESS') return true;
    if (BROKEN.includes(state.status)) {
      console.error(
        `\n${name}'s deployment ${state.status.toLowerCase()}. Last of the build:\n`,
      );
      for (const line of (await railway.logs(started.id, 'build', 60)).slice(
        -25,
      ))
        console.error(`  ${line}`);
      if (state.status === 'CRASHED') {
        console.error('\nLast of its own output:\n');
        for (const line of (await railway.logs(started.id, 'run', 40)).slice(
          -15,
        ))
          console.error(`  ${line}`);
      }
      return false;
    }
  }
  console.error(
    `${name} is still going after ${Math.round((attempts * every) / 60_000)} minutes; check Railway.`,
  );
  return false;
}

async function deploy(env, which) {
  const roles = which ? [checkRole(which)] : Object.keys(ROLES);
  let ok = true;
  for (const role of roles) ok = (await deployRole(env, role)) && ok;
  if (ok && roles.includes('media')) {
    console.log('');
    ok = await health(env, { reconciler: false });
  }
  if (!ok) process.exitCode = 1;
  else console.log(`\nDeployed. Next: node scripts/media.mjs status ${env}`);
}

export async function status(env) {
  checkEnv(env);
  const key = env.toUpperCase();
  for (const role of Object.keys(ROLES)) {
    const name = serviceName(role, env);
    const ids = await railway.target({ service: name, create: false });
    if (!ids) {
      console.log(
        `\n${name}  not created yet: node scripts/media.mjs setup ${env}`,
      );
      continue;
    }
    const [info, found, vars] = await Promise.all([
      railway.instance(ids),
      railway.latest(ids),
      railway.variables(ids),
    ]);
    const address = info.domains?.serviceDomains?.[0];
    console.log(`\n${name}  (${ids.serviceId.slice(0, 8)})`);
    console.log(
      `  config     ${info.railwayConfigFile ?? "none, so Railway would read the box's railway.json"}`,
    );
    console.log(
      `  deployed   ${found ? `${found.status.toLowerCase()}, ${found.createdAt}` : 'never'}`,
    );
    console.log(
      `  address    ${
        address
          ? `https://${address.domain} -> port ${address.targetPort ?? 'unset'}`
          : role === 'media'
            ? 'none yet'
            : 'none; it only calls the site'
      }`,
    );
    const names = Object.keys(vars)
      .filter((n) => !n.startsWith('RAILWAY_'))
      .sort();
    console.log(`  variables  ${names.join(', ') || 'none'}`);
    const [variable, saved] =
      role === 'media'
        ? ['SPONSOR_MEDIA_TOKEN', `SPONSOR_MEDIA_TOKEN_${key}`]
        : ['SPONSOR_RECONCILE_TOKEN', `SPONSOR_RECONCILE_TOKEN_${key}`];
    const mine = await devVar(saved);
    console.log(
      `  token      ${
        !vars[variable]
          ? 'not set'
          : vars[variable] === mine
            ? `matches ${saved} in ${VARS}`
            : `differs from ${saved} in ${VARS}: run setup again`
      }`,
    );
  }
  await nextSteps(env);
}

/** The media service's own readiness report, and the reconciler's last few passes. */
export async function health(env, { reconciler = true } = {}) {
  checkEnv(env);
  const key = env.toUpperCase();
  let url = await devVar(`SPONSOR_MEDIA_URL_${key}`);
  if (!url) {
    const ids = await railway.target({
      service: serviceName('media', env),
      create: false,
    });
    const address =
      ids && (await railway.instance(ids)).domains?.serviceDomains?.[0];
    if (!address)
      throw Error(
        `The ${env} media service has no address yet. Run: node scripts/media.mjs setup ${env}`,
      );
    url = `https://${address.domain}`;
  }
  const response = await fetch(new URL('/health', url), {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  }).catch((e) => e);
  if (response instanceof Error) {
    console.error(`${url}/health did not answer: ${response.message}`);
    return false;
  }
  const report = await response.json().catch(() => null);
  console.log(`${url}/health answered ${response.status}:`);
  console.log(JSON.stringify(report, null, 2));
  const ready = response.ok && report?.ready === true;
  if (!ready)
    console.error(
      '\nNot ready: the site will keep the cap off sale. Check its token and runtime with status.',
    );
  else if (report.capQualified !== true)
    console.error(
      '\nUp, but no cap has passed qualification, so the cap stays off sale.',
    );
  else console.log('\nReady to sell caps.');

  if (reconciler) {
    const ids = await railway.target({
      service: serviceName('reconcile', env),
      create: false,
    });
    const found = ids && (await railway.latest(ids));
    if (!found) console.log(`\nThe ${env} reconciler has never been deployed.`);
    else {
      console.log(
        `\nThe ${env} reconciler's latest deployment: ${found.status.toLowerCase()}. Its last passes:`,
      );
      const lines = (await railway.logs(found.id, 'run', 20)).slice(-5);
      for (const line of lines) console.log(`  ${line}`);
      if (lines.some((line) => /returned 401/.test(line)))
        console.log(
          `  The site refuses its token: give the worker SPONSOR_RECONCILE_TOKEN_${key}.`,
        );
    }
  }
  return ready;
}

const commands = { setup, deploy, status, health };
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [command, env, ...rest] = process.argv.slice(2);
  const run = commands[command];
  if (!run || !Object.hasOwn(SITES, env ?? '')) {
    console.error(
      `Usage: node scripts/media.mjs <${Object.keys(commands).join('|')}> <devnet|production>`,
    );
    process.exit(1);
  }
  try {
    const result = await run(env, ...rest);
    if (result === false) process.exitCode = 1;
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
