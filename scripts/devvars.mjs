// Reading and writing `.dev.vars`, the operator's own file. Shared by the broadcast scripts so
// they agree on where credentials live and never disturb the rest of the file when writing.
import { readFile, writeFile } from 'node:fs/promises';

export const VARS = '.dev.vars';

/** One variable: the environment wins, so a one-off override needs no file edit. */
export async function devVar(name) {
  if (process.env[name]) return process.env[name].trim();
  const file = await readFile(VARS, 'utf8').catch(() => '');
  const found = new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\r\n]+)"?`, 'm').exec(file);
  return found ? found[1].trim() : '';
}

/** Several at once, skipping the ones that are not set. */
export async function devVars(names) {
  const entries = await Promise.all(names.map(async (name) => [name, await devVar(name)]));
  return Object.fromEntries(entries.filter(([, value]) => value));
}

/** Append or replace keys without disturbing the rest of the file. */
export async function remember(pairs) {
  let file = await readFile(VARS, 'utf8').catch(() => '');
  for (const [key, value] of Object.entries(pairs)) {
    const line = `${key}=${value}`;
    const existing = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
    file = existing.test(file) ? file.replace(existing, line) : `${file.replace(/\s*$/, '')}\n${line}`;
  }
  await writeFile(VARS, `${file.replace(/\s*$/, '')}\n`);
}
