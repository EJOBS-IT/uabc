// Bundles the extension into extension/dist (unpacked, loadable in Chrome).
//   node extension/build.mjs           development build (keeps the dev "key" → stable id)
//   node extension/build.mjs --watch   rebuild on change
//   node extension/build.mjs --store   Chrome Web Store build + zip (no "key")
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
const store = process.argv.includes('--store');
const watch = process.argv.includes('--watch');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(here, 'static'), out, { recursive: true });

const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
manifest.version = pkg.version;
if (store) delete manifest.key; // the store assigns the id; uploads with "key" are rejected
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

const common = {
  bundle: true,
  target: 'chrome116',
  sourcemap: store ? false : 'inline',
  minify: store,
  legalComments: 'none',
  define: { __BUILD_ID__: JSON.stringify(`${pkg.version}-${Date.now().toString(36)}`) },
  logLevel: 'info',
};
const builds = [
  { ...common, entryPoints: { background: join(here, 'src/background/main.ts') }, format: 'esm', outdir: out },
  {
    ...common,
    entryPoints: {
      content: join(here, 'src/content/main.ts'),
      popup: join(here, 'src/ui/popup.ts'),
      approve: join(here, 'src/ui/approve.ts'),
      options: join(here, 'src/ui/options.ts'),
      sidepanel: join(here, 'src/ui/sidepanel.ts'),
    },
    format: 'iife',
    outdir: out,
  },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  console.log('watching for changes…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  if (store) {
    const zip = join(here, `uabc-extension-${pkg.version}.zip`);
    rmSync(zip, { force: true });
    execFileSync('zip', ['-qr', zip, '.'], { cwd: out });
    console.log(`store package: ${zip}`);
  }
}
