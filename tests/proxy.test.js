import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { createDashboardMiddleware, RateLimiter } from '../dist/dashboard.js';
import { getClientIp, normalizeIp } from '../dist/proxy.js';
import { createTestServer } from './helpers/server.js';
import { makeRequest } from './helpers/request.js';

describe('Proxy Trust & Client IP Resolution', () => {
  describe('Unit: getClientIp & normalizeIp', () => {
    test('normalizes IPv4, IPv6, and IPv4-mapped IPv6', () => {
      assert.strictEqual(normalizeIp('::ffff:192.0.2.1'), '192.0.2.1');
      assert.strictEqual(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
      assert.strictEqual(normalizeIp('192.0.2.1:8080'), '192.0.2.1');
      assert.strictEqual(normalizeIp('[2001:db8::1]:8080'), '2001:db8::1');
      assert.strictEqual(normalizeIp('2001:0DB8::1'), '2001:0db8::1');
    });

    test('direct request with spoofed forwarded header ignores header by default', () => {
      const req = {
        headers: { 'x-forwarded-for': '198.51.100.1' },
        socket: { remoteAddress: '203.0.113.1' }
      };
      assert.strictEqual(getClientIp(req), '203.0.113.1');
      assert.strictEqual(getClientIp(req, { trustProxy: false }), '203.0.113.1');
    });

    test('trusted single proxy (trustProxy: 1 or true)', () => {
      const req = {
        headers: { 'x-forwarded-for': '203.0.113.50, 198.51.100.1' },
        socket: { remoteAddress: '10.0.0.1' }
      };
      assert.strictEqual(getClientIp(req, { trustProxy: 1 }), '198.51.100.1');
      assert.strictEqual(getClientIp(req, { trustProxy: true }), '198.51.100.1');
    });

    test('multiple proxy hops (trustProxy: 2)', () => {
      const req = {
        headers: { 'x-forwarded-for': '203.0.113.50, 198.51.100.1' },
        socket: { remoteAddress: '10.0.0.2' }
      };
      assert.strictEqual(getClientIp(req, { trustProxy: 2 }), '203.0.113.50');
    });

    test('incorrect hop count falls back safely', () => {
      const req = {
        headers: { 'x-forwarded-for': '203.0.113.50' },
        socket: { remoteAddress: '10.0.0.1' }
      };
      // Expecting 3 hops, but only 1 entry present in XFF
      assert.strictEqual(getClientIp(req, { trustProxy: 3 }), '10.0.0.1');
    });

    test('untrusted direct peer with allowlist', () => {
      const req = {
        headers: { 'x-forwarded-for': '203.0.113.50' },
        socket: { remoteAddress: '198.51.100.20' }
      };
      // 198.51.100.20 is not in the trusted proxy allowlist
      assert.strictEqual(getClientIp(req, { trustProxy: ['10.0.0.1', '10.0.0.2'] }), '198.51.100.20');
    });

    test('trusted direct peer with allowlist resolves client IP', () => {
      const req = {
        headers: { 'x-forwarded-for': '203.0.113.50, 10.0.0.2' },
        socket: { remoteAddress: '10.0.0.1' }
      };
      // 10.0.0.1 and 10.0.0.2 are trusted proxies; client is 203.0.113.50
      assert.strictEqual(getClientIp(req, { trustProxy: ['10.0.0.1', '10.0.0.2'] }), '203.0.113.50');
    });

    test('handles malformed forwarded header', () => {
      const req = {
        headers: { 'x-forwarded-for': 'invalid-ip, not-an-address, 999.999.999.999' },
        socket: { remoteAddress: '10.0.0.1' }
      };
      assert.strictEqual(getClientIp(req, { trustProxy: 1 }), '10.0.0.1');
    });

    test('trusted CIDR subnet resolves client IP and rejects untrusted peer outside subnet', () => {
      const trustedReq = {
        headers: { 'x-forwarded-for': '203.0.113.195' },
        socket: { remoteAddress: '10.240.0.5' }
      };
      assert.strictEqual(getClientIp(trustedReq, { trustProxy: ['10.0.0.0/8'] }), '203.0.113.195');

      const untrustedReq = {
        headers: { 'x-forwarded-for': '203.0.113.195' },
        socket: { remoteAddress: '192.168.1.100' }
      };
      assert.strictEqual(getClientIp(untrustedReq, { trustProxy: ['10.0.0.0/8'] }), '192.168.1.100');

      const ipv6CidrReq = {
        headers: { 'x-forwarded-for': '203.0.113.195' },
        socket: { remoteAddress: '2001:db8:abcd::1' }
      };
      assert.strictEqual(getClientIp(ipv6CidrReq, { trustProxy: ['2001:db8::/32'] }), '203.0.113.195');
    });
  });

  describe('Integration: Rate Limiting & Bounding', () => {
    let serverHelper;
    let storedEvents = [];

    before(async () => {
      const mockStorage = {
        writeEvent: async (ev) => { storedEvents.push(ev); },
        config: {}
      };

      const app = express();
      app.use(createDashboardMiddleware({
        authenticate: () => true,
        storage: mockStorage,
        config: { trustProxy: false }
      }));

      serverHelper = await createTestServer(app);
    });

    after(async () => {
      if (serverHelper) await serverHelper.close();
    });

    test('rotating-header rate-limit bypass attempt receives 429 with Retry-After', async () => {
      let hit429 = false;
      let retryAfterHeader = null;

      for (let i = 1; i <= 105; i++) {
        const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
          method: 'POST',
          headers: {
            'X-Forwarded-For': `203.0.113.${i}`
          },
          body: { event_type: 'test_event' }
        });

        if (res.status === 429) {
          hit429 = true;
          retryAfterHeader = res.headers['retry-after'];
          break;
        }
      }

      assert.strictEqual(hit429, true, 'Should hit 429 rate limit');
      assert.ok(retryAfterHeader, '429 response must include Retry-After header');
      assert.ok(parseInt(retryAfterHeader, 10) > 0, 'Retry-After should be a positive integer');
    });

    test('rate-limiter map size is strictly bounded under rotating attacker keys', () => {
      const limiter = new RateLimiter(100, 60000, 1000);
      for (let i = 1; i <= 3000; i++) {
        limiter.check(`198.51.100.${i}`);
      }
      assert.ok(limiter.size <= 1000, `Rate limiter size ${limiter.size} exceeded max capacity 1000`);
    });
  });
});
