import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import openSqliteStorage from '../dist/drivers/sqlite.js';
import { createDashboardMiddleware } from '../dist/dashboard.js';
import { createTempDbPath, cleanupDb, seedTestDb } from './helpers/db.js';
import { createTestServer } from './helpers/server.js';
import { makeRequest } from './helpers/request.js';

describe('Chronological & Date-Bounded Funnels', () => {
  describe('Unit / Driver: SQLite Funnel Analysis', () => {
    test('correctly ordered steps count', async () => {
      const dbPath = createTempDbPath('funnel-ordered');
      try {
        const storage = await openSqliteStorage({ sqlitePath: dbPath });
        await seedTestDb(dbPath, {
          events: [
            { session_id: 's1', event_type: 'step_1', timestamp: '2026-03-01T10:00:00.000Z' },
            { session_id: 's1', event_type: 'step_2', timestamp: '2026-03-01T10:05:00.000Z' },
            { session_id: 's1', event_type: 'step_3', timestamp: '2026-03-01T10:10:00.000Z' }
          ]
        });

        const res = await storage.getFunnel([
          { type: 'custom', value: 'step_1' },
          { type: 'custom', value: 'step_2' },
          { type: 'custom', value: 'step_3' }
        ]);

        assert.strictEqual(res.length, 3);
        assert.strictEqual(res[0].count, 1);
        assert.strictEqual(res[1].count, 1);
        assert.strictEqual(res[2].count, 1);
      } finally {
        cleanupDb(dbPath);
      }
    });

    test('reversed steps do not count', async () => {
      const dbPath = createTempDbPath('funnel-reversed');
      try {
        const storage = await openSqliteStorage({ sqlitePath: dbPath });
        await seedTestDb(dbPath, {
          events: [
            { session_id: 's1', event_type: 'checkout', timestamp: '2026-03-01T09:00:00.000Z' },
            { session_id: 's1', event_type: 'landing', timestamp: '2026-03-01T10:00:00.000Z' }
          ]
        });

        const res = await storage.getFunnel([
          { type: 'custom', value: 'landing' },
          { type: 'custom', value: 'checkout' }
        ]);

        assert.strictEqual(res[0].count, 1);
        assert.strictEqual(res[1].count, 0, 'Step after landing should not match earlier checkout');
      } finally {
        cleanupDb(dbPath);
      }
    });

    test('different sessions do not combine', async () => {
      const dbPath = createTempDbPath('funnel-sessions');
      try {
        const storage = await openSqliteStorage({ sqlitePath: dbPath });
        await seedTestDb(dbPath, {
          events: [
            { session_id: 's1', event_type: 'step_a', timestamp: '2026-03-01T10:00:00.000Z' },
            { session_id: 's2', event_type: 'step_b', timestamp: '2026-03-01T10:05:00.000Z' }
          ]
        });

        const res = await storage.getFunnel([
          { type: 'custom', value: 'step_a' },
          { type: 'custom', value: 'step_b' }
        ]);

        assert.strictEqual(res[0].count, 1);
        assert.strictEqual(res[1].count, 0, 'Different sessions must not combine across steps');
      } finally {
        cleanupDb(dbPath);
      }
    });

    test('duplicate events follow first valid match after prior step', async () => {
      const dbPath = createTempDbPath('funnel-duplicates');
      try {
        const storage = await openSqliteStorage({ sqlitePath: dbPath });
        await seedTestDb(dbPath, {
          events: [
            { session_id: 's1', event_type: 'browse', timestamp: '2026-03-01T10:00:00.000Z' },
            { session_id: 's1', event_type: 'browse', timestamp: '2026-03-01T10:10:00.000Z' },
            { session_id: 's1', event_type: 'cart', timestamp: '2026-03-01T10:15:00.000Z' }
          ]
        });

        const res = await storage.getFunnel([
          { type: 'custom', value: 'browse' },
          { type: 'custom', value: 'cart' }
        ]);

        assert.strictEqual(res[0].count, 1);
        assert.strictEqual(res[1].count, 1);
      } finally {
        cleanupDb(dbPath);
      }
    });

    test('events outside the requested range do not count', async () => {
      const dbPath = createTempDbPath('funnel-range');
      try {
        const storage = await openSqliteStorage({ sqlitePath: dbPath });
        await seedTestDb(dbPath, {
          events: [
            { session_id: 's1', event_type: 'a', timestamp: '2026-01-10T10:00:00.000Z' },
            { session_id: 's1', event_type: 'b', timestamp: '2026-01-10T10:05:00.000Z' }
          ]
        });

        const res = await storage.getFunnel(
          [
            { type: 'custom', value: 'a' },
            { type: 'custom', value: 'b' }
          ],
          { since: '2026-02-01T00:00:00.000Z', until: '2026-02-28T23:59:59.999Z' }
        );

        assert.strictEqual(res[0].count, 0);
        assert.strictEqual(res[1].count, 0);
      } finally {
        cleanupDb(dbPath);
      }
    });
  });

  describe('Integration: /api/funnel HTTP Validation & Ranges', () => {
    let serverHelper;
    let dbPath;

    before(async () => {
      dbPath = createTempDbPath('funnel-http');
      const storage = await openSqliteStorage({ sqlitePath: dbPath });

      await seedTestDb(dbPath, {
        events: [
          { session_id: 's_http_1', event_type: 'view_item', timestamp: '2026-03-15T12:00:00.000Z' },
          { session_id: 's_http_1', event_type: 'add_to_cart', timestamp: '2026-03-15T12:05:00.000Z' }
        ]
      });

      const app = express();
      app.use(createDashboardMiddleware({
        authenticate: () => true,
        storage,
        config: { storage: 'sqlite', sqlitePath: dbPath }
      }));

      serverHelper = await createTestServer(app);
    });

    after(async () => {
      if (serverHelper) await serverHelper.close();
      cleanupDb(dbPath);
    });

    test('returns 400 for invalid date ranges', async () => {
      const resInvalidSince = await makeRequest(`${serverHelper.baseUrl}/api/funnel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          steps: [{ type: 'custom', value: 'view_item' }],
          since: 'not-a-valid-date'
        }
      });
      assert.strictEqual(resInvalidSince.status, 400);

      const resReversedDates = await makeRequest(`${serverHelper.baseUrl}/api/funnel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          steps: [{ type: 'custom', value: 'view_item' }],
          since: '2026-05-01T00:00:00.000Z',
          until: '2026-04-01T00:00:00.000Z'
        }
      });
      assert.strictEqual(resReversedDates.status, 400);
    });

    test('returns 400 when steps is not an array', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/api/funnel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { steps: 'invalid' }
      });
      assert.strictEqual(res.status, 400);
    });

    test('succeeds with valid steps and date range', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/api/funnel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          steps: [
            { type: 'custom', value: 'view_item' },
            { type: 'custom', value: 'add_to_cart' }
          ],
          since: '2026-03-01T00:00:00.000Z',
          until: '2026-03-31T23:59:59.999Z'
        }
      });
      assert.strictEqual(res.status, 200);
      const data = res.json();
      assert.strictEqual(data.length, 2);
      assert.strictEqual(data[0].count, 1);
      assert.strictEqual(data[1].count, 1);
    });
  });
});
