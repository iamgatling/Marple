import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { createDashboardMiddleware } from '../dist/dashboard.js';
import { createTestServer } from './helpers/server.js';
import { makeRequest } from './helpers/request.js';

describe('Dashboard Route Hardening, Boundaries, & Security Headers', () => {
  let serverHelper;
  let lastUsersQuery = null;

  const mockStorage = {
    writeEvent: async () => {},
    getOverview: async (opts) => ({ totalEvents: 10, ...opts }),
    getUsers: async (opts) => {
      lastUsersQuery = opts;
      return { users: [], total: 0 };
    },
    getUserProfile: async (id) => (id === 'valid_user' ? { user: { id }, events: [] } : null),
    getFunnel: async () => [],
    getEvents: async () => ({ events: [], trend: [] }),
    getConversions: async () => null,
    getCohorts: async () => [],
    getPublicConfig: async () => ({ storage: 'memory' }),
    config: {}
  };

  before(async () => {
    const app = express();
    app.use(createDashboardMiddleware({
      authenticate: (req) => req.headers['x-auth'] === 'valid',
      storage: mockStorage,
      config: {}
    }));
    serverHelper = await createTestServer(app);
  });

  after(async () => {
    if (serverHelper) await serverHelper.close();
  });

  describe('HTTP Method Enforcement & 405 Headers', () => {
    test('/collect rejects GET with 405 and Allow: POST', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/collect`, { method: 'GET' });
      assert.strictEqual(res.status, 405);
      assert.strictEqual(res.headers['allow'], 'POST');
      assert.strictEqual(res.json().code, 'METHOD_NOT_ALLOWED');
    });

    test('/client.js rejects POST with 405 and Allow: GET, HEAD', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/client.js`, { method: 'POST' });
      assert.strictEqual(res.status, 405);
      assert.strictEqual(res.headers['allow'], 'GET, HEAD');
      assert.strictEqual(res.json().code, 'METHOD_NOT_ALLOWED');
    });

    test('/ rejects POST with 405 and Allow: GET, HEAD', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/`, {
        method: 'POST',
        headers: { 'x-auth': 'valid' }
      });
      assert.strictEqual(res.status, 405);
      assert.strictEqual(res.headers['allow'], 'GET, HEAD');
    });

    test('/api/funnel rejects GET with 405 and Allow: POST', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/api/funnel`, {
        method: 'GET',
        headers: { 'x-auth': 'valid' }
      });
      assert.strictEqual(res.status, 405);
      assert.strictEqual(res.headers['allow'], 'POST');
    });

    test('/api/overview rejects POST with 405 and Allow: GET, HEAD', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/api/overview`, {
        method: 'POST',
        headers: { 'x-auth': 'valid' }
      });
      assert.strictEqual(res.status, 405);
      assert.strictEqual(res.headers['allow'], 'GET, HEAD');
    });

    test('/client.js accepts HEAD and returns no body', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/client.js`, { method: 'HEAD' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['content-type'], 'application/javascript');
      assert.strictEqual(res.body, '');
    });
  });

  describe('Security Headers', () => {
    test('responses include X-Content-Type-Options: nosniff and X-Frame-Options: SAMEORIGIN', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/`);
      assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
      assert.strictEqual(res.headers['x-frame-options'], 'SAMEORIGIN');
    });
  });

  describe('Parameter Clamping and Validation', () => {
    test('/api/users clamps limit to 1..100 and offset >= 0', async () => {
      await makeRequest(`${serverHelper.baseUrl}/api/users?limit=500&offset=-20`, {
        headers: { 'x-auth': 'valid' }
      });
      assert.strictEqual(lastUsersQuery.limit, 100);
      assert.strictEqual(lastUsersQuery.offset, 0);

      await makeRequest(`${serverHelper.baseUrl}/api/users?limit=-10`, {
        headers: { 'x-auth': 'valid' }
      });
      assert.strictEqual(lastUsersQuery.limit, 1);
    });

    test('/api/overview rejects invalid date ranges with 400', async () => {
      const res1 = await makeRequest(`${serverHelper.baseUrl}/api/overview?since=not-date`, {
        headers: { 'x-auth': 'valid' }
      });
      assert.strictEqual(res1.status, 400);
      assert.strictEqual(res1.json().code, 'INVALID_DATE');

      const res2 = await makeRequest(`${serverHelper.baseUrl}/api/overview?since=2026-05-01&until=2026-01-01`, {
        headers: { 'x-auth': 'valid' }
      });
      assert.strictEqual(res2.status, 400);
      assert.strictEqual(res2.json().code, 'INVALID_DATE_RANGE');
    });

    test('/api/overview rejects oversized goal string with 400', async () => {
      const longGoal = 'g'.repeat(300);
      const res = await makeRequest(`${serverHelper.baseUrl}/api/overview?goal=${longGoal}`, {
        headers: { 'x-auth': 'valid' }
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.json().code, 'INVALID_GOAL');
    });

    test('/api/users/:id validates user id', async () => {
      const longId = 'u'.repeat(300);
      const res = await makeRequest(`${serverHelper.baseUrl}/api/users/${longId}`, {
        headers: { 'x-auth': 'valid' }
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.json().code, 'INVALID_USER_ID');
    });
  });
});
