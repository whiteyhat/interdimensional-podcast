// The tests run the real modules, so they transpile lib/*.ts on the fly rather than
// depending on a build step. Shared here because the import rewrite is easy to get
// wrong in one file and not the others.
import ts from 'typescript';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

// Everything lands flat in work/tests, so a transpiled module imports its dependencies as
// siblings. Those dependencies have to be built too: a test that asks for `services` and
// nothing else still needs `speech` on disk, because services.js imports it. On a machine
// that has run the suite before, the sibling is left over from an earlier test and the
// omission is invisible; on a clean checkout the import fails outright.
const ROOTS = ['lib', 'hooks'];
const SIBLING = /from '\.\/([\w-]+)\.js'/g;

async function sourcePath(name) {
  if (name.includes('/')) return `${name}.ts`;
  for (const root of ROOTS) {
    try {
      await readFile(`${root}/${name}.ts`);
      return `${root}/${name}.ts`;
    } catch {}
  }
  return null;
}

/**
 * Transpile the named modules into work/tests, along with everything they import. A bare
 * name is looked up in lib/ then hooks/; a name with a slash (`hooks/use-coin`) is a path
 * from the repo root. Everything lands flat, so both relative and `@/`-aliased imports
 * rewrite to a sibling file.
 */
export async function build(names) {
  await mkdir('work/tests', { recursive: true });
  const seen = new Set();
  const queue = [...names];
  while (queue.length) {
    const name = queue.shift();
    const path = await sourcePath(name);
    // A sibling import with no matching source is not ours to build -- a node builtin or a
    // dependency -- so leave it for the module loader to resolve.
    if (!path) continue;
    if (seen.has(path)) continue;
    seen.add(path);

    const source = await readFile(path, 'utf8');
    const js = ts
      .transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
        },
      })
      .outputText.replace(/from '(?:\.\/|@\/\w+\/)([\w-]+)'/g, "from './$1.js'");

    for (const [, dep] of js.matchAll(SIBLING)) queue.push(dep);

    // Test files run in parallel and build the same modules, so the last step is a rename:
    // a sibling process never imports a half-written file.
    const out = `work/tests/${path.split('/').pop().replace(/\.ts$/, '')}.js`;
    const temp = `${out}.${process.pid}.tmp`;
    await writeFile(temp, js);
    await rename(temp, out);
  }
}
