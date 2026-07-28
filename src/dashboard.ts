import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { getPublicConfig } from './storage.js';
import { Driver, MarpleConfig, TrackEvent, FunnelStep } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const collectRateLimitMap = new Map<string, number[]>();
const COLLECT_RATE_LIMIT_MAX = 100;
const COLLECT_RATE_LIMIT_WINDOW_MS = 60 * 1000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - COLLECT_RATE_LIMIT_WINDOW_MS;

  let timestamps = collectRateLimitMap.get(ip);
  if (!timestamps) {
    timestamps = [];
  } else {
    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
      timestamps.shift();
    }
  }

  if (timestamps.length >= COLLECT_RATE_LIMIT_MAX) {
    return true;
  }

  timestamps.push(now);
  collectRateLimitMap.set(ip, timestamps);

  if (collectRateLimitMap.size > 1000) {
    for (const [k, ts] of collectRateLimitMap.entries()) {
      if (ts.length === 0 || ts[ts.length - 1] <= windowStart) {
        collectRateLimitMap.delete(k);
      }
    }
  }

  return false;
}

async function handleCollect(req: any, res: any, storage: Driver): Promise<void> {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    if (checkRateLimit(ip)) {
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      return res.end('Too Many Requests');
    }

    const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB
    let body = '';
    await new Promise<void>((resolve) => {
      req.on('data', (chunk: any) => {
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
    const events: TrackEvent[] = Array.isArray(payload) ? payload : [payload];
    if (events.length > MAX_EVENTS_PER_BATCH) {
      res.writeHead(400);
      res.end('Too many events in batch');
      return;
    }
    const ua = req.headers['user-agent'] || '';

    for (const ev of events) {
      if (!ev.event_type) continue;
      await storage.writeEvent({ ...ev, ip, ua, timestamp: new Date().toISOString() });
    }

    res.writeHead(204);
    res.end();
  } catch (e: any) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleApi(subPath: string, req: any, res: any, storage: Driver): Promise<void> {
  const send = (data: any, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const url = new URL(req.url, 'http://localhost');
  const params = Object.fromEntries(url.searchParams);

  try {
    if (subPath === '/overview')    return send(await storage.getOverview({ since: params.since }));
    if (subPath === '/users')       return send(await storage.getUsers({ limit: +params.limit || 50, offset: +params.offset || 0 }));
    if (subPath === '/cohorts')     return send(typeof storage.getCohorts === 'function' ? await storage.getCohorts() : []);
    if (subPath === '/events')      return send(typeof storage.getEvents === 'function' ? await storage.getEvents({ since: params.since }) : { events: [], trend: [] });
    if (subPath === '/config')      return send(typeof storage.getPublicConfig === 'function' ? await storage.getPublicConfig() : getPublicConfig(storage.config || {}));

    if (subPath.startsWith('/users/')) {
      const userId = decodeURIComponent(subPath.slice('/users/'.length));
      const profile = typeof storage.getUserProfile === 'function' ? await storage.getUserProfile(userId) : null;
      return profile ? send(profile) : send({ error: 'Not found' }, 404);
    }

    if (subPath === '/funnel') {
      let body = '';
      await new Promise<void>(r => {
        req.on('data', (c: any) => { body += c; if (body.length > 8192) body = ''; });
        req.on('end', r);
      });
      const { steps } = JSON.parse(body || '{}') as { steps: FunnelStep[] };
      return send(await storage.getFunnel(steps));
    }

    send({ error: 'Not found' }, 404);
  } catch (e: any) {
    send({ error: e.message }, 500);
  }
}

function getDashboardHTML(): string {
  const candidates = [
    path.join(__dirname, 'dashboard.html'),
    path.join(__dirname, '../src/dashboard.html'),
    path.join(process.cwd(), 'src/dashboard.html')
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return readFileSync(p, 'utf8'); } catch { }
    }
  }
  return '<h1>Marple dashboard.html not found</h1>';
}

function getClientSDK(): string {
  const candidates = [
    path.join(__dirname, 'client.js'),
    path.join(__dirname, '../dist/client.js'),
    path.join(__dirname, '../src/client.js'),
    path.join(process.cwd(), 'dist/client.js')
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return readFileSync(p, 'utf8'); } catch { }
    }
  }
  return '/* Marple client.js not found */';
}

export interface DashboardOptions {
  authenticate: (req: any) => boolean | Promise<boolean>;
  storage: Driver;
  config: MarpleConfig;
}

export function createDashboardMiddleware({ authenticate, storage, config }: DashboardOptions) {
  let dashboardHTML = getDashboardHTML();
  let clientSDK = getClientSDK();

  return async function marpleMiddleware(req: any, res: any, next?: any) {
    if (config?.dev) {
      dashboardHTML = getDashboardHTML();
      clientSDK = getClientSDK();
    }
    const rawPath = req.url.split('?')[0].replace(/\/+$/, '') || '/';

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
