import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../../app/studio/launch/page.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

async function render(environment, host, forwarded = 'localhost:3212') {
  const exports = {};
  let headerReads = 0;
  runInNewContext(compiled, {
    exports, process: { env: { NODE_ENV: environment } }, URL,
    require(name) {
      if (name === 'react/jsx-runtime') return require(name);
      if (name === 'next/navigation') return { notFound() { throw Object.assign(new Error('Not found'), { status: 404 }); } };
      if (name === 'next/headers') return { async headers() { headerReads++; return { get(name) { return name === 'host' ? host : forwarded; } }; } };
      if (name === 'next/link') return { default: () => null };
      if (name === '@/components/launch-studio') return { LaunchStudio: () => null };
      if (name.endsWith('.css')) return {};
      throw new Error(`Unexpected route dependency: ${name}`);
    },
  });
  const result = await exports.default();
  return { result, headerReads, dynamic: exports.dynamic };
}

await test('launch route is absent outside development, including loopback hosts', async () => {
  for (const environment of ['production', 'test', undefined]) {
    for (const host of ['localhost:3212', '127.0.0.1:3212', '[::1]:3212']) {
      await assert.rejects(render(environment, host), { status: 404 });
    }
  }
});
await test('launch route accepts only explicit loopback hostnames in development', async () => {
  for (const host of ['localhost', 'localhost:3212', 'LOCALHOST:3212', '127.0.0.1:1', '[::1]:65535']) {
    const result = await render('development', host);
    assert.ok(result.result);
    assert.equal(result.headerReads, 1);
    assert.equal(result.dynamic, 'force-dynamic');
  }
});
await test('malformed and remote hosts cannot be made local through forwarded headers', async () => {
  for (const host of [null, '', 'example.com', '192.168.1.1:3212', 'localhost.evil.test', 'localhost@evil.test', 'localhost/path', 'localhost\\evil.test', 'localhost:65536', '127.1', '0x7f000001', '2130706433', '[::ffff:127.0.0.1]', 'localhost:3212,example.com', ' localhost:3212']) {
    await assert.rejects(render('development', host, 'localhost:3212'), { status: 404 });
  }
});
