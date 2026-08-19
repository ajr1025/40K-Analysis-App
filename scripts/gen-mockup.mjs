/**
 * Bundle scripts/mockup.ts and run it.
 *
 * The generator has to import the TypeScript engine, and plain node cannot
 * load TS. Vite is already a dependency, so bundling through its API is the
 * shortest path that keeps the mockup running the same code as the app --
 * which is the entire point of regenerating it.
 *
 *   node scripts/gen-mockup.mjs <out-dir>
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'vite';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node scripts/gen-mockup.mjs <out-dir>');
  process.exit(1);
}

const work = await mkdtemp(join(tmpdir(), 'mockup-'));

try {
  await build({
    logLevel: 'error',
    configFile: false,
    // Without this Vite copies all of public/ -- every faction JSON -- into
    // the temp dir on each run.
    publicDir: false,
    build: {
      outDir: work,
      emptyOutDir: true,
      minify: false,
      ssr: true,
      lib: {
        entry: resolve('scripts/mockup.ts'),
        formats: ['es'],
        fileName: () => 'mockup.js',
      },
      rollupOptions: { external: [/^node:/] },
    },
  });

  // The package is type:module, so a bundled .js is already ESM.
  const { default: main } = await import(pathToFileURL(join(work, 'mockup.js')).href);
  const data = main();

  const target = join(resolve(outDir), 'data.js');
  await writeFile(target, `const DATA=${JSON.stringify(data)};`, 'utf8');

  console.log(`wrote ${target}`);
  console.log(`  ${data.cols.length} targets, ${data.rows.length} attackers, ${data.search.length} searchable units`);
} finally {
  await rm(work, { recursive: true, force: true });
}
