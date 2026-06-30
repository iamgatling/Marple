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
 */
export async function openStorage(config) {
  // Branch A: Custom Direct Object (map It yourslf )
  if (config.storage && typeof config.storage === 'object' && typeof config.storage.writeEvent === 'function') {
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
