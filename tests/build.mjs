// The tests run the real modules, so they transpile lib/*.ts on the fly rather than
// depending on a build step. Shared here because the import rewrite is easy to get
// wrong in one file and not the others.
import ts from 'typescript';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

/**
 * Transpile the named modules into work/tests. A bare name is a lib module; a name with
 * a slash (`hooks/use-coin`) is a path from the repo root. Everything lands flat, so both
 * relative and `@/`-aliased imports rewrite to a sibling file.
 */
export async function build(names) {
  await mkdir('work/tests', { recursive: true });
  for (const name of names) {
    const path = name.includes('/') ? name : `lib/${name}`;
    const source = await readFile(`${path}.ts`, 'utf8');
    const js = ts
      .transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
        },
      })
      .outputText.replace(/from '(?:\.\/|@\/\w+\/)([\w-]+)'/g, "from './$1.js'");
    // Test files run in parallel and build the same modules, so the last step is a rename:
    // a sibling process never imports a half-written file.
    const out = `work/tests/${path.split('/').pop()}.js`;
    const temp = `${out}.${process.pid}.tmp`;
    await writeFile(temp, js);
    await rename(temp, out);
  }
}
