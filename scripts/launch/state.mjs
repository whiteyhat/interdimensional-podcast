import { mkdir, open, readFile, rename, unlink, lstat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex');
export async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
export async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temp, file); }
  catch (error) { await unlink(temp).catch(() => {}); throw error; }
}
export async function withWorkspace(dir, fn) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await lstat(dir)).isSymbolicLink()) throw new Error('Launch workspace cannot be a symlink.');
  await chmod(dir, 0o700);
  const lockPath = path.join(dir, '.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Launch workspace is locked. If a process crashed, verify it has stopped before removing .lock.'); throw e; }
  await lock.writeFile(`${process.pid}\n`);
  const store = {
    dir,
    read: name => readJson(path.join(dir, name)),
    write: (name, value) => atomicJson(path.join(dir, name), value),
    async identity(config) {
      const configHash = digest(config);
      let state;
      try { state = await store.read('state.json'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (state) {
        if (state.configHash !== configHash) throw new Error('Launch configuration changed. Restore it; use a separate workspace for a distinct launch.');
        if ((await store.keypair()).publicKey.toBase58() !== state.mint) throw new Error('Stored mint identity does not match its keypair.');
        return state;
      }
      // Exclusive creation: a crash between key and state writes still recovers this same mint.
      const file = path.join(dir, 'mint-keypair.json');
      const keypair = Keypair.generate();
      let handle;
      try {
        handle = await open(file, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(Array.from(keypair.secretKey)));
        await handle.sync();
      } catch (e) { if (e.code !== 'EEXIST') throw e; }
      finally { await handle?.close(); }
      const mint = (await store.keypair()).publicKey.toBase58();
      state = { schemaVersion: 1, id: randomUUID(), configHash, mint, revision: 0, submissions: [], createdAt: new Date().toISOString() };
      await store.write('state.json', state);
      return state;
    },
    async keypair() {
      const file = path.join(dir, 'mint-keypair.json');
      const info = await lstat(file);
      if (info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Mint key file must be private (chmod 600) and not a symlink.');
      return Keypair.fromSecretKey(Uint8Array.from(await readJson(file)));
    },
  };
  try { return await fn(store); }
  finally { await lock.close(); await unlink(lockPath); }
}
