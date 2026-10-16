import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers.ts';

/** A fake built frontend: index.html naming one hashed JS and one hashed CSS asset. */
export function writeDist(dir: string, id: string): string {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', `app-${id}.js`), `window.build = ${JSON.stringify(id)};`);
  fs.writeFileSync(path.join(dir, 'assets', `app-${id}.css`), `body { --build: "${id}"; }`);
  const html = `<!doctype html><html><head><script type="module" crossorigin src="/assets/app-${id}.js"></script><link rel="stylesheet" crossorigin href="/assets/app-${id}.css"></head><body><div id="root" data-build="${id}"></div></body></html>`;
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  return html;
}

/** Sets a path's mtime `secondsAgo` in the past (or future, if negative). */
export function age(p: string, secondsAgo: number) {
  const t = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(p, t, t);
}

const OK_SCRIPT = `
import fs from 'node:fs';
import path from 'node:path';
const out = process.env.RECALL_BUILD_OUT_DIR;
const gate = process.env.FAKE_BUILD_GATE;
if (gate) { while (!fs.existsSync(gate)) await new Promise((r) => setTimeout(r, 20)); }
const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
fs.writeFileSync(path.join(out, 'assets', 'app-' + id + '.js'), 'window.build = "' + id + '";');
fs.writeFileSync(path.join(out, 'assets', 'app-' + id + '.css'), 'body{}');
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><script type="module" src="/assets/app-' + id + '.js"></script><link rel="stylesheet" href="/assets/app-' + id + '.css"><div id="root" data-build="' + id + '"></div>');
console.log('vite v7 building for production...');
console.log('✓ built ' + id);
`;

const FAIL_SCRIPT = `
console.log('vite v7 building for production...');
console.error('error during build:');
console.error('src/main.tsx:3:5: ERROR: Unexpected "}"');
console.error('    at failureErrorWithLog (node_modules/esbuild/lib/main.js:1:1)');
process.exit(1);
`;

export interface Workspace {
  root: string;
  dataDir: string;
  distDir: string;
  srcDir: string;
  logPath: string;
  buildScript: string;
  gate: string;
  buildCommand: string[];
  buildOk: () => void;
  buildFails: () => void;
  openGate: () => void;
}

/** Temp project: a data dir, a dist dir, one "source" folder and a swappable build script. */
export function workspace(opts: { dist?: boolean; srcAgeSeconds?: number } = {}): Workspace {
  const root = tempDir('recall-startup-');
  const w: Workspace = {
    root,
    dataDir: path.join(root, 'data'),
    distDir: path.join(root, 'dist'),
    srcDir: path.join(root, 'src'),
    logPath: path.join(root, 'recall.log'),
    buildScript: path.join(root, 'build.mjs'),
    gate: path.join(root, 'gate'),
    buildCommand: [],
    buildOk: () => fs.writeFileSync(w.buildScript, OK_SCRIPT),
    buildFails: () => fs.writeFileSync(w.buildScript, FAIL_SCRIPT),
    openGate: () => fs.writeFileSync(w.gate, ''),
  };
  w.buildCommand = [process.execPath, w.buildScript];
  fs.mkdirSync(w.srcDir, { recursive: true });
  fs.writeFileSync(path.join(w.srcDir, 'main.tsx'), 'export {};');
  const srcAge = opts.srcAgeSeconds ?? 3600;
  age(path.join(w.srcDir, 'main.tsx'), srcAge);
  age(w.srcDir, srcAge);
  w.buildOk();
  if (opts.dist !== false) writeDist(w.distDir, 'old');
  return w;
}
