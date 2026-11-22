// npm run dev -> development server on http(s)://localhost:60443 (ports.frontend in backend config.js)
//  - rebuilds on every save and reloads the browser
//  - forwards /api to the backend API (ports.api, 61443; HTTPS taken from backend/src/config/config.js)
//  - serves index.html for any page URL (client-side routes like /SRE/incidents)
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import * as esbuild from 'esbuild-wasm'; // WebAssembly build: no native .exe, works on locked-down Windows
import { ROOT, buildOptions, writeIndexHtml, copyPublic, backendSettings } from './esbuild.common.mjs';

const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sre-portal-dev-'));
const backend = backendSettings();
const PORT = backend.frontend;
// UAT / PROD serve the built app on this same port (ports.web): the dev server is for LOCAL only
if (PORT === backend.web) {
  console.error(`Port ${PORT} is both the dev server port (FRONTEND_PORT) and the built app port (WEB_PORT).`);
  console.error('On a developer PC (LOCAL): leave WEB_PORT empty in backend/src/config/.env (it is then 62443), or use another port.');
  console.error('On a UAT / PROD server the built app uses this port: there run npm run build, not npm run dev.');
  process.exit(1);
}
const tls = backend.https && backend.https.certFile && backend.https.keyFile
  ? {
      cert: fs.readFileSync(backend.https.certFile),
      key: fs.readFileSync(backend.https.keyFile),
      ...(backend.https.caFile && fs.existsSync(backend.https.caFile) ? { ca: fs.readFileSync(backend.https.caFile) } : {}),
      ...(backend.https.passphrase ? { passphrase: backend.https.passphrase } : {}),
    }
  : null;

// ---- live reload: browsers listen on /__reload, notified after each rebuild ----
const listeners = new Set();
const RELOAD_SNIPPET = `<script>new EventSource('/__reload').onmessage = () => location.reload();</script>`;
const reloadPlugin = {
  name: 'reload',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      copyPublic(outdir);
      writeIndexHtml(outdir, result.metafile, RELOAD_SNIPPET);
      for (const res of listeners) res.write('data: reload\n\n');
    });
  },
};

const ctx = await esbuild.context({
  ...buildOptions,
  outdir,
  sourcemap: true,
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [reloadPlugin],
});
await ctx.rebuild(); // first build finishes before the server accepts requests

// Rebuild on save. esbuild-wasm's own ctx.watch() crashes after a while ("Fatal JavaScript invalid size error")
// and then silently stops rebuilding, so watch src/ with Node instead.
// A save during a rebuild queues one more rebuild, so no change is missed.
let rebuildTimer;
let building = false;
let again = false;
const rebuild = () => {
  if (building) return (again = true);
  building = true;
  ctx.rebuild()
    .catch(() => {}) // errors are printed by esbuild (logLevel info)
    .finally(() => {
      building = false;
      if (again) {
        again = false;
        rebuild();
      }
    });
};
fs.watch(path.join(ROOT, 'src'), { recursive: true }, () => {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 100);
});

// ---- static files + /api proxy ----
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function proxyApi(req, res) {
  const client = tls ? https : http;
  const upstream = client.request(
    { host: 'localhost', port: backend.api, path: req.url, method: req.method, headers: req.headers, rejectUnauthorized: false },
    (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    }
  );
  upstream.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: `Backend not reachable on port ${backend.api}` }));
  });
  req.pipe(upstream);
}

function handler(req, res) {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url.startsWith('/api')) return proxyApi(req, res);
  if (url === '/__reload') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('\n');
    listeners.add(res);
    req.on('close', () => listeners.delete(res));
    return;
  }
  let file = path.join(outdir, url);
  if (!file.startsWith(outdir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(outdir, 'index.html'); // client-side route
  }
  if (!fs.existsSync(file)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    return res.end('Build in progress or failed - check the terminal running npm run dev.');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).on('error', () => res.end()).pipe(res);
}

const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
server.listen(PORT, () => {
  const scheme = tls ? 'https' : 'http';
  console.log(`\n  SRE Portal frontend: ${scheme}://${backend.host}:${PORT}   (API -> ${scheme}://localhost:${backend.api} on this server)\n`);
});

const stop = async () => {
  await ctx.dispose();
  fs.rmSync(outdir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
