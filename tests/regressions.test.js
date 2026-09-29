import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { marple } from '../dist/index.js';
import openSqliteStorage from '../dist/drivers/sqlite.js';
import { createDashboardMiddleware } from '../dist/dashboard.js';
import { createTestServer } from './helpers/server.js';
import { makeRequest, sendChunkedRequest } from './helpers/request.js';
import { createTempDbPath, cleanupDb, openTestDb, seedTestDb } from './helpers/db.js';

describe('Regression Baseline for Known Defects', () => {
  describe('Defect 1: Oversized multi-chunk /collect bodies', () => {
    let serverHelper;
    let writtenEvents;

    before(async () => {
      writtenEvents = [];
      const mockStorage = {
        writeEvent: async (ev) => { writtenEvents.push(ev); },
        config: {}
      };

      const app = express();
      app.use(express.json()); // Typical production configuration
      app.use(createDashboardMiddleware({
        authenticate: () => true,
        storage: mockStorage,
        config: {}
      }));

      serverHelper = await createTestServer(app);
    });

    after(async () => {
      if (serverHelper) await serverHelper.close();
    });

    test('oversized multi-chunk /collect body returns 413 when express.json is active', async () => {
      // Build a payload larger than 64KB (e.g. 70KB)
      const largePayload = {
        event_type: 'oversized_chunked_event',
        properties: { padding: 'a'.repeat(70 * 1024) }
      };
      const jsonStr = JSON.stringify(largePayload);
      const half = Math.floor(jsonStr.length / 2);
      const chunks = [jsonStr.slice(0, half), jsonStr.slice(half)];

      const res = await sendChunkedRequest(`${serverHelper.baseUrl}/collect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        chunks
      });

      assert.strictEqual(
        res.status,
        413,
        `Expected 413 Payload Too Large for >64KB multi-chunk payload, got ${res.status}`
      );
      assert.strictEqual(writtenEvents.length, 0, 'No event should be stored for oversized body');
    });
  });

  describe('Defect 2: Forwarded-IP rate-limit bypass', () => {
    let serverHelper;

    before(async () => {
      const mockStorage = {
        writeEvent: async () => {},
        config: {}
      };

      const app = express();
      app.use(createDashboardMiddleware({
        authenticate: () => true,
        storage: mockStorage,
        config: {}
      }));

      serverHelper = await createTestServer(app);
    });

    after(async () => {
      if (serverHelper) await serverHelper.close();
    });

    test('forwarded-IP header spoofing does not bypass rate limit', async () => {
      let hitRateLimit = false;
      // Send 105 requests from the same connection/client with rotating spoofed X-Forwarded-For
      for (let i = 1; i <= 105; i++) {
        const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
          method: 'POST',
          headers: {
            'X-Forwarded-For': `198.51.100.${i}`
          },
          body: { event_type: 'rate_limit_bypass_attempt' }
        });
        if (res.status === 429) {
          hitRateLimit = true;
          break;
        }
      }

      assert.strictEqual(
        hitRateLimit,
        true,
        'Requests exceeding limit should receive 429 Too Many Requests even with rotating X-Forwarded-For'
      );
    });
  });

  describe('Defect 3: Missing startup rollup', () => {
    test('marple.init executes startup rollup when autoRollup is true', async () => {
      const dbPath = createTempDbPath('missing-startup-rollup');
      try {
        const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString();
        // Initialize schema and write an event older than retention window
        const initStorage = await openSqliteStorage({ sqlitePath: dbPath });
        await initStorage.writeEvent({ event_type: 'old_pageview', timestamp: fortyDaysAgo });

        const verifyDb = openTestDb(dbPath);
        const beforeCount = (await verifyDb.get('SELECT COUNT(*) as c FROM events')).c;
        await verifyDb.close();
        assert.strictEqual(beforeCount, 1);

        // Re-initialize with marple.init() where autoRollup is true
        await marple.init({
          storage: 'sqlite',
          sqlitePath: dbPath,
          retention: { keepRawEventsDays: 30, keepRollupsDays: 365, autoRollup: true }
        });

        const checkDb = openTestDb(dbPath);
        const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
        const remainingOldEvents = (await checkDb.get('SELECT COUNT(*) as c FROM events WHERE timestamp < ?', [cutoff])).c;
        await checkDb.close();

        assert.strictEqual(
          remainingOldEvents,
          0,
          `Expected 0 old events remaining after startup rollup, found ${remainingOldEvents}`
        );
      } finally {
        cleanupDb(dbPath);
      }
    });
  });

  describe('Defect 4: Stale users and sessions remaining', () => {
    test('runRollup prunes stale users and sessions older than retention cutoff', async () => {
      const dbPath = createTempDbPath('stale-users-sessions');
      try {
        const storage = await openSqliteStorage({ sqlitePath: dbPath });
        const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString();

        await seedTestDb(dbPath, {
          users: [
            { id: 'stale_user_1', first_seen: fortyDaysAgo, last_seen: fortyDaysAgo }
          ],
          sessions: [
            { id: 'stale_session_1', user_id: 'stale_user_1', started_at: fortyDaysAgo, last_seen_at: fortyDaysAgo }
          ]
        });

        await storage.runRollup({ keepRawEventsDays: 30, keepRollupsDays: 365 });

        const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
        const testDb = openTestDb(dbPath);
        const staleUsers = (await testDb.get('SELECT COUNT(*) as c FROM users WHERE last_seen < ?', [cutoff])).c;
        const staleSessions = (await testDb.get('SELECT COUNT(*) as c FROM sessions WHERE last_seen_at < ?', [cutoff])).c;
        await testDb.close();

        assert.strictEqual(staleUsers, 0, `Expected 0 stale users after rollup, found ${staleUsers}`);
        assert.strictEqual(staleSessions, 0, `Expected 0 stale sessions after rollup, found ${staleSessions}`);
      } finally {
        cleanupDb(dbPath);
      }
    });
  });

  describe('Defect 5: Reversed funnel order', () => {
    test('funnel analysis respects chronological order and rejects reversed steps', async () => {
      const dbPath = createTempDbPath('reversed-funnel');
      try {
        const storage = await openSqliteStorage({ sqlitePath: dbPath });

        // Seed a session where Step 2 (purchase) happened at 10:00, but Step 1 (signup) happened at 11:00
        await seedTestDb(dbPath, {
          events: [
            { session_id: 'ses_rev_1', event_type: 'purchase', timestamp: '2026-01-01T10:00:00.000Z' },
            { session_id: 'ses_rev_1', event_type: 'signup', timestamp: '2026-01-01T11:00:00.000Z' }
          ]
        });

        const results = await storage.getFunnel([
          { type: 'custom', value: 'signup' },
          { type: 'custom', value: 'purchase' }
        ]);

        assert.strictEqual(results.length, 2);
        assert.strictEqual(results[0].count, 1, 'First step (signup) should have count 1');
        assert.strictEqual(
          results[1].count,
          0,
          `Second step (purchase) occurred before signup; expected count 0, got ${results[1].count}`
        );
      } finally {
        cleanupDb(dbPath);
      }
    });
  });

  describe('Defect 6: Ignored funnel date ranges', () => {
    test('funnel analysis filters events by date range (since/until)', async () => {
      const dbPath = createTempDbPath('funnel-date-ranges');
      try {
        const storage = await openSqliteStorage({ sqlitePath: dbPath });

        // Seed valid sequential funnel events on 2026-01-15
        await seedTestDb(dbPath, {
          events: [
            { session_id: 'ses_jan_1', event_type: 'step_a', timestamp: '2026-01-15T10:00:00.000Z' },
            { session_id: 'ses_jan_1', event_type: 'step_b', timestamp: '2026-01-15T10:05:00.000Z' }
          ]
        });

        // Query funnel with date range in February 2026
        const results = await storage.getFunnel(
          [
            { type: 'custom', value: 'step_a' },
            { type: 'custom', value: 'step_b' }
          ],
          { since: '2026-02-01T00:00:00.000Z', until: '2026-02-28T23:59:59.999Z' }
        );

        assert.strictEqual(
          results[0].count,
          0,
          `Expected 0 counts for step_a when querying February, got ${results[0].count}`
        );
        assert.strictEqual(
          results[1].count,
          0,
          `Expected 0 counts for step_b when querying February, got ${results[1].count}`
        );
      } finally {
        cleanupDb(dbPath);
      }
    });
  });

  describe('Defect 7: Unused CLI configuration', () => {
    test('marple.init automatically loads marple.config.js from working directory', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marple-cli-conf-'));
      const configPath = path.join(tempDir, 'marple.config.js');
      const customDbPath = path.join(tempDir, 'custom-cli.sqlite');

      try {
        fs.writeFileSync(
          configPath,
          `export default {
            storage: 'sqlite',
            sqlitePath: '${customDbPath}',
            retention: { keepRawEventsDays: 77, keepRollupsDays: 777, autoRollup: false }
          };\n`
        );

        const origCwd = process.cwd();
        process.chdir(tempDir);
        try {
          const { config } = await marple.init();
          assert.strictEqual(
            config.retention?.keepRawEventsDays,
            77,
            `Expected keepRawEventsDays: 77 from marple.config.js, got ${config.retention?.keepRawEventsDays}`
          );
        } finally {
          process.chdir(origCwd);
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Defect 8: CommonJS import failure', () => {
    test('marple exports can be required via CommonJS require', async () => {
      const { spawnSync } = await import('node:child_process');
      const script = `
        const m = require('.');
        if (typeof m.init !== 'function' && typeof m.default?.init !== 'function') {
          process.exit(2);
        }
      `;

      const result = spawnSync(process.execPath, ['--no-experimental-require-module', '-e', script], {
        cwd: process.cwd(),
        encoding: 'utf8'
      });

      assert.strictEqual(
        result.status,
        0,
        `CommonJS require failed (exit code ${result.status}): ${result.stderr || result.stdout}`
      );
    });
  });
});
