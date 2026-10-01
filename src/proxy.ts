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

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(p => parseInt(p, 10));
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function matchIpv4Cidr(ip: string, cidr: string): boolean {
  const [netStr, prefixStr] = cidr.split('/');
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(netStr);
  if (ipInt === null || netInt === null) return false;
  const prefix = prefixStr !== undefined ? parseInt(prefixStr, 10) : 32;
  if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;
  const mask = ((0xFFFFFFFF << (32 - prefix)) >>> 0);
  return (ipInt & mask) === (netInt & mask);
}

function parseIpv6(ip: string): number[] | null {
  const clean = ip.toLowerCase();
  if (!clean.includes(':')) return null;
  const parts = clean.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if (missing < 0) return null;
  const full = [...left, ...Array(missing).fill('0'), ...right];
  if (full.length !== 8) return null;
  const bytes: number[] = [];
  for (const seg of full) {
    const val = parseInt(seg || '0', 16);
    if (isNaN(val) || val < 0 || val > 0xffff) return null;
    bytes.push((val >> 8) & 0xff, val & 0xff);
  }
  return bytes;
}

function matchIpv6Cidr(ip: string, cidr: string): boolean {
  const [netStr, prefixStr] = cidr.split('/');
  const ipBytes = parseIpv6(ip);
  const netBytes = parseIpv6(netStr);
  if (!ipBytes || !netBytes) return false;
  const prefix = prefixStr !== undefined ? parseInt(prefixStr, 10) : 128;
  if (isNaN(prefix) || prefix < 0 || prefix > 128) return false;
  const fullBytes = Math.floor(prefix / 8);
  const remBits = prefix % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== netBytes[i]) return false;
  }
  if (remBits > 0) {
    const mask = (0xff << (8 - remBits)) & 0xff;
    if ((ipBytes[fullBytes] & mask) !== (netBytes[fullBytes] & mask)) return false;
  }
  return true;
}

export function isIpTrusted(ip: string, trustedList: string[]): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  for (const entry of trustedList) {
    const cleanEntry = entry.trim();
    if (cleanEntry.includes('/')) {
      if (cleanEntry.includes(':')) {
        if (matchIpv6Cidr(normalized, cleanEntry)) return true;
      } else {
        if (matchIpv4Cidr(normalized, cleanEntry)) return true;
      }
    } else {
      if (normalizeIp(cleanEntry) === normalized) return true;
    }
  }
  return false;
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
    const trustedList = (Array.isArray(trustProxy) ? trustProxy : [trustProxy]).map(s => s.trim()).filter(Boolean);
    if (!isIpTrusted(directIp, trustedList)) {
      return directIp;
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i];
      if (!isIpTrusted(candidate, trustedList)) {
        return isValidIp(candidate) ? candidate : directIp;
      }
    }
    return isValidIp(entries[0]) ? entries[0] : directIp;
  }

  return directIp;
}
