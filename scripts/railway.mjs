// Railway's API, spoken directly. The CLI validates its token by asking who you are, which a
// workspace token cannot answer, so the box is set up and deployed over GraphQL instead. The
// same token works for both; this file is the only place that knows the difference.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { devVar, remember } from './devvars.mjs';

const API = 'https://backboard.railway.com/graphql/v2';
const UPLOAD = 'https://backboard.railway.com/project';

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
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await response.json().catch(() => ({}));
  if (data.errors?.length) throw Error(`Railway refused: ${data.errors[0].message}`);
  if (!response.ok) throw Error(`Railway answered ${response.status}`);
  return data.data;
}

/** The project, service and environment ids, created on first use and then remembered. */
export async function target({ project = 'interdimensional-podcast', service = 'broadcast-box' } = {}) {
  const saved = {
    projectId: await devVar('RAILWAY_PROJECT_ID'),
    environmentId: await devVar('RAILWAY_ENVIRONMENT_ID'),
    serviceId: await devVar('RAILWAY_SERVICE_ID'),
  };
  if (saved.projectId && saved.environmentId && saved.serviceId) return saved;

  // An existing project of this name is adopted rather than duplicated: two boxes would both
  // generate the show, and the second one would be paying for it twice.
  const { projects } = await gql(
    `query { projects { edges { node { id name environments { edges { node { id name } } }
       services { edges { node { id name } } } } } } }`,
  );
  let found = projects.edges.map((e) => e.node).find((p) => p.name === project);
  if (!found) {
    const created = await gql(
      `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) {
         id name environments { edges { node { id name } } } } }`,
      { input: { name: project, description: 'Hosted broadcast box for Pepe & Chad Live' } },
    );
    found = { ...created.projectCreate, services: { edges: [] } };
  }
  const environmentId = found.environments.edges[0].node.id;
  const existing = found.services.edges.map((e) => e.node).find((s) => s.name === service);
  const serviceId =
    existing?.id ??
    (
      await gql(
        `mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
        { input: { projectId: found.id, environmentId, name: service } },
      )
    ).serviceCreate.id;
  const ids = { projectId: found.id, environmentId, serviceId };
  await remember({
    RAILWAY_PROJECT_ID: ids.projectId,
    RAILWAY_ENVIRONMENT_ID: ids.environmentId,
    RAILWAY_SERVICE_ID: ids.serviceId,
  });
  return ids;
}

/** Replace the service's variables outright, so a removed setting actually goes away. */
export async function setVariables(ids, variables) {
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

export async function configure(ids, input) {
  await gql(
    `mutation($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
       serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`,
    { serviceId: ids.serviceId, environmentId: ids.environmentId, input },
  );
}

/** The box's public address, created once. */
export async function domain(ids, targetPort = 8080) {
  const existing = await gql(
    `query($projectId: String!, $serviceId: String!, $environmentId: String!) {
       domains(projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId) {
         serviceDomains { domain } } }`,
    { projectId: ids.projectId, serviceId: ids.serviceId, environmentId: ids.environmentId },
  );
  const already = existing.domains.serviceDomains[0]?.domain;
  if (already) return `https://${already}`;
  const created = await gql(
    `mutation($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
    { input: { serviceId: ids.serviceId, environmentId: ids.environmentId, targetPort } },
  );
  return `https://${created.serviceDomainCreate.domain}`;
}

/**
 * The source Railway builds from. Secrets and build output are left out of the archive itself
 * rather than trusted to .dockerignore: this tarball leaves the machine.
 */
const NEVER_UPLOAD = [
  './node_modules', './.git', './dist', './.wrangler', './work', './outputs',
  './.dev.vars', './.dev.vars.local', './.env', './.env.production', './.env.local',
  './.devnet-keys.json', './.playwright-mcp', './tsconfig.tsbuildinfo',
];
async function archive(path) {
  const args = ['-czf', path, ...NEVER_UPLOAD.flatMap((e) => ['--exclude', e]), '.'];
  const tar = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  tar.stderr.on('data', (c) => (err += c));
  const [code] = await once(tar, 'exit');
  if (code !== 0) throw Error(`tar failed: ${err.trim().slice(0, 300)}`);
}

/** Upload the source and start a build. Returns the deployment id. */
export async function deploy(ids, tarPath = '/tmp/air-source.tar.gz') {
  await archive(tarPath);
  const body = await readFile(tarPath);
  const response = await fetch(
    `${UPLOAD}/${ids.projectId}/environment/${ids.environmentId}/up?serviceId=${ids.serviceId}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'multipart/form-data' },
      body,
      signal: AbortSignal.timeout(300_000),
    },
  );
  const text = await response.text();
  await rm(tarPath, { force: true });
  if (!response.ok) throw Error(`Railway refused the upload (${response.status}): ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  return { id: data.deploymentId, url: data.url, megabytes: (body.length / 1e6).toFixed(1) };
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

export async function logs(id, kind = 'build', limit = 60) {
  const field = kind === 'build' ? 'buildLogs' : 'deploymentLogs';
  const data = await gql(
    `query($id: String!, $limit: Int) { ${field}(deploymentId: $id, limit: $limit) { message severity } }`,
    { id, limit },
  );
  return (data[field] ?? []).map((l) => l.message.replace(/\s+$/, ''));
}
