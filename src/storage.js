export function parseBrowser(ua = '') {
  if (!ua) return 'Unknown';
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('OPR/') || ua.includes('Opera')) return 'Opera';
  if (ua.includes('Chrome')) return 'Chrome';
  if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari';
  if (ua.includes('Firefox')) return 'Firefox';
  return 'Other';
}

export function parseDevice(ua = '') {
  if (!ua) return 'Unknown';
  if (/iPad/i.test(ua)) return 'Tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'Mobile';
  return 'Desktop';
}

export function maskIp(ip) {
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

export function getPublicConfig(config = {}) {
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

  function isSensitiveKey(key) {
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

  function clean(obj) {
    if (Array.isArray(obj)) {
      return obj.map(clean);
    }
    if (obj && typeof obj === 'object' && obj.constructor === Object) {
      const result = {};
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
 * Unified Driver Interface Contract expects drivers to return:
 * writeEvent(ev)
 * getOverview({ since })
 * getUsers({ limit, offset })
 * getUserProfile(userId)
 * getCohorts()
 * getEvents({ since })
 * getFunnel(steps)
 * runRollup(config)
 * getPublicConfig()
 */
export async function openStorage(config) {
  // Branch A: Custom Direct Object (map It yourslf )
  if (config.storage && typeof config.storage === 'object' && typeof config.storage.writeEvent === 'function') {
    if (typeof config.storage.getPublicConfig !== 'function') {
      config.storage.getPublicConfig = function() {
        return getPublicConfig(config.storage.config || config);
      };
    }
    return config.storage;
  }

  // Branch B: config object with type or string
  const storageType = typeof config.storage === 'string' ? config.storage : (config.storage?.type || 'sqlite');

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

