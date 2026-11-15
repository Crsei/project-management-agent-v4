import { createRequire } from 'node:module';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.argv.length !== 2 || process.env.PM_ENABLE_LAB !== 'true') {
  throw new Error('Usage: PM_ENABLE_LAB=true node scripts/build-mobile-demo.mjs (controlled, non-production preview only)');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const web = path.join(root, 'apps/web');
const require = createRequire(path.join(web, 'package.json'));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
await mkdir(path.join(root, '.local'), { recursive: true });
const outDir = await mkdtemp(path.join(root, '.local/mobile-demo-build-'));
// Use the regular Web config and all provenance plugins. Never read local .env
// files, alter the live dist, or discard the main module graph required by checks.
process.env.DOVSPACE_ISOLATED_CHECKS = '1';
await build({
  root: web,
  configFile: path.join(web, 'vite.config.ts'),
  build: {
    outDir,
    emptyOutDir: false,
    manifest: true,
    rollupOptions: { input: {
      app: path.join(web, 'index.html'),
      mobileDemo: path.join(web, 'lab/pm/mobile.html'),
    } },
  },
});
console.log(JSON.stringify({ previewDirectory: outDir, entry: '/lab/pm/mobile.html', deployed: false }));
