#!/usr/bin/env node
// Authenticated CPU worker. The public Worker owns orders and persists these media results in R2.
import http from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const run = promisify(execFile),
  MAX_UPLOAD = 4 * 1024 * 1024,
  MAX_VIDEO = 40 * 1024 * 1024;
const templates = { host: 'pepe-cap-v1', guest: 'gigachad-cap-v1' };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const reply = (value, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
let active = 0;
class MediaError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
async function bytesLimited(response, max) {
  const size = Number(response.headers.get('content-length') || 0);
  if (size > max) throw new MediaError(413, 'Media is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new MediaError(400, 'Media is empty.');
  const parts = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > max) throw new MediaError(413, 'Media is too large.');
      parts.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts, length);
}
function authorized(request, token) {
  const expected = Buffer.from(`Bearer ${token || ''}`),
    actual = Buffer.from(request.headers.get('authorization') || '');
  return (
    !!token &&
    token.length >= 24 &&
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}
function checkedUrl(raw, kind, config) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new MediaError(400, 'Invalid media URL.');
  }
  if (url.username || url.password || url.hash)
    throw new MediaError(400, 'Invalid media URL.');
  const fal =
    url.protocol === 'https:' &&
    (url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media'));
  const own =
    config.siteOrigin &&
    url.origin === new URL(config.siteOrigin).origin &&
    url.pathname.startsWith('/api/sponsorship/assets/');
  if (kind === 'video' ? !fal : !own)
    throw new MediaError(400, 'Media host is not allowed.');
  return url;
}
async function download(url, path, max) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new MediaError(502, 'Media download failed.');
  await writeFile(path, await bytesLimited(response, max));
}
async function python(config, args, report) {
  try {
    await run(
      config.python || 'python3',
      ['scripts/wearable-render.py', ...args, '--report', report],
      {
        timeout: 90000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, OPENCV_IO_MAX_IMAGE_PIXELS: '16777216' },
      },
    );
  } catch {
    let result;
    try {
      result = JSON.parse(await readFile(report, 'utf8'));
    } catch {
      throw new MediaError(
        503,
        'The media worker could not process this file.',
      );
    }
    throw new MediaError(
      422,
      result.error || result.code || 'Artwork could not be verified.',
    );
  }
  return JSON.parse(await readFile(report, 'utf8'));
}
// A boolean in a template cannot enable sales. The qualification binds the exact
// renderer, placement geometry, artwork and masks that passed the real-footage trial.
export async function qualifiedTemplates(config = {}) {
  const states = await Promise.all(
    Object.values(templates).map(async (id) => {
      const bytes = await readFile(`public/wearables/${id}.json`),
        manifest = JSON.parse(bytes);
      return {
        id,
        qualified: false,
        sha256: manifest.blankCapImage.sha256,
        manifest,
        manifestHash: hash(bytes),
      };
    }),
  );
  try {
    const proof = JSON.parse(
      await readFile(
        config.qualificationPath ||
          'public/wearables/caps-v1-qualification.json',
        'utf8',
      ),
    );
    if (
      proof.version !== 'caps-v1' ||
      !proof.accepted ||
      !proof.visualReviewed ||
      !proof.negativeTestsPassed ||
      !proof.realOcclusionRejected
    )
      throw Error('Missing trial evidence');
    for (const path of [
      'scripts/wearable-render.py',
      'scripts/wearable_panel.py',
    ])
      if (hash(await readFile(path)) !== proof.code?.[path])
        throw Error('Renderer changed');
    for (const state of states) {
      const m = state.manifest,
        p = proof.templates?.[state.id],
        host = m.host === 'host' ? 'pepe' : 'gigachad';
      if (
        !m.qualified ||
        m.qualificationVersion !== proof.version ||
        state.manifestHash !== p?.manifestSha256
      )
        continue;
      if (
        hash(await readFile(m.blankCapImage.path)) !== p.image ||
        p.image !== state.sha256
      )
        continue;
      if (
        hash(await readFile(m.foregroundMask)) !== p.foregroundMask ||
        hash(await readFile(m.logoMask)) !== p.logoMask
      )
        continue;
      const trials =
        proof.trials?.filter(
          (t) => t.host === host && t.audioVerified && t.frames >= 200,
        ) || [];
      if (
        !['graphic', 'text'].every(
          (mark) =>
            trials.filter((t) => t.mark === mark).length >= 3 &&
            trials.some((t) => t.mark === mark && t.heldOut),
        )
      )
        continue;
      state.qualified = true;
    }
  } catch {
    /* Missing or changed proof closes inventory while previews remain available. */
  }
  return states.map(({ id, qualified, sha256 }) => ({ id, qualified, sha256 }));
}
let runtimeCheck;
async function runtimeReady(config) {
  if (
    !runtimeCheck ||
    runtimeCheck.python !== config.python ||
    Date.now() - runtimeCheck.at > 30000
  ) {
    const ready = Promise.all([
      run(config.python || 'python3', ['-c', 'import cv2, numpy'], {
        timeout: 5000,
      }),
      run('ffmpeg', ['-version'], { timeout: 5000 }),
      run('ffprobe', ['-version'], { timeout: 5000 }),
    ]).then(
      () => true,
      () => false,
    );
    runtimeCheck = { python: config.python, at: Date.now(), ready };
  }
  return runtimeCheck.ready;
}
export async function handleMediaRequest(request, config) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    const [states, runtime] = await Promise.all([
      qualifiedTemplates(config),
      runtimeReady(config),
    ]);
    const ready = !!config.token && config.token.length >= 24 && runtime;
    return reply({
      ready,
      templateVersion: 'caps-v1',
      capQualified: ready && states.every((t) => t.qualified),
      templates: states,
    });
  }
  if (!authorized(request, config.token))
    return reply({ error: 'Media authorization required.' }, 401);
  if (
    request.method !== 'POST' ||
    !['/preview', '/render'].includes(url.pathname)
  )
    return reply({ error: 'Unknown operation.' }, 404);
  if (active >= 2)
    return reply(
      { error: 'The wardrobe desk is busy. Try again shortly.' },
      503,
    );
  active++;
  let dir;
  try {
    await mkdir(config.workdir || 'work/sponsor-media', { recursive: true });
    dir = await mkdtemp(`${config.workdir || 'work/sponsor-media'}/job-`);
    const output = `${dir}/output.png`,
      normalized = `${dir}/logo.png`,
      report = `${dir}/report.json`;
    if (url.pathname === '/preview') {
      const target = url.searchParams.get('target') || 'host',
        kind = url.searchParams.get('kind') || 'logo';
      if (!templates[target] || !['cap', 'logo'].includes(kind))
        throw new MediaError(400, 'Choose a supported placement.');
      const input = `${dir}/upload`;
      await writeFile(input, await bytesLimited(request, MAX_UPLOAD));
      await python(
        config,
        ['normalize', '--asset', input, '--output', normalized],
        report,
      );
      let template = null;
      if (kind === 'cap') {
        template = JSON.parse(
          await readFile(`public/wearables/${templates[target]}.json`, 'utf8'),
        );
        await python(
          config,
          [
            'preview',
            '--manifest',
            `public/wearables/${templates[target]}.json`,
            '--asset',
            normalized,
            '--output',
            output,
          ],
          report,
        );
      }
      const logo = await readFile(normalized),
        preview = kind === 'cap' ? await readFile(output) : logo;
      const qualified =
        template &&
        (await qualifiedTemplates(config)).find((t) => t.id === template.id)
          ?.qualified;
      return reply({
        preview: preview.toString('base64'),
        logo: logo.toString('base64'),
        sha256: hash(preview),
        logoSha256: hash(logo),
        templateId: template?.id ?? null,
        templateVersion: template ? 'caps-v1' : null,
        qualificationVersion: qualified ? 'caps-v1' : null,
        target,
        kind,
      });
    }
    const payload = JSON.parse((await bytesLimited(request, 12000)).toString());
    const videoUrl = checkedUrl(payload.videoUrl, 'video', config),
      logoUrl = checkedUrl(payload.logoUrl, 'logo', config);
    if (!templates[payload.target] || payload.templateVersion !== 'caps-v1')
      throw new MediaError(400, 'Unsupported wardrobe template.');
    const manifest = `public/wearables/${templates[payload.target]}.json`;
    if (
      !(await qualifiedTemplates(config)).find(
        (t) => t.id === templates[payload.target],
      )?.qualified
    )
      throw new MediaError(
        409,
        'This cap has not passed broadcast qualification.',
      );
    const video = `${dir}/input.mp4`,
      out = `${dir}/branded.mp4`;
    await Promise.all([
      download(videoUrl, video, MAX_VIDEO),
      download(logoUrl, normalized, MAX_UPLOAD),
    ]);
    if (
      typeof payload.logoSha256 !== 'string' ||
      hash(await readFile(normalized)) !== payload.logoSha256
    )
      throw new MediaError(409, 'Artwork hash changed.');
    const quality = await python(
      config,
      [
        'render',
        '--manifest',
        manifest,
        '--asset',
        normalized,
        '--video',
        video,
        '--output',
        out,
      ],
      report,
    );
    if (!quality.accepted || !quality.audioVerified)
      throw new MediaError(422, 'The wardrobe take could not be verified.');
    const summary = { ...quality };
    delete summary.tracking;
    const body = await readFile(out);
    return new Response(body, {
      headers: {
        'content-type': 'video/mp4',
        'x-sponsor-quality': Buffer.from(JSON.stringify(summary)).toString(
          'base64',
        ),
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    return reply(
      {
        error:
          e instanceof MediaError
            ? e.message
            : 'The wardrobe take could not be prepared.',
      },
      e instanceof MediaError ? e.status : 500,
    );
  } finally {
    active--;
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const config = {
    token: process.env.SPONSOR_MEDIA_TOKEN,
    python: process.env.WEARABLE_PYTHON || 'python3',
    workdir: process.env.SPONSOR_MEDIA_WORKDIR || 'work/sponsor-media',
    siteOrigin: process.env.SPONSOR_SITE_ORIGIN,
  };
  const server = http.createServer(async (req, res) => {
    try {
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: req.headers,
        ...(['GET', 'HEAD'].includes(req.method)
          ? {}
          : { body: req, duplex: 'half' }),
      });
      const response = await handleMediaRequest(request, config);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body)
        for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"Media service unavailable."}');
    }
  });
  server.requestTimeout = 120000;
  server.listen(
    Number(process.env.SPONSOR_MEDIA_PORT) || 4017,
    process.env.SPONSOR_MEDIA_HOST || '127.0.0.1',
    () => console.log('Sponsorship media worker ready.'),
  );
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
