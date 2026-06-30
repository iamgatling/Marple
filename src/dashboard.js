import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));


async function handleCollect(req, res, storage) {
  try {
    const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB
    let body = '';
    await new Promise((resolve) => {
      req.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) {
          res.writeHead(413);
          res.end('Payload too large');
          resolve();
          return;
        }
      });
      req.on('end', resolve);
    });
    if (!body || res.writableEnded) return;

    const payload = JSON.parse(body || '{}');
    const MAX_EVENTS_PER_BATCH = 50;
    const events = Array.isArray(payload) ? payload : [payload];
    if (events.length > MAX_EVENTS_PER_BATCH) {
      return res.writeHead(400), res.end('Too many events in batch');
    }
    const ua = req.headers['user-agent'] || '';
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

    for (const ev of events) {
      if (!ev.event_type) continue;
      await storage.writeEvent({ ...ev, ip, ua, timestamp: new Date().toISOString() });
    }

    res.writeHead(204);
    res.end();
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleApi(subPath, req, res, storage) {
  const send = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const url = new URL(req.url, 'http://localhost');
  const params = Object.fromEntries(url.searchParams);

  try {
    if (subPath === '/overview')    return send(await storage.getOverview({ since: params.since }));
    if (subPath === '/users')       return send(await storage.getUsers({ limit: +params.limit || 50, offset: +params.offset || 0 }));
    if (subPath === '/cohorts')     return send(await storage.getCohorts());
    if (subPath === '/events')      return send(await storage.getEvents({ since: params.since }));
    if (subPath === '/config')      return send(storage.config);

    if (subPath.startsWith('/users/')) {
      const userId = decodeURIComponent(subPath.slice('/users/'.length));
      const profile = await storage.getUserProfile(userId);
      return profile ? send(profile) : send({ error: 'Not found' }, 404);
    }

    if (subPath === '/funnel') {
      let body = '';
      await new Promise(r => {
        req.on('data', c => { body += c; if (body.length > 8192) body = ''; });
        req.on('end', r);
      });
      const { steps } = JSON.parse(body || '{}');
      return send(await storage.getFunnel(steps));
    }

    send({ error: 'Not found' }, 404);
  } catch (e) {
    send({ error: e.message }, 500);
  }
}

function getDashboardHTML() {
  try {
    return readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
  } catch {
    return '<h1>Marple dashboard.html not found</h1>';
  }
}

function getClientSDK() {
  try {
    return readFileSync(path.join(__dirname, 'client.js'), 'utf8');
  } catch {
    return '/* Marple client.js not found */';
  }
}

export function createDashboardMiddleware({ authenticate, storage, config }) {
  let dashboardHTML = getDashboardHTML();
  let clientSDK = getClientSDK();

  return async function marpleMiddleware(req, res, next) {
    if (config?.dev) {
      dashboardHTML = getDashboardHTML();
      clientSDK = getClientSDK();
    }
    const rawPath = req.url.split('?')[0].replace(/\/+$/, '') || '/'; //probably unnecessary

    if (rawPath === '/client.js' || rawPath.endsWith('/marple/client.js')) {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public,max-age=3600' });
      return res.end(clientSDK);
    }

    if (rawPath === '/collect' || rawPath.endsWith('/marple/collect')) {
      return handleCollect(req, res, storage);
    }

    let authed = false;
    try { authed = await authenticate(req); } catch { }
    if (!authed) {
      res.writeHead(401, { 'Content-Type': 'text/plain', 'X-Robots-Tag': 'noindex' });
      return res.end('Unauthorized — Marple requires authentication.');
    }

    const apiMatch = rawPath.match(/\/api(\/.*)?$/);
    if (apiMatch) {
      return handleApi(apiMatch[1] || '/', req, res, storage);
    }

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store'
    });
    res.end(dashboardHTML);
  };
}
