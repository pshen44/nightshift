// Local control-room dashboard: one HTML page plus a server-sent event stream.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'dashboard.html');

export function serve(shift, port = 4242) {
  const clients = new Set();
  const send = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  shift.on('state', () => send('state', shift.state()));
  shift.on('feed', (line) => send('feed', line));

  const server = http.createServer(async (req, res) => {
    // Bound to 127.0.0.1, and only same-origin pages may drive it (blocks DNS rebinding and drive-by POSTs).
    const host = req.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url, `http://${host}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fs.readFileSync(PAGE));
      } else if (req.method === 'GET' && url.pathname === '/state') {
        json(res, { ...shift.state(), feed: shift.feed });
      } else if (req.method === 'GET' && url.pathname === '/card') {
        const file = url.searchParams.get('file') ?? '';
        const col = shift.board.find(file);
        if (!col) return json(res, { error: 'No such card.' }, 404);
        json(res, { file, col, text: shift.board.read(col, file) });
      } else if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': hi\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
      } else if (req.method === 'POST' && req.headers['content-type'] === 'application/json') {
        const body = await readJson(req);
        if (url.pathname === '/answer' && body.file && body.text?.trim()) shift.answer(body.file, body.text.trim());
        else if (url.pathname === '/card' && body.title?.trim()) shift.addCard(body.title.trim(), body.body ?? '');
        else if (url.pathname === '/stop') shift.stop();
        else return json(res, { error: 'Missing fields.' }, 400);
        json(res, { ok: true });
      } else {
        res.writeHead(404).end();
      }
    } catch (e) {
      json(res, { error: e.message }, 400);
    }
  });
  // Keep event streams alive through proxies and sleepy laptops.
  setInterval(() => { for (const r of clients) r.write(': ping\n\n'); }, 20_000).unref();
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function json(res, data, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => {
      s += d;
      if (s.length > 64 * 1024) req.destroy(new Error('Body too large.'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(s || '{}')); } catch { reject(new Error('Body is not JSON.')); }
    });
    req.on('error', reject);
  });
}
