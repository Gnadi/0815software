import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The service worker of an installable module — copy-in, byte-identical in
 * every module whose registry entry says `installable` (vite.config.ts uses
 * it; deploy/test/pwa.test.ts keeps the copies equal).
 *
 * At build time it writes `sw.js` next to the app from `src/pwa/sw.js`, with:
 *   - the files of THIS build to cache — the bundle, and everything under
 *     `public/` (manifest, icons);
 *   - a version derived from their content, so a new deployment is a new
 *     cache and the old one is dropped when the new worker takes over;
 *   - a cache name from the package's own name, so two apps on one origin
 *     never drop each other's caches.
 *
 * Hand-rolled on purpose: a few dozen lines instead of a plugin dependency.
 */

function filesUnder(dir) {
  let out = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out = out.concat(filesUnder(path));
    else out.push(path);
  }
  return out;
}

export function serviceWorker() {
  // The app's own directory as Vite resolved it — not wherever the build was started from.
  let root = process.cwd();
  return {
    name: 'installable-app-service-worker',
    apply: 'build',
    // After Vite's own plugins, so index.html is in the bundle to be listed.
    enforce: 'post',
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      const name = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name.replace(/^@[^/]+\//, '');
      const hash = createHash('sha256');
      const built = Object.keys(bundle)
        .filter((file) => !file.endsWith('.map'))
        .sort();
      for (const file of built) {
        const chunk = bundle[file];
        hash.update(file);
        hash.update(chunk.type === 'chunk' ? chunk.code : typeof chunk.source === 'string' ? chunk.source : Buffer.from(chunk.source));
      }
      const publicDir = join(root, 'public');
      const fromPublic = filesUnder(publicDir).sort();
      for (const file of fromPublic) {
        hash.update(relative(publicDir, file));
        hash.update(readFileSync(file));
      }
      const files = [...built.map((f) => `/${f}`), ...fromPublic.map((f) => `/${relative(publicDir, f).split(sep).join('/')}`)];
      const source = readFileSync(join(root, 'src/pwa/sw.js'), 'utf8')
        .replace('__VERSION__', hash.digest('hex').slice(0, 16))
        .replace('__PRECACHE__', JSON.stringify(files))
        .replace('__CACHE__', name);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}
