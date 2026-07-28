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
  if (!ip) return null;
  if (ip.includes('.')) {
    const p = ip.split('.');
    if (p.length === 4) return `${p[0]}.${p[1]}.${p[2]}.0`;
  }
  if (ip.includes(':')) {
    const p = ip.split(':');
    if (p.length >= 3) return `${p[0]}:${p[1]}:${p[2]}::`;
  }
  return ip;
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
