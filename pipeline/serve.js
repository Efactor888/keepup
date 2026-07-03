// Tiny static server for the generated site. Usage: npm run serve [-- --port 4173]
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './util.js';

const args = process.argv.slice(2);
const port = Number(process.env.PORT) || Number(args[args.indexOf('--port') + 1]) || 4173;
const siteDir = join(ROOT, 'site');

createServer((req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = join(siteDir, path);
  if (!file.startsWith(siteDir) || !existsSync(file)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const TYPES = {
    '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif',
  };
  const ext = path.slice(path.lastIndexOf('.'));
  res.writeHead(200, { 'Content-Type': TYPES[ext] || 'text/plain; charset=utf-8' }).end(readFileSync(file));
}).listen(port, () => console.log(`KeepUp running at http://localhost:${port}`));
