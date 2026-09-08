// Shared fal plumbing for the one-off asset scripts. No dependencies.
import { readFile, writeFile } from 'node:fs/promises';

export async function falKey() {
  if (process.env.FAL_KEY) return process.env.FAL_KEY;
  const vars = await readFile('.dev.vars', 'utf8').catch(() => '');
  const found = /^\s*FAL_KEY\s*=\s*"?([^"\r\n]+)"?/m.exec(vars);
  if (!found)
    throw Error('FAL_KEY is missing. Set it in the environment or .dev.vars.');
  return found[1].trim();
}

export async function fal(url, key, body) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw Error(
      `fal returned ${response.status}: ${JSON.stringify(data.detail || data.error || data).slice(0, 400)}`,
    );
  return data;
}

export async function waitFor(job, key) {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const state = await fal(job.status_url, key);
    if (state.status === 'COMPLETED') return fal(job.response_url, key);
    if (state.status === 'FAILED') throw Error('The image job failed.');
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw Error('The image job is taking too long.');
}

export async function download(url, path) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`Download failed with ${response.status}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
}

/** Submit to the queue and wait for the images. */
export async function generate(endpoint, key, input) {
  const job = await fal(`https://queue.fal.run/${endpoint}`, key, input);
  const result = await waitFor(job, key);
  const images = result.images || [];
  if (!images.length) throw Error(`No image returned from ${endpoint}.`);
  return { images, requestId: job.request_id };
}
