import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { isbot } from 'isbot';
import { getPublicConfig } from './storage.js';
import { Driver, MarpleConfig, TrackEvent, FunnelStep } from './types.js';
import { validateIngestBatch, ValidationError, IngestEvent } from './validation.js';
import { getClientIp } from './proxy.js';

export type MarpleRequest = IncomingMessage & {
  body?: unknown;
  url?: string;
  headers: IncomingMessage['headers'];
  socket: IncomingMessage['socket'];
  [key: string]: unknown;
};

export type MarpleResponse = ServerResponse & {
  [key: string]: unknown;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface RateLimitResult {
  limited: boolean;
  retryAfter: number;
}

export class RateLimiter {
  private map = new Map<string, number[]>();
  private maxRequests: number;
  private windowMs: number;
  private maxKeys: number;

  constructor(maxRequests = 100, windowMs = 60 * 1000, maxKeys = 5000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  check(ip: string): RateLimitResult {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let timestamps = this.map.get(ip);
    if (!timestamps) {
      timestamps = [];
    } else {
      while (timestamps.length > 0 && timestamps[0] <= windowStart) {
        timestamps.shift();
      }
    }

    if (timestamps.length >= this.maxRequests) {
      const oldest = timestamps[0];
      const retryAfter = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      return { limited: true, retryAfter };
    }

    timestamps.push(now);
    this.map.set(ip, timestamps);

    if (this.map.size > this.maxKeys) {
      for (const [k, ts] of this.map.entries()) {
        if (ts.length === 0 || ts[ts.length - 1] <= windowStart) {
          this.map.delete(k);
        }
        if (this.map.size <= this.maxKeys * 0.8) break;
      }
      if (this.map.size > this.maxKeys) {
        for (const k of this.map.keys()) {
          this.map.delete(k);
          if (this.map.size <= this.maxKeys * 0.8) break;
        }
      }
    }

    return { limited: false, retryAfter: 0 };
  }

  reset(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

const defaultRateLimiter = new RateLimiter();

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
    const finalHeaders = {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      ...headers
    };
    res.writeHead(status, finalHeaders);
    if (body !== null && body !== undefined && res.req?.method !== 'HEAD') {
      res.end(body);
    } else {
      res.end();
    }
    return true;
  } catch {
    return false;
  }
}

function sendJsonError(
  res: MarpleResponse,
  status: number,
  message: string,
  code: string,
  headers: Record<string, string> = {}
): boolean {
  return sendSafe(
    res,
    status,
    JSON.stringify({ error: message, code, message }),
    { 'Content-Type': 'application/json', ...headers }
  );
}

export interface ReadJsonResult {
  data: unknown;
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

    const onData = (chunk: Buffer | Uint8Array | string) => {
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

    const onError = (err: unknown) => {
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

async function handleCollect(
  req: MarpleRequest,
  res: MarpleResponse,
  storage: Driver,
  config?: MarpleConfig,
  limiter: RateLimiter = defaultRateLimiter
): Promise<void> {
  if (res.headersSent || res.writableEnded || res.destroyed) return;

  try {
    const activeConfig = config || storage.config;
    const ip = getClientIp(req, activeConfig);
    const limit = limiter.check(ip);
    if (limit.limited) {
      sendSafe(res, 429, 'Too Many Requests', {
        'Content-Type': 'text/plain',
        'Retry-After': String(limit.retryAfter)
      });
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

    let validatedEvents: IngestEvent[];
    try {
      validatedEvents = validateIngestBatch(payload);
    } catch (err) {
      if (err instanceof ValidationError) {
        sendSafe(res, 400, JSON.stringify({ error: err.message, code: err.code }), {
          'Content-Type': 'application/json'
        });
        return;
      }
      sendSafe(res, 400, JSON.stringify({ error: 'Invalid payload', code: 'INVALID_PAYLOAD' }), {
        'Content-Type': 'application/json'
      });
      return;
    }

    const serverTimestamp = new Date().toISOString();
    for (const ev of validatedEvents) {
      const sanitizedEvent: TrackEvent = {
        ...ev,
        ip,
        ua,
        timestamp: serverTimestamp
      };
      await storage.writeEvent(sanitizedEvent);
    }

    sendSafe(res, 204);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Bad Request';
    sendSafe(res, 400, JSON.stringify({ error: message }), {
      'Content-Type': 'application/json'
    });
  }
}

async function handleApi(subPath: string, req: MarpleRequest, res: MarpleResponse, storage: Driver): Promise<void> {
  const method = (req.method || 'GET').toUpperCase();
  const send = (data: unknown, status = 200, extraHeaders: Record<string, string> = {}) => {
    sendSafe(res, status, JSON.stringify(data), { 'Content-Type': 'application/json', ...extraHeaders });
  };
  const sendError = (status: number, message: string, code: string, extraHeaders: Record<string, string> = {}) => {
    sendJsonError(res, status, message, code, extraHeaders);
  };
  const url = new URL(req.url || '/', 'http://localhost');
  const params = Object.fromEntries(url.searchParams);

  try {
    if (subPath === '/funnel') {
      if (method !== 'POST') {
        return sendError(405, 'Method Not Allowed', 'METHOD_NOT_ALLOWED', { 'Allow': 'POST' });
      }
      const { data: bodyData } = await readJsonBody(req, 8192);
      const { steps, since, until } = (bodyData || {}) as {
        steps?: FunnelStep[];
        since?: string;
        until?: string;
      };

      if (!steps || !Array.isArray(steps)) {
        return sendError(400, 'Funnel requires an array of steps', 'INVALID_STEPS');
      }
      if (steps.length === 0) {
        return send([]);
      }
      for (const step of steps) {
        if (!step || typeof step !== 'object') {
          return sendError(400, 'Invalid funnel step', 'INVALID_STEP');
        }
        const s = step as Record<string, unknown>;
        const stepVal = typeof s.value === 'string' ? s.value : typeof s.name === 'string' ? s.name : undefined;
        if (stepVal !== undefined && typeof stepVal !== 'string') {
          return sendError(400, 'Invalid funnel step', 'INVALID_STEP');
        }
        if (typeof stepVal === 'string' && stepVal.length > 256) {
          return sendError(400, 'Invalid funnel step', 'INVALID_STEP');
        }
      }

      const effectiveSince = since !== undefined ? since : params.since;
      const effectiveUntil = until !== undefined ? until : params.until;

      if (effectiveSince && isNaN(new Date(effectiveSince).getTime())) {
        return sendError(400, 'Invalid "since" date range', 'INVALID_DATE');
      }
      if (effectiveUntil && isNaN(new Date(effectiveUntil).getTime())) {
        return sendError(400, 'Invalid "until" date range', 'INVALID_DATE');
      }
      if (effectiveSince && effectiveUntil && new Date(effectiveSince).getTime() > new Date(effectiveUntil).getTime()) {
        return sendError(400, '"since" must be earlier than or equal to "until"', 'INVALID_DATE_RANGE');
      }

      try {
        const results = await storage.getFunnel(steps, { since: effectiveSince, until: effectiveUntil });
        return send(results);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Funnel error';
        return sendError(400, message, 'FUNNEL_ERROR');
      }
    }

    if (method !== 'GET' && method !== 'HEAD') {
      return sendError(405, 'Method Not Allowed', 'METHOD_NOT_ALLOWED', { 'Allow': 'GET, HEAD' });
    }

    const checkDateParams = () => {
      if (params.since && isNaN(new Date(params.since).getTime())) {
        sendError(400, 'Invalid "since" date parameter', 'INVALID_DATE');
        return false;
      }
      if (params.until && isNaN(new Date(params.until).getTime())) {
        sendError(400, 'Invalid "until" date parameter', 'INVALID_DATE');
        return false;
      }
      if (params.since && params.until && new Date(params.since).getTime() > new Date(params.until).getTime()) {
        sendError(400, '"since" must be earlier than or equal to "until"', 'INVALID_DATE_RANGE');
        return false;
      }
      return true;
    };

    const targetGoal = params.goal || params.targetGoal;
    if (targetGoal && (typeof targetGoal !== 'string' || targetGoal.length > 256)) {
      return sendError(400, 'Goal parameter too long', 'INVALID_GOAL');
    }

    if (subPath === '/overview') {
      if (!checkDateParams()) return;
      return send(await storage.getOverview({ since: params.since, until: params.until, goal: targetGoal }));
    }

    if (subPath === '/users') {
      let limit = 50;
      if (params.limit !== undefined) {
        const parsed = parseInt(params.limit, 10);
        if (!Number.isNaN(parsed)) {
          limit = Math.min(100, Math.max(1, parsed));
        }
      }
      let offset = 0;
      if (params.offset !== undefined) {
        const parsed = parseInt(params.offset, 10);
        if (!Number.isNaN(parsed)) {
          offset = Math.max(0, parsed);
        }
      }
      return send(await storage.getUsers({ limit, offset }));
    }

    if (subPath === '/cohorts')     return send(typeof storage.getCohorts === 'function' ? await storage.getCohorts() : []);
    if (subPath === '/events') {
      if (!checkDateParams()) return;
      return send(typeof storage.getEvents === 'function' ? await storage.getEvents({ since: params.since, until: params.until }) : { events: [], trend: [] });
    }
    if (subPath === '/conversions' || subPath === '/goals') {
      if (!checkDateParams()) return;
      return send(typeof storage.getConversions === 'function' ? await storage.getConversions({ since: params.since, until: params.until, goal: targetGoal }) : null);
    }
    if (subPath === '/config')      return send(typeof storage.getPublicConfig === 'function' ? await storage.getPublicConfig() : getPublicConfig(storage.config || {}));

    if (subPath.startsWith('/users/')) {
      const userId = decodeURIComponent(subPath.slice('/users/'.length));
      if (!userId || userId.length > 256 || /[\0\r\n]/.test(userId)) {
        return sendError(400, 'Invalid user ID', 'INVALID_USER_ID');
      }
      const profile = typeof storage.getUserProfile === 'function' ? await storage.getUserProfile(userId) : null;
      return profile ? send(profile) : sendError(404, 'Not found', 'NOT_FOUND');
    }

    sendError(404, 'Not found', 'NOT_FOUND');
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Internal Server Error';
    sendError(500, message, 'INTERNAL_ERROR');
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
  const rateLimiter = new RateLimiter();

  return async function marpleMiddleware(req: MarpleRequest, res: MarpleResponse, next?: (err?: unknown) => void) {
    if (config?.dev) {
      dashboardHTML = getDashboardHTML();
      clientSDK = getClientSDK();
    }
    const rawPath = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
    const method = (req.method || 'GET').toUpperCase();

    if (rawPath === '/client.js' || rawPath.endsWith('/marple/client.js')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJsonError(res, 405, 'Method Not Allowed', 'METHOD_NOT_ALLOWED', { 'Allow': 'GET, HEAD' });
        return;
      }
      sendSafe(res, 200, clientSDK, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public,max-age=3600' });
      return;
    }

    if (rawPath === '/collect' || rawPath.endsWith('/marple/collect')) {
      if (method !== 'POST') {
        sendJsonError(res, 405, 'Method Not Allowed', 'METHOD_NOT_ALLOWED', { 'Allow': 'POST' });
        return;
      }
      return handleCollect(req, res, storage, config, rateLimiter);
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

    if (method !== 'GET' && method !== 'HEAD') {
      sendJsonError(res, 405, 'Method Not Allowed', 'METHOD_NOT_ALLOWED', { 'Allow': 'GET, HEAD' });
      return;
    }

    sendSafe(res, 200, dashboardHTML, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store'
    });
  };
}
