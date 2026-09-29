import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { isbot } from 'isbot';
import { getPublicConfig } from './storage.js';
import { Driver, MarpleConfig, TrackEvent, FunnelStep } from './types.js';

export type MarpleRequest = IncomingMessage & {
  body?: unknown;
  url?: string;
  headers: IncomingMessage['headers'];
  socket: IncomingMessage['socket'];
  [key: string]: any;
};

export type MarpleResponse = ServerResponse & {
  [key: string]: any;
};

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

function sendSafe(
  res: MarpleResponse,
  status: number,
  body?: string | null,
  headers: Record<string, string> = {}
): boolean {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    return false;
  }
  try {
    res.writeHead(status, headers);
    if (body !== null && body !== undefined) {
      res.end(body);
    } else {
      res.end();
    }
    return true;
  } catch {
    return false;
  }
}

export interface ReadJsonResult {
  data: any;
  payloadTooLarge?: boolean;
  aborted?: boolean;
}

async function readJsonBody(
  req: MarpleRequest,
  maxBytes: number = 64 * 1024
): Promise<ReadJsonResult> {
  const contentLengthRaw = req.headers['content-length'];
  if (contentLengthRaw) {
    const contentLength = typeof contentLengthRaw === 'string'
      ? parseInt(contentLengthRaw, 10)
      : parseInt(contentLengthRaw[0], 10);
    if (!Number.isNaN(contentLength) && contentLength > maxBytes) {
      if (!req.readableEnded && !req.destroyed && typeof req.resume === 'function') {
        req.resume();
      }
      return { data: null, payloadTooLarge: true };
    }
  }

  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      if (Buffer.byteLength(req.body) > maxBytes) {
        return { data: null, payloadTooLarge: true };
      }
      try {
        return { data: req.body ? JSON.parse(req.body) : {} };
      } catch {
        throw new Error('Malformed JSON');
      }
    }
    if (Buffer.isBuffer(req.body)) {
      if (req.body.length > maxBytes) {
        return { data: null, payloadTooLarge: true };
      }
      try {
        const str = req.body.toString('utf-8');
        return { data: str ? JSON.parse(str) : {} };
      } catch {
        throw new Error('Malformed JSON');
      }
    }
    if (typeof req.body === 'object') {
      try {
        const jsonStr = JSON.stringify(req.body);
        if (Buffer.byteLength(jsonStr) > maxBytes) {
          return { data: null, payloadTooLarge: true };
        }
      } catch {
        // If stringify fails, proceed with object as-is
      }
      return { data: req.body };
    }
    return { data: req.body };
  }

  if (req.readableEnded || req.complete || req.destroyed) {
    return { data: {} };
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let totalBytes = 0;
    const chunks: Buffer[] = [];

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('close', onClose);
      req.removeListener('aborted', onAbort);
    };

    const finish = (result: ReadJsonResult, isError: boolean = false, error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (isError) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    const onData = (chunk: any) => {
      if (settled) return;
      try {
        const buf = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(typeof chunk === 'string' ? chunk : String(chunk));
        totalBytes += buf.length;

        if (totalBytes > maxBytes) {
          if (!req.readableEnded && !req.destroyed && typeof req.resume === 'function') {
            req.resume();
          }
          finish({ data: null, payloadTooLarge: true });
          return;
        }

        chunks.push(buf);
      } catch (err) {
        finish({ data: null }, true, err);
      }
    };

    const onEnd = () => {
      if (settled) return;
      try {
        const fullBuffer = Buffer.concat(chunks, totalBytes);
        const str = fullBuffer.toString('utf-8');
        const data = str ? JSON.parse(str) : {};
        finish({ data });
      } catch (err) {
        finish({ data: null }, true, err);
      }
    };

    const onError = (err: any) => {
      if (settled) return;
      finish({ data: null }, true, err);
    };

    const onClose = () => {
      if (settled) return;
      if (!req.readableEnded && !req.complete) {
        finish({ data: null, aborted: true });
      }
    };

    const onAbort = () => {
      if (settled) return;
      finish({ data: null, aborted: true });
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
    req.on('aborted', onAbort);
  });
}

async function handleCollect(req: MarpleRequest, res: MarpleResponse, storage: Driver): Promise<void> {
  if (res.headersSent || res.writableEnded || res.destroyed) return;

  try {
    const xff = req.headers['x-forwarded-for'];
    const rawIp = (Array.isArray(xff) ? xff[0] : xff) || req.socket?.remoteAddress || '';
    const ip = rawIp.split(',')[0].trim();
    if (checkRateLimit(ip)) {
      sendSafe(res, 429, 'Too Many Requests', { 'Content-Type': 'text/plain' });
      return;
    }

    const rawUa = req.headers['user-agent'];
    const ua = (Array.isArray(rawUa) ? rawUa[0] : rawUa) || '';
    if (isbot(ua)) {
      sendSafe(res, 204);
      return;
    }

    const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB
    const { data: payload, payloadTooLarge, aborted } = await readJsonBody(req, MAX_PAYLOAD_BYTES);

    if (aborted || res.headersSent || res.writableEnded || res.destroyed) {
      return;
    }

    if (payloadTooLarge) {
      sendSafe(res, 413, 'Payload Too Large', {
        'Content-Type': 'text/plain',
        'Connection': 'close'
      });
      return;
    }

    const MAX_EVENTS_PER_BATCH = 50;
    const events: TrackEvent[] = Array.isArray(payload) ? payload : [payload];
    if (events.length > MAX_EVENTS_PER_BATCH) {
      sendSafe(res, 400, 'Too many events in batch', { 'Content-Type': 'text/plain' });
      return;
    }

    for (const ev of events) {
      if (!ev || typeof ev !== 'object' || !ev.event_type) continue;
      await storage.writeEvent({ ...ev, ip, ua, timestamp: new Date().toISOString() });
    }

    sendSafe(res, 204);
  } catch (e: any) {
    sendSafe(res, 400, JSON.stringify({ error: e?.message || 'Bad Request' }), {
      'Content-Type': 'application/json'
    });
  }
}

async function handleApi(subPath: string, req: MarpleRequest, res: MarpleResponse, storage: Driver): Promise<void> {
  const send = (data: any, status = 200) => {
    sendSafe(res, status, JSON.stringify(data), { 'Content-Type': 'application/json' });
  };
  const url = new URL(req.url || '/', 'http://localhost');
  const params = Object.fromEntries(url.searchParams);

  try {
    if (subPath === '/overview')    return send(await storage.getOverview({ since: params.since, until: params.until, goal: params.goal || params.targetGoal }));
    if (subPath === '/users')       return send(await storage.getUsers({ limit: +params.limit || 50, offset: +params.offset || 0 }));
    if (subPath === '/cohorts')     return send(typeof storage.getCohorts === 'function' ? await storage.getCohorts() : []);
    if (subPath === '/events')      return send(typeof storage.getEvents === 'function' ? await storage.getEvents({ since: params.since, until: params.until }) : { events: [], trend: [] });
    if (subPath === '/conversions' || subPath === '/goals') return send(typeof storage.getConversions === 'function' ? await storage.getConversions({ since: params.since, until: params.until, goal: params.goal || params.targetGoal }) : null);
    if (subPath === '/config')      return send(typeof storage.getPublicConfig === 'function' ? await storage.getPublicConfig() : getPublicConfig(storage.config || {}));

    if (subPath.startsWith('/users/')) {
      const userId = decodeURIComponent(subPath.slice('/users/'.length));
      const profile = typeof storage.getUserProfile === 'function' ? await storage.getUserProfile(userId) : null;
      return profile ? send(profile) : send({ error: 'Not found' }, 404);
    }

    if (subPath === '/funnel') {
      const { data: bodyData } = await readJsonBody(req, 8192);
      const { steps } = (bodyData || {}) as { steps: FunnelStep[] };
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
  authenticate: (req: MarpleRequest) => boolean | Promise<boolean>;
  storage: Driver;
  config: MarpleConfig;
}

export function createDashboardMiddleware({ authenticate, storage, config }: DashboardOptions) {
  let dashboardHTML = getDashboardHTML();
  let clientSDK = getClientSDK();

  return async function marpleMiddleware(req: MarpleRequest, res: MarpleResponse, next?: any) {
    if (config?.dev) {
      dashboardHTML = getDashboardHTML();
      clientSDK = getClientSDK();
    }
    const rawPath = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';

    if (rawPath === '/client.js' || rawPath.endsWith('/marple/client.js')) {
      sendSafe(res, 200, clientSDK, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public,max-age=3600' });
      return;
    }

    if (rawPath === '/collect' || rawPath.endsWith('/marple/collect')) {
      return handleCollect(req, res, storage);
    }

    let authed = false;
    try { authed = await authenticate(req); } catch { }
    if (!authed) {
      sendSafe(res, 401, 'Unauthorized — Marple requires authentication.', {
        'Content-Type': 'text/plain',
        'X-Robots-Tag': 'noindex'
      });
      return;
    }

    const apiMatch = rawPath.match(/\/api(\/.*)?$/);
    if (apiMatch) {
      return handleApi(apiMatch[1] || '/', req, res, storage);
    }

    sendSafe(res, 200, dashboardHTML, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store'
    });
  };
}
