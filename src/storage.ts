import { Driver, MarpleConfig } from './types.js';

export function parseBrowser(ua: string = ''): string {
  if (!ua) return 'Unknown';
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('OPR/') || ua.includes('Opera')) return 'Opera';
  if (ua.includes('Chrome')) return 'Chrome';
  if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari';
  if (ua.includes('Firefox')) return 'Firefox';
  return 'Other';
}

export function parseDevice(ua: string = ''): string {
  if (!ua) return 'Unknown';
  if (/iPad/i.test(ua)) return 'Tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'Mobile';
  return 'Desktop';
}

export function maskIp(ip?: string | null): string | null {
  if (!ip || typeof ip !== 'string') return null;
  let clean = ip.trim();

  if (clean.startsWith('[') && clean.includes(']')) {
    clean = clean.replace(/^\[([^\]]+)\].*$/, '$1');
  } else if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(clean)) {
    clean = clean.split(':')[0];
  }

  if (clean.toLowerCase().startsWith('::ffff:')) {
    const rest = clean.slice(7);
    if (rest.includes('.')) {
      clean = rest;
    }
  }

  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) {
    const parts = clean.split('.');
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
    }
  }

  if (clean.includes(':')) {
    const parts = clean.toLowerCase().split('::');
    if (parts.length > 2) return null;

    let left = parts[0] ? parts[0].split(':').filter(Boolean) : [];
    let right = parts.length === 2 && parts[1] ? parts[1].split(':').filter(Boolean) : [];

    if (right.length > 0 && right[right.length - 1].includes('.')) {
      const v4 = right.pop()!;
      const v4Parts = v4.split('.');
      if (v4Parts.length === 4 && left.length === 1 && left[0] === 'ffff' && parts.length === 2 && parts[0] === '') {
        return `${v4Parts[0]}.${v4Parts[1]}.${v4Parts[2]}.0`;
      }
    }

    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;

    const middle = parts.length === 2 ? new Array(missing).fill('0') : [];
    const full = [...left, ...middle, ...right];

    if (full.length !== 8) return null;

    const parsedHextets = full.slice(0, 3).map(h => {
      const val = parseInt(h, 16);
      return Number.isNaN(val) ? '0' : val.toString(16);
    });

    const [h0, h1, h2] = parsedHextets;
    if (h0 === '0' && h1 === '0' && h2 === '0') return '::';
    if (h1 === '0' && h2 === '0') return `${h0}::`;
    if (h2 === '0') return `${h0}:${h1}::`;
    return `${h0}:${h1}:${h2}::`;
  }

  return clean;
}

export interface UtmParams {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
}

export function extractUtmParams(url?: string | null): UtmParams {
  const empty: UtmParams = {
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_term: null,
    utm_content: null
  };
  if (!url || typeof url !== 'string') return empty;

  try {
    const parsed = new URL(url, 'http://localhost');
    return {
      utm_source: parsed.searchParams.get('utm_source') || null,
      utm_medium: parsed.searchParams.get('utm_medium') || null,
      utm_campaign: parsed.searchParams.get('utm_campaign') || null,
      utm_term: parsed.searchParams.get('utm_term') || null,
      utm_content: parsed.searchParams.get('utm_content') || null
    };
  } catch {
    return empty;
  }
}

export interface DateRange {
  since: string;
  until: string;
  prevSince: string;
  prevUntil: string;
  durationMs: number;
}

export function normalizeDateRange(sinceInput?: string, untilInput?: string): DateRange {
  let untilMs = untilInput ? new Date(untilInput).getTime() : Date.now();
  if (isNaN(untilMs)) untilMs = Date.now();

  if (untilInput && /^\d{4}-\d{2}-\d{2}$/.test(untilInput)) {
    const [y, m, d] = untilInput.split('-').map(Number);
    untilMs = Date.UTC(y, m - 1, d, 23, 59, 59, 999);
  }

  let sinceMs = sinceInput ? new Date(sinceInput).getTime() : untilMs - 30 * 86400000;
  if (isNaN(sinceMs)) sinceMs = untilMs - 30 * 86400000;

  if (sinceInput && /^\d{4}-\d{2}-\d{2}$/.test(sinceInput)) {
    const [y, m, d] = sinceInput.split('-').map(Number);
    sinceMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  }

  if (sinceMs >= untilMs) {
    sinceMs = untilMs - 30 * 86400000;
  }

  const durationMs = untilMs - sinceMs;
  const prevUntilMs = sinceMs;
  const prevSinceMs = sinceMs - durationMs;

  return {
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    prevSince: new Date(prevSinceMs).toISOString(),
    prevUntil: new Date(prevUntilMs).toISOString(),
    durationMs
  };
}

export function getPublicConfig(config: Record<string, any> = {}): Record<string, any> {
  if (!config || typeof config !== 'object') return {};

  const SENSITIVE_KEYS = new Set([
    'connectionstring',
    'postgresconnectionstring',
    'password',
    'pass',
    'dbpassword',
    'secret',
    'key',
    'internalkey',
    'apikey',
    'privatekey',
    'token',
    'credential',
    'credentials',
    'auth'
  ]);

  function isSensitiveKey(key: string): boolean {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) return true;
    if (lowerKey.includes('connectionstring') || lowerKey.includes('connection_string')) return true;
    if (lowerKey.includes('password')) return true;
    if (lowerKey.includes('secret')) return true;
    if (lowerKey.includes('key')) return true;
    if (lowerKey.includes('token')) return true;
    if (lowerKey.includes('credential')) return true;
    return false;
  }

  function clean(obj: any): any {
    if (Array.isArray(obj)) {
      return obj.map(clean);
    }
    if (obj && typeof obj === 'object' && obj.constructor === Object) {
      const result: Record<string, any> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (!isSensitiveKey(k)) {
          result[k] = clean(v);
        }
      }
      return result;
    }
    return obj;
  }

  return clean(config);
}

/**
 * Unified Driver Interface Contract expects drivers to return a Driver object.
 */
export async function openStorage(config: MarpleConfig): Promise<Driver> {
  // Branch A: Custom Direct Object
  if (config.storage && typeof config.storage === 'object' && typeof (config.storage as any).writeEvent === 'function') {
    const customDriver = config.storage as Driver;
    if (typeof customDriver.getPublicConfig !== 'function') {
      customDriver.getPublicConfig = function() {
        return getPublicConfig(customDriver.config || config);
      };
    }
    return customDriver;
  }

  // Branch B: config object with type or string
  const storageType = typeof config.storage === 'string'
    ? config.storage
    : (typeof config.storage === 'object' && (config.storage as any)?.type ? (config.storage as any).type : 'sqlite');

  if (storageType === 'postgres') {
    const { default: openPostgresStorage } = await import('./drivers/postgres.js');
    return openPostgresStorage(config);
  }

  if (storageType === 'sqlite') {
    const { default: openSqliteStorage } = await import('./drivers/sqlite.js');
    return openSqliteStorage(config);
  }

  throw new Error(`[Marple] Unsupported storage type: ${storageType}`);
}
