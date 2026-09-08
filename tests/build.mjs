// The tests run the real modules, so they transpile lib/*.ts on the fly rather than
// depending on a build step. Shared here because the import rewrite is easy to get
// wrong in one file and not the others.
import ts from 'typescript';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

/** Transpile the named lib modules into work/tests and return their import paths. */
export async function build(names) {
  await mkdir('work/tests', { recursive: true });
  for (const name of names) {
    const source = await readFile(`lib/${name}.ts`, 'utf8');
    const js = ts
      .transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
        },
      })
      .outputText.replace(/from '\.\/(\w+)'/g, "from './$1.js'");
    await writeFile(`work/tests/${name}.js`, js);
  }
}
