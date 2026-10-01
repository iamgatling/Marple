import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { createDashboardMiddleware } from '../dist/dashboard.js';
import { createTestServer } from './helpers/server.js';
import { makeRequest } from './helpers/request.js';
import { createTempDbPath, cleanupDb, openTestDb, seedTestDb } from './helpers/db.js';
import openSqliteStorage from '../dist/drivers/sqlite.js';

describe('API Contract & Validation Test Suite', () => {
  describe('Malformed Payloads', () => {
    let serverHelper;
    let writtenEvents;

    before(async () => {
      writtenEvents = [];
      const mockStorage = {
        writeEvent: async (ev) => { writtenEvents.push(ev); },
        getFunnel: async (steps) => {
          if (!steps || steps.length < 2) return [];
          return steps.map((s) => ({ step: s.value, count: 0, dropoff: 0 }));
        },
        config: {}
      };

      const app = express();
      app.use(createDashboardMiddleware({
        authenticate: (req) => req.headers['x-auth'] === 'valid-secret',
        storage: mockStorage,
        config: {}
      }));

      serverHelper = await createTestServer(app);
    });

    after(async () => {
      if (serverHelper) await serverHelper.close();
    });

    test('/collect returns 400 when body contains invalid JSON syntax', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"event_type": "broken_json", properties: {unterminated'
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(writtenEvents.length, 0);
    });

    test('/collect rejects non-event payloads without event_type with 400', async () => {
      writtenEvents.length = 0;
      const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
        method: 'POST',
        body: { user_id: 'some_user', irrelevant: 'data' }
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(writtenEvents.length, 0);
    });

    test('/collect rejects non-object primitives with 400', async () => {
      writtenEvents.length = 0;
      const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '12345'
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(writtenEvents.length, 0);
    });

    test('/api/funnel returns empty array when steps length is less than 2', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/api/funnel`, {
        method: 'POST',
        headers: { 'x-auth': 'valid-secret' },
        body: { steps: [{ type: 'pageview', value: '/home' }] }
      });
      assert.strictEqual(res.status, 200);
      const data = res.json();
      assert.deepStrictEqual(data, []);
    });

    test('/api/funnel returns 500 when request body is malformed JSON', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/api/funnel`, {
        method: 'POST',
        headers: {
          'x-auth': 'valid-secret',
          'Content-Type': 'application/json'
        },
        body: '{ malformed JSON for funnel'
      });
      assert.strictEqual(res.status, 500);
      const data = res.json();
      assert(data.error);
    });
  });

  describe('Method Handling', () => {
    let serverHelper;
    let writtenEvents;

    before(async () => {
      writtenEvents = [];
      const mockStorage = {
        writeEvent: async (ev) => { writtenEvents.push(ev); },
        getOverview: async () => ({ totalEvents: 0, uniqueSessions: 0, uniqueUsers: 0, activeNow: 0 }),
        config: {}
      };

      const app = express();
      app.use(createDashboardMiddleware({
        authenticate: (req) => req.headers['x-auth'] === 'valid-secret',
        storage: mockStorage,
        config: {}
      }));

      serverHelper = await createTestServer(app);
    });

    after(async () => {
      if (serverHelper) await serverHelper.close();
    });

    test('GET on /collect does not trigger event ingestion and returns 405', async () => {
      writtenEvents.length = 0;
      const res = await makeRequest(`${serverHelper.baseUrl}/collect?event_type=get_leak`, {
        method: 'GET'
      });
      assert.strictEqual(res.status, 405);
      assert.strictEqual(res.headers['allow'], 'POST');
      assert.strictEqual(writtenEvents.length, 0, 'GET query params should not be ingested as events');
    });

    test('PUT on /collect without valid event does not trigger event ingestion and returns 405', async () => {
      writtenEvents.length = 0;
      const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
        method: 'PUT',
        body: {}
      });
      assert.strictEqual(res.status, 405);
      assert.strictEqual(res.headers['allow'], 'POST');
      assert.strictEqual(writtenEvents.length, 0);
    });

    test('DELETE on /collect does not trigger event ingestion and returns 405', async () => {
      writtenEvents.length = 0;
      const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
        method: 'DELETE'
      });
      assert.strictEqual(res.status, 405);
      assert.strictEqual(res.headers['allow'], 'POST');
      assert.strictEqual(writtenEvents.length, 0);
    });
  });

  describe('Pagination', () => {
    let dbPath;
    let serverHelper;
    let storage;

    before(async () => {
      dbPath = createTempDbPath('contracts-pagination');
      storage = await openSqliteStorage({ sqlitePath: dbPath });

      // Seed 12 users
      const users = [];
      for (let i = 1; i <= 12; i++) {
        const pad = String(i).padStart(2, '0');
        users.push({
          id: `user_${pad}`,
          first_seen: `2026-01-01T10:${pad}:00.000Z`,
          last_seen: `2026-01-01T12:${pad}:00.000Z`,
          country: 'US',
          browser: 'Chrome',
          device_type: 'Desktop'
        });
      }
      await seedTestDb(dbPath, { users });

      const app = express();
      app.use(createDashboardMiddleware({
        authenticate: () => true,
        storage,
        config: {}
      }));

      serverHelper = await createTestServer(app);
    });

    after(async () => {
      if (serverHelper) await serverHelper.close();
      cleanupDb(dbPath);
    });

    test('/api/users paginates with limit and offset correctly', async () => {
      const page1Res = await makeRequest(`${serverHelper.baseUrl}/api/users?limit=5&offset=0`);
      assert.strictEqual(page1Res.status, 200);
      const page1 = page1Res.json();
      assert.strictEqual(page1.total, 12);
      assert.strictEqual(page1.users.length, 5);
      assert.strictEqual(page1.users[0].id, 'user_12'); // ordered by last_seen DESC

      const page2Res = await makeRequest(`${serverHelper.baseUrl}/api/users?limit=5&offset=5`);
      assert.strictEqual(page2Res.status, 200);
      const page2 = page2Res.json();
      assert.strictEqual(page2.total, 12);
      assert.strictEqual(page2.users.length, 5);
      assert.notStrictEqual(page1.users[0].id, page2.users[0].id);

      const page3Res = await makeRequest(`${serverHelper.baseUrl}/api/users?limit=5&offset=10`);
      assert.strictEqual(page3Res.status, 200);
      const page3 = page3Res.json();
      assert.strictEqual(page3.total, 12);
      assert.strictEqual(page3.users.length, 2);
    });

    test('/api/users returns empty array when offset exceeds total', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/api/users?limit=5&offset=100`);
      assert.strictEqual(res.status, 200);
      const data = res.json();
      assert.strictEqual(data.total, 12);
      assert.strictEqual(data.users.length, 0);
    });

    test('/api/users falls back to defaults on non-numeric limit or offset', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/api/users?limit=invalid&offset=notanumber`);
      assert.strictEqual(res.status, 200);
      const data = res.json();
      assert.strictEqual(data.total, 12);
      assert.strictEqual(data.users.length, 12); // default limit is 50, all 12 returned
    });
  });

  describe('Error Responses', () => {
    let serverHelper;

    before(async () => {
      const mockStorage = {
        getUserProfile: async (id) => {
          if (id === 'existing_user') {
            return { user: { id: 'existing_user' }, events: [] };
          }
          return null;
        },
        config: {}
      };

      const app = express();
      app.use(createDashboardMiddleware({
        authenticate: (req) => req.headers['x-auth'] === 'valid-secret',
        storage: mockStorage,
        config: {}
      }));

      serverHelper = await createTestServer(app);
    });

    after(async () => {
      if (serverHelper) await serverHelper.close();
    });

    test('unauthenticated request to /api/overview returns 401 text/plain', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/api/overview`);
      assert.strictEqual(res.status, 401);
      assert(res.body.includes('Unauthorized'));
    });

    test('authenticated request to nonexistent API route returns 404 JSON', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/api/non_existent_subpath`, {
        headers: { 'x-auth': 'valid-secret' }
      });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.headers['content-type'], 'application/json');
      const data = res.json();
      assert.strictEqual(data.error, 'Not found');
    });

    test('authenticated request to nonexistent user profile returns 404 JSON', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/api/users/non_existent_user_999`, {
        headers: { 'x-auth': 'valid-secret' }
      });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.headers['content-type'], 'application/json');
      const data = res.json();
      assert.strictEqual(data.error, 'Not found');
    });
  });
});
