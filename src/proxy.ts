import { isIP } from 'net';
import type { IncomingMessage } from 'http';
import type { MarpleConfig } from './types.js';

export function normalizeIp(ip: string | undefined | null): string {
  if (!ip) return '';
  let clean = ip.trim();

  if (clean.startsWith('[') && clean.includes(']')) {
    clean = clean.replace(/^\[([^\]]+)\].*$/, '$1');
  } else if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(clean)) {
    clean = clean.split(':')[0];
  }

  if (clean.startsWith('::ffff:')) {
    clean = clean.slice(7);
  }

  return clean.toLowerCase();
}

export function isValidIp(ip: string): boolean {
  if (!ip) return false;
  return isIP(ip) !== 0;
}

export function getClientIp(
  req: { headers: IncomingMessage['headers']; socket?: { remoteAddress?: string } },
  config?: MarpleConfig
): string {
  const directIp = normalizeIp(req.socket?.remoteAddress);
  const trustProxy = config?.trustProxy ?? false;

  if (trustProxy === false) {
    return directIp;
  }

  const xffRaw = req.headers['x-forwarded-for'];
  if (!xffRaw) {
    return directIp;
  }

  const xffString = Array.isArray(xffRaw) ? xffRaw.join(',') : xffRaw;
  const entries = xffString.split(',').map(normalizeIp).filter(Boolean);
  if (entries.length === 0) {
    return directIp;
  }

  if (typeof trustProxy === 'number' || trustProxy === true) {
    const hops = typeof trustProxy === 'number' ? Math.max(1, Math.floor(trustProxy)) : 1;
    const targetIndex = entries.length - hops;
    if (targetIndex < 0) {
      return directIp;
    }
    const resolved = entries[targetIndex];
    return isValidIp(resolved) ? resolved : directIp;
  }

  if (typeof trustProxy === 'string' || Array.isArray(trustProxy)) {
    const trustedList = new Set((Array.isArray(trustProxy) ? trustProxy : [trustProxy]).map(normalizeIp));
    if (!trustedList.has(directIp)) {
      return directIp;
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i];
      if (!trustedList.has(candidate)) {
        return isValidIp(candidate) ? candidate : directIp;
      }
    }
    return isValidIp(entries[0]) ? entries[0] : directIp;
  }

  return directIp;
}
