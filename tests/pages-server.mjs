import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const root = resolve('dist');
const port = Number(process.env.PAGES_TEST_PORT ?? 4186);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (!url.pathname.startsWith('/annotator/')) {
      response.writeHead(404).end(); return;
    }
    const relative = decodeURIComponent(url.pathname.slice('/annotator/'.length)) || 'index.html';
    const path = resolve(root, relative);
    if (!path.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end(); return;
    }
    const bytes = await readFile(path);
    response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' }).end(bytes);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') response.writeHead(404).end();
    else {
      console.error(error);
      response.writeHead(500).end();
    }
  }
});
server.listen(port, '127.0.0.1');
