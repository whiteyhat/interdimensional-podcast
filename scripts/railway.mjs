// Railway's API, spoken directly. The CLI validates its token by asking who you are, which a
// workspace token cannot answer, so the box is set up and deployed over GraphQL instead. The
// same token works for both; this file is the only place that knows the difference.
//
// One Railway project holds several services: the broadcast box, and the sponsorship media and
// reconciliation services for each site. The box keeps the ids it has always kept in .dev.vars
// (RAILWAY_SERVICE_ID and friends), and scripts/air.mjs reaches it exactly as before. Every
// other service is found by its name, every time, and only ever remembered under a key of its
// own. An id that means "the box" is never handed to anything else: a media service that
// inherited the box's id would replace the live show's variables and rebuild it as something
// else.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { gzipSync } from 'node:zlib';
import { devVar, remember } from './devvars.mjs';

const API = 'https://backboard.railway.com/graphql/v2';
const UPLOAD = 'https://backboard.railway.com/project';
const PROJECT = 'interdimensional-podcast';
export const BOX = 'broadcast-box';

export async function token() {
  const value = await devVar('RAILWAY_TOKEN');
  if (!value)
    throw Error(
      'Set RAILWAY_TOKEN in .dev.vars: a workspace token from railway.com/account/tokens.',
    );
  return value;
}

export async function gql(query, variables = {}) {
  const response = await fetch(API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await token()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await response.json().catch(() => ({}));
  if (data.errors?.length)
    throw Error(`Railway refused: ${data.errors[0].message}`);
  if (!response.ok) throw Error(`Railway answered ${response.status}`);
  return data.data;
}

/** Where a named service's id is remembered: `sponsor-media-devnet` → `RAILWAY_SERVICE_ID_SPONSOR_MEDIA_DEVNET`. */
export function serviceKey(name) {
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) throw Error(`"${name}" is not a usable service name.`);
  return `RAILWAY_SERVICE_ID_${slug}`;
}

const isBox = (ids) => !ids.service || ids.service === BOX;

// An existing project of this name is adopted rather than duplicated: two boxes would both
// generate the show, and the second one would be paying for it twice.
async function findProject(name, create) {
  const { projects } = await gql(
    `query { projects { edges { node { id name environments { edges { node { id name } } }
       services { edges { node { id name } } } } } } }`,
  );
  const found = projects.edges.map((e) => e.node).find((p) => p.name === name);
  if (found) return found;
  if (!create) return null;
  const created = await gql(
    `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) {
       id name environments { edges { node { id name } } } } }`,
    {
      input: {
        name,
        description: 'Hosted broadcast box for Pepe & Chad Live',
      },
    },
  );
  return { ...created.projectCreate, services: { edges: [] } };
}

async function createService(projectId, environmentId, name) {
  const created = await gql(
    `mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
    { input: { projectId, environmentId, name } },
  );
  return created.serviceCreate.id;
}

/** The box: the ids saved in .dev.vars, or found (or created) once and then saved there. */
async function boxTarget(project) {
  const saved = {
    projectId: await devVar('RAILWAY_PROJECT_ID'),
    environmentId: await devVar('RAILWAY_ENVIRONMENT_ID'),
    serviceId: await devVar('RAILWAY_SERVICE_ID'),
  };
  if (saved.projectId && saved.environmentId && saved.serviceId)
    return { ...saved, service: BOX };

  const found = await findProject(project, true);
  const environmentId = found.environments.edges[0].node.id;
  const existing = found.services.edges
    .map((e) => e.node)
    .find((s) => s.name === BOX);
  const serviceId =
    existing?.id ?? (await createService(found.id, environmentId, BOX));
  const ids = { projectId: found.id, environmentId, serviceId };
  await remember({
    RAILWAY_PROJECT_ID: ids.projectId,
    RAILWAY_ENVIRONMENT_ID: ids.environmentId,
    RAILWAY_SERVICE_ID: ids.serviceId,
  });
  return { ...ids, service: BOX };
}

/**
 * Any other service, looked up by name in the project on every call. A saved id is a record of
 * what the lookup found, never a substitute for it, so a service that was deleted and made
 * again is still found. Returns null when the service does not exist and `create` is false.
 */
async function namedTarget(project, service, create) {
  let projectId = await devVar('RAILWAY_PROJECT_ID');
  let environmentId = await devVar('RAILWAY_ENVIRONMENT_ID');
  let services;
  if (projectId && environmentId) {
    const data = await gql(
      `query($id: String!) { project(id: $id) { services { edges { node { id name } } } } }`,
      { id: projectId },
    );
    services = data.project.services.edges.map((e) => e.node);
  } else {
    const found = await findProject(project, create);
    if (!found) return null;
    projectId = found.id;
    environmentId = found.environments.edges[0].node.id;
    services = found.services.edges.map((e) => e.node);
  }
  let serviceId = services.find((s) => s.name === service)?.id;
  if (!serviceId) {
    if (!create) return null;
    serviceId = await createService(projectId, environmentId, service);
  }
  // Belt and braces for the one mistake that would take the show off air: whatever the name
  // lookup says, the box's own id is never returned for another service.
  const box = await devVar('RAILWAY_SERVICE_ID');
  if (box && serviceId === box)
    throw Error(
      `Railway's "${service}" has the broadcast box's service id. Refusing to touch it.`,
    );
  const key = serviceKey(service);
  if ((await devVar(key)) !== serviceId) await remember({ [key]: serviceId });
  return { projectId, environmentId, serviceId, service };
}

/**
 * The project, environment and service ids for one service. With no service named, that is the
 * broadcast box, exactly as scripts/air.mjs has always used it. Any other service is found by
 * name, created when missing unless `create` is false, and remembered as
 * RAILWAY_SERVICE_ID_<NAME>.
 */
export async function target({
  project = PROJECT,
  service = BOX,
  create = true,
} = {}) {
  if (service === BOX) return boxTarget(project);
  return namedTarget(project, service, create);
}

/**
 * Replace the box's variables outright, so a removed setting actually goes away. Only the box
 * works this way: its settings come whole from this machine's .dev.vars on every setup.
 */
export async function setVariables(ids, variables) {
  if (!isBox(ids))
    throw Error(
      `Only the broadcast box has its variables replaced wholesale. Use upsertVariables for ${ids.service}.`,
    );
  await gql(
    `mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
    {
      input: {
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        serviceId: ids.serviceId,
        variables,
        replace: true,
        skipDeploys: true,
      },
    },
  );
}

/**
 * Add or change the given variables on one service and leave every other variable alone. A
 * setting someone added by hand in Railway's dashboard survives a setup run.
 */
export async function upsertVariables(ids, variables) {
  const values = Object.fromEntries(
    Object.entries(variables).map(([name, value]) => {
      if (value === undefined || value === null || value === '')
        throw Error(`${name} has no value to send to ${ids.service}.`);
      return [name, String(value)];
    }),
  );
  await gql(
    `mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
    {
      input: {
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        serviceId: ids.serviceId,
        variables: values,
        skipDeploys: true,
      },
    },
  );
}

/** The variables a service has now, rendered. Callers print names, never values. */
export async function variables(ids) {
  const data = await gql(
    `query($projectId: String!, $environmentId: String!, $serviceId: String) {
       variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) }`,
    {
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      serviceId: ids.serviceId,
    },
  );
  return data.variables ?? {};
}

/**
 * Railway looks for a config file at an absolute path inside the uploaded source, and a
 * relative one does not follow the service's root directory, so the path is always sent from
 * the root with a leading slash.
 */
function configFilePath(path) {
  const raw = String(path);
  // Checked before normalizing: posix.normalize('/../railway.json') is '/railway.json', which
  // is the box's config, not a refusal.
  if (raw.split(/[\\/]/).includes('..') || !/\.(json|toml)$/.test(raw))
    throw Error(`${path} is not a Railway config file inside the repository.`);
  return posix.normalize(`/${raw.replace(/^\/+/, '')}`);
}

/**
 * Change a service's settings. `railwayConfigFile` points the service at its own
 * config-as-code file, so the repository's railway.json (which describes the box) is never
 * read for it. `drainingSeconds` is how long a replaced deployment keeps running after
 * SIGTERM, which is what lets an in-flight render finish across a redeploy.
 */
export async function configure(ids, input) {
  const settings = { ...input };
  if (settings.railwayConfigFile !== undefined)
    settings.railwayConfigFile = configFilePath(settings.railwayConfigFile);
  if (
    settings.drainingSeconds !== undefined &&
    !(
      Number.isInteger(settings.drainingSeconds) &&
      settings.drainingSeconds >= 0
    )
  )
    throw Error('drainingSeconds is a whole number of seconds.');
  await gql(
    `mutation($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
       serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`,
    {
      serviceId: ids.serviceId,
      environmentId: ids.environmentId,
      input: settings,
    },
  );
}

/**
 * The service's public address, created once, pointing at `targetPort`. The box's supervisor
 * listens on 8080, so the box may leave the port out; any other service must say which port it
 * listens on, because an address aimed at the wrong port answers every request with a 502.
 */
export async function domain(ids, targetPort) {
  if (targetPort === undefined) {
    if (!isBox(ids)) throw Error(`Say which port ${ids.service} listens on.`);
    targetPort = 8080;
  }
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535)
    throw Error(`${targetPort} is not a port.`);
  const existing = await gql(
    `query($projectId: String!, $serviceId: String!, $environmentId: String!) {
       domains(projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId) {
         serviceDomains { id domain targetPort } } }`,
    {
      projectId: ids.projectId,
      serviceId: ids.serviceId,
      environmentId: ids.environmentId,
    },
  );
  const already = existing.domains.serviceDomains[0];
  if (already) {
    // An address made by hand in the dashboard may aim wherever Railway guessed. The box's has
    // always been left alone; a new service's is corrected to the port it actually listens on.
    if (!isBox(ids) && already.targetPort !== targetPort)
      await gql(
        `mutation($input: ServiceDomainUpdateInput!) { serviceDomainUpdate(input: $input) }`,
        {
          input: {
            domain: already.domain,
            serviceDomainId: already.id,
            serviceId: ids.serviceId,
            environmentId: ids.environmentId,
            targetPort,
          },
        },
      );
    return `https://${already.domain}`;
  }
  const created = await gql(
    `mutation($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
    {
      input: {
        serviceId: ids.serviceId,
        environmentId: ids.environmentId,
        targetPort,
      },
    },
  );
  return `https://${created.serviceDomainCreate.domain}`;
}

/**
 * The source Railway builds from. Secrets and build output are left out of the archive itself
 * rather than trusted to .dockerignore: this tarball leaves the machine.
 */
const NEVER_UPLOAD = [
  './node_modules',
  './.git',
  './dist',
  './.wrangler',
  './work',
  './outputs',
  './.dev.vars',
  './.dev.vars.local',
  './.env',
  './.env.production',
  './.env.local',
  './.devnet-keys.json',
  './.playwright-mcp',
  './tsconfig.tsbuildinfo',
];
// The same list, as a test for one relative path in a named upload. Broader than the box's
// excludes on purpose: every .dev.vars* and .env* variant, at any depth.
const FORBIDDEN =
  /(^|\/)(node_modules|\.git|dist|\.wrangler|work|outputs|\.playwright-mcp)(\/|$)|(^|\/)(\.dev\.vars|\.env)[^/]*$|(^|\/)(\.devnet-keys\.json|tsconfig\.tsbuildinfo)$/;

async function archive(path) {
  const args = [
    '-czf',
    path,
    ...NEVER_UPLOAD.flatMap((e) => ['--exclude', e]),
    '.',
  ];
  const tar = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  tar.stderr.on('data', (c) => (err += c));
  const [code] = await once(tar, 'exit');
  if (code !== 0) throw Error(`tar failed: ${err.trim().slice(0, 300)}`);
}

const octal = (value, width) =>
  `${Math.floor(value).toString(8).padStart(width, '0')}\0`;

/** One ustar header. Paths longer than 100 bytes spill into the 155-byte prefix field. */
function tarHeader(path, size, mode, mtime) {
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const split = [...path.matchAll(/\//g)]
      .map((m) => m.index)
      .find(
        (i) =>
          Buffer.byteLength(path.slice(0, i)) <= 155 &&
          Buffer.byteLength(path.slice(i + 1)) <= 100,
      );
    if (split === undefined)
      throw Error(`${path} is too long a path to archive.`);
    prefix = path.slice(0, split);
    name = path.slice(split + 1);
  }
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(mode, 7), 100);
  block.write(octal(0, 7), 108);
  block.write(octal(0, 7), 116);
  block.write(octal(size, 11), 124);
  block.write(octal(mtime, 11), 136);
  block.fill(' ', 148, 156);
  block.write('0', 156);
  block.write('ustar\0', 257);
  block.write('00', 263);
  block.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

/**
 * A gzipped tarball of exactly these files, read from `root`. Built in memory by hand rather
 * than by the system tar, so macOS cannot slip its ._ metadata files in beside the real ones:
 * the archive holds the named files and nothing else, on every machine.
 */
export async function pack(root, files) {
  if (!files.length) throw Error('There are no files to upload.');
  const seen = new Set();
  const parts = [];
  for (const file of files) {
    const path = posix.normalize(file);
    if (path.startsWith('/') || path === '.' || path.split('/').includes('..'))
      throw Error(`${file} is not a path inside the repository.`);
    if (FORBIDDEN.test(path))
      throw Error(`${file} must never leave this machine.`);
    if (seen.has(path)) continue;
    seen.add(path);
    const full = join(root, path);
    const info = await stat(full);
    if (!info.isFile()) throw Error(`${file} is not a file.`);
    const bytes = await readFile(full);
    parts.push(
      tarHeader(path, bytes.length, info.mode & 0o777, info.mtimeMs / 1000),
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

/**
 * Upload the source and start a build. Returns the deployment id. The box uploads the whole
 * repository, as it always has. Any other service must name the files its image needs:
 * uploading the repository would carry the root railway.json, which describes the box, and
 * Railway would build and health-check the box's image under the other service's name.
 */
export async function deploy(
  ids,
  { files, root = '.', tarPath = '/tmp/air-source.tar.gz' } = {},
) {
  let body;
  if (files) {
    body = await pack(root, files);
  } else {
    if (!isBox(ids))
      throw Error(
        `Only the broadcast box uploads the whole repository. Name the files ${ids.service} needs.`,
      );
    await archive(tarPath);
    body = await readFile(tarPath);
  }
  const response = await fetch(
    `${UPLOAD}/${ids.projectId}/environment/${ids.environmentId}/up?serviceId=${ids.serviceId}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await token()}`,
        'Content-Type': 'multipart/form-data',
      },
      body,
      signal: AbortSignal.timeout(300_000),
    },
  );
  const text = await response.text();
  if (!files) await rm(tarPath, { force: true });
  if (!response.ok)
    throw Error(
      `Railway refused the upload (${response.status}): ${text.slice(0, 300)}`,
    );
  const data = JSON.parse(text);
  return {
    id: data.deploymentId,
    url: data.url,
    megabytes: (body.length / 1e6).toFixed(1),
  };
}

export async function deployment(id) {
  const { deployment: d } = await gql(
    `query($id: String!) { deployment(id: $id) { id status createdAt canRedeploy } }`,
    { id },
  );
  return d;
}

/** The most recent deployment for the service, whatever started it. */
export async function latest(ids) {
  const { deployments } = await gql(
    `query($serviceId: String!, $environmentId: String!) {
       deployments(first: 1, input: { serviceId: $serviceId, environmentId: $environmentId }) {
         edges { node { id status createdAt } } } }`,
    { serviceId: ids.serviceId, environmentId: ids.environmentId },
  );
  return deployments.edges[0]?.node ?? null;
}

/** What Railway has configured for one service: its config file, healthcheck and address. */
export async function instance(ids) {
  const { serviceInstance } = await gql(
    `query($serviceId: String!, $environmentId: String!) {
       serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
         railwayConfigFile dockerfilePath healthcheckPath drainingSeconds numReplicas
         domains { serviceDomains { domain targetPort } } } }`,
    { serviceId: ids.serviceId, environmentId: ids.environmentId },
  );
  return serviceInstance;
}

export async function logs(id, kind = 'build', limit = 60) {
  const field = kind === 'build' ? 'buildLogs' : 'deploymentLogs';
  const data = await gql(
    `query($id: String!, $limit: Int) { ${field}(deploymentId: $id, limit: $limit) { message severity } }`,
    { id, limit },
  );
  return (data[field] ?? []).map((l) => l.message.replace(/\s+$/, ''));
}
