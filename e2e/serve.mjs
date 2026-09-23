import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const root = resolve('apps/expo/dist');
const config = JSON.parse(await readFile('apps/expo/vercel.json', 'utf8'));
const headers = config.headers.find(({ source }) => source === '/(.*)').headers;
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};
createServer(async (req, res) => {
  for (const { key, value } of headers) res.setHeader(key, value);
  try {
    let file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost:8099').pathname));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!(await stat(file).catch(() => null))?.isFile()) file = resolve(root, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(500).end('Could not serve web export');
  }
}).listen(8099, () => console.log('E2E app: http://localhost:8099'));
