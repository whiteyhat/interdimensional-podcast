#!/usr/bin/env node
// Operator tooling. Only `submit` broadcasts, and only an unchanged wallet-signed artifact.
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { devVar } from './devvars.mjs';
import { validateConfig, DISCLOSURE } from '../lib/launch/config.mjs';
import { withWorkspace, readJson, atomicJson, digest } from './launch/state.mjs';
import { uploadMetadata } from './launch/metadata.mjs';

export const template = {
  schemaVersion: 1, network: 'mainnet-beta', name: 'Frogclench', symbol: 'FROGCLENCH',
  description: '', imagePath: 'public/logo.png', website: '', twitter: '', telegram: '', video: '',
  creator: '', treasury: '', buyLamports: '', maxTotalLamports: '', priorityMicroLamports: '0',
  cashback: false, mayhemMode: false, tokenizedAgent: false, frontRunningProtection: false,
  wallets: [{ address: '', label: 'Creator treasury', purpose: 'Declared project holdings', plannedTokens: '0', maySell: false }],
};
const help = `Usage: node scripts/launch.mjs <command> [options]

  init               Write an editable launch config; never overwrite an existing file
  check              Validate required configuration and local image availability
  upload             Pin image and metadata to IPFS (requires PINATA_JWT)
  prepare            Build and simulate one atomic create + disclosed creator purchase
  submit             Submit the current wallet-signed artifact (--signed <file>)
  status             Reconcile prior signatures and verify a finalized launch
  prepare-treasury   Prepare creation of the treasury token account, if absent
  report             Generate a dated public snapshot (--prelaunch before minting)
  export-config      Output verified COIN_MINT/TREASURY_WALLET configuration
  check-site         Verify public disclosures and the site's coin configuration

  --config <file>    Default: work/launch/config.json
  --workdir <dir>    Default: work/launch/session (private durable launch state)
  --signed <file>    Signed JSON downloaded from http://127.0.0.1:3212/studio/launch
  --out <file>       Report/config output; reports default to work/launch/report.json
  --prelaunch        Public report/site checks before the coin exists

The tool reads SOLANA_RPC_URL and PINATA_JWT from environment or .dev.vars.
No creator private key is accepted. Deployment is a separate explicit operation.
`;
async function fetchPublic(url, json = true) {
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' }); }
  catch { throw new Error('The configured public website or metadata is unreachable.'); }
  if (!response.ok) throw new Error(`Public launch resource returned HTTP ${response.status}.`);
  if (!json) { await response.body?.cancel(); return; }
  const data = await response.text();
  if (data.length > 1_000_000) throw new Error('Public launch document is too large.');
  try { return JSON.parse(data); } catch { throw new Error('Public launch resource is not valid JSON.'); }
}
export async function checkDisclosure(config, fetcher = fetchPublic) {
  const origin = new URL(config.website).origin;
  const [, report] = await Promise.all([fetcher(`${origin}/allocations`, false), fetcher(`${origin}/launch/report.json`)]);
  if (report?.schemaVersion !== 1 || report.disclosure !== DISCLOSURE || report.network !== config.network || report.name !== config.name || report.symbol !== config.symbol || !Array.isArray(report.wallets)) throw new Error('The public wallet register does not match this launch.');
  const declarations = report.wallets.map(w => ({ address: w.address, label: w.label, purpose: w.purpose, plannedTokens: w.plannedTokens, maySell: w.maySell }));
  if (digest(declarations) !== digest(config.wallets)) throw new Error('Publish the current project wallet declarations before launch.');
}
async function outputJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await atomicJson(file, value);
  console.log(`Wrote ${file}`);
}
export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    config: { type: 'string', default: 'work/launch/config.json' }, workdir: { type: 'string', default: 'work/launch/session' },
    signed: { type: 'string' }, out: { type: 'string' }, prelaunch: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } });
  const command = positionals[0];
  if (values.help || !command) { console.log(help); return; }
  if (positionals.length !== 1 || !['init', 'check', 'upload', 'prepare', 'submit', 'status', 'prepare-treasury', 'report', 'export-config', 'check-site'].includes(command)) throw new Error('Unknown command. Run with --help.');
  if (command === 'init') {
    await mkdir(path.dirname(values.config), { recursive: true, mode: 0o700 });
    await writeFile(values.config, `${JSON.stringify(template, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(`Created ${values.config}. Fill the blank fields and declare each project wallet before running check.`); return;
  }
  const config = validateConfig(await readJson(values.config));
  if (command === 'check') {
    if (!(await readFile(config.imagePath)).length) throw new Error('Image file is empty.');
    console.log(`Configuration valid: ${config.name} (${config.symbol}); ${config.wallets.length} declared wallet(s). No transaction prepared.`); return;
  }
  if (command === 'report' && values.prelaunch) {
    const { publicSnapshot } = await import('./launch/report.mjs');
    await outputJson(values.out ?? 'work/launch/report.json', publicSnapshot(config, { mint: null, decimals: null, totalSupplyBase: null, wallets: [] })); return;
  }
  if (command === 'check-site' && values.prelaunch) {
    await checkDisclosure(config); console.log('Public site and prelaunch wallet declarations match.'); return;
  }
  await withWorkspace(path.resolve(values.workdir), async store => {
    let state;
    if (['upload', 'prepare'].includes(command)) state = await store.identity(config);
    else { state = await store.read('state.json'); if (state.configHash !== digest(config)) throw new Error('Launch configuration changed; restore the configuration associated with this workspace.'); }
    if (command === 'upload') {
      const result = await uploadMetadata(config, store, await devVar('PINATA_JWT'));
      console.log(`Metadata ready: ${result.metadataUri}`); return;
    }
    const chain = await import('./launch/chain.mjs');
    const connection = chain.connectionFor(await devVar('SOLANA_RPC_URL'));
    await chain.assertNetwork(connection, config.network);
    const metadata = await store.read('metadata.json');
    state = await chain.reconcile(store, state, connection, () => chain.verifyMint(config, state, connection, metadata.metadataUri));
    if (command === 'submit') {
      if (!values.signed) throw new Error('submit requires --signed <wallet-signed JSON file>.');
      await checkDisclosure(config);
      const result = await chain.submitPrepared(store, state, await readJson(values.signed), connection);
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== 'finalized') console.log('Run status to reconcile this signature; do not create another launch.');
      return;
    }
    if (command === 'prepare' || command === 'prepare-treasury') {
      await checkDisclosure(config);
      const published = await fetchPublic(metadata.metadataUri);
      if (digest(published) !== metadata.metadataHash) throw new Error('Published metadata content differs from the saved upload.');
      const artifact = await chain.buildPrepared(config, state, await store.keypair(), metadata.metadataUri, connection, command === 'prepare' ? 'create' : 'treasury');
      await store.write(`prepared-${artifact.revision}.json`, artifact);
      state.revision = artifact.revision;
      await store.write('state.json', state);
      console.log(`Prepared ${path.join(store.dir, `prepared-${artifact.revision}.json`)}\nImport it at http://127.0.0.1:3212/studio/launch, review, and sign. Nothing has been submitted.`); return;
    }
    if (command === 'status') {
      console.log(JSON.stringify({ mint: state.mint, submissions: state.submissions }, null, 2));
      if (state.submissions.some(s => s.kind === 'create' && ['finalized', 'recovered'].includes(s.status))) {
        await chain.verifyMint(config, state, connection, metadata.metadataUri);
        console.log('Finalized mint, creator, coin mode, and metadata verified.');
      }
      return;
    }
    await chain.verifyMint(config, state, connection, metadata.metadataUri);
    if (command === 'report') {
      const { collectReport } = await import('./launch/report.mjs');
      const report = await collectReport(config, state, connection, metadata.metadataUri);
      await outputJson(values.out ?? 'work/launch/report.json', report);
      if (!report.complete) { console.log('Snapshot contains unavailable wallet data; review its errors before publication.'); process.exitCode = 2; }
    } else if (command === 'export-config') {
      const output = `COIN_MINT=${state.mint}\nTREASURY_WALLET=${config.treasury}\nCOIN_NAME=${config.name}\nCOIN_TICKER=${config.symbol}\n`;
      if (values.out) { await mkdir(path.dirname(values.out), { recursive: true }); await writeFile(values.out, output, { flag: 'wx', mode: 0o600 }); console.log(`Wrote ${values.out}`); }
      else console.log(output);
    } else if (command === 'check-site') {
      await checkDisclosure(config);
      const live = await fetchPublic(`${new URL(config.website).origin}/api/interact?action=config`);
      if (live.mint !== state.mint || live.treasury !== config.treasury || !live.launched || !live.treasuryReady) throw new Error('Site coin/treasury configuration is not ready or does not match the verified launch.');
      const report = await fetchPublic(`${new URL(config.website).origin}/launch/report.json`);
      if (report.mint !== state.mint) throw new Error('Publish the finalized mint in the allocation snapshot.');
      console.log('Public site, mint, treasury token account, and allocation report match the verified launch.');
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    // SDK/provider errors can include authenticated endpoint URLs. Do not print stacks or raw URLs.
    const message = String(error?.message ?? 'Launch operation failed.').replace(/https?:\/\/[^\s"'<>]+/g, '[endpoint]');
    console.error(message.slice(0, 800)); process.exitCode = 1;
  });
}
