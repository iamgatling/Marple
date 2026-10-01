import { describe, test } from 'node:test';
import assert from 'node:assert';
import { marple } from '../dist/index.js';
import openSqliteStorage from '../dist/drivers/sqlite.js';
import { createTempDbPath, cleanupDb, seedTestDb, openTestDb } from './helpers/db.js';

describe('Data Retention & Startup Rollup', () => {
  test('rejects invalid retention options before opening storage', async () => {
    await assert.rejects(
      async () => {
        await marple.init({
          retention: { keepRawEventsDays: -1 }
        });
      },
      /Invalid retention\.keepRawEventsDays/
    );

    await assert.rejects(
      async () => {
        await marple.init({
          retention: { keepRollupsDays: 'one-year' }
        });
      },
      /Invalid retention\.keepRollupsDays/
    );
  });

  test('startup rollup runs automatically on init when enabled', async () => {
    const dbPath = createTempDbPath('startup-rollup-enabled');
    try {
      const oldDate = new Date(Date.now() - 40 * 86400000).toISOString();
      const storage = await openSqliteStorage({ sqlitePath: dbPath });
      await storage.writeEvent({ event_type: 'pageview', timestamp: oldDate });

      const checkBefore = openTestDb(dbPath);
      const countBefore = (await checkBefore.get('SELECT COUNT(*) as c FROM events')).c;
      await checkBefore.close();
      assert.strictEqual(countBefore, 1);

      await marple.init({
        storage: 'sqlite',
        sqlitePath: dbPath,
        retention: { keepRawEventsDays: 30, autoRollup: true }
      });

      const checkAfter = openTestDb(dbPath);
      const countAfter = (await checkAfter.get('SELECT COUNT(*) as c FROM events')).c;
      const aggCount = (await checkAfter.get('SELECT SUM(value) as s FROM aggregated_metrics WHERE metric = "pageviews"')).s;
      await checkAfter.close();

      assert.strictEqual(countAfter, 0);
      assert.strictEqual(aggCount, 1);
    } finally {
      cleanupDb(dbPath);
    }
  });

  test('startup rollup is skipped when autoRollup is false', async () => {
    const dbPath = createTempDbPath('startup-rollup-disabled');
    try {
      const oldDate = new Date(Date.now() - 40 * 86400000).toISOString();
      const storage = await openSqliteStorage({ sqlitePath: dbPath });
      await storage.writeEvent({ event_type: 'pageview', timestamp: oldDate });

      await marple.init({
        storage: 'sqlite',
        sqlitePath: dbPath,
        retention: { keepRawEventsDays: 30, autoRollup: false }
      });

      const check = openTestDb(dbPath);
      const remainingEvents = (await check.get('SELECT COUNT(*) as c FROM events')).c;
      await check.close();

      assert.strictEqual(remainingEvents, 1);
    } finally {
      cleanupDb(dbPath);
    }
  });

  test('rollup is idempotent and avoids double-counting', async () => {
    const dbPath = createTempDbPath('rollup-idempotent');
    try {
      const storage = await openSqliteStorage({ sqlitePath: dbPath });
      const oldDate = new Date(Date.now() - 40 * 86400000).toISOString();

      await storage.writeEvent({ event_type: 'pageview', timestamp: oldDate });
      await storage.writeEvent({ event_type: 'pageview', timestamp: oldDate });
      await storage.writeEvent({ event_type: 'click', timestamp: oldDate });

      await storage.runRollup({ keepRawEventsDays: 30 });

      const check1 = openTestDb(dbPath);
      const pv1 = (await check1.get('SELECT SUM(value) as s FROM aggregated_metrics WHERE metric = "pageviews"')).s;
      const click1 = (await check1.get('SELECT SUM(value) as s FROM aggregated_metrics WHERE metric = "click"')).s;
      await check1.close();

      assert.strictEqual(pv1, 2);
      assert.strictEqual(click1, 1);

      // Run rollup a second time with no new events
      await storage.runRollup({ keepRawEventsDays: 30 });

      const check2 = openTestDb(dbPath);
      const pv2 = (await check2.get('SELECT SUM(value) as s FROM aggregated_metrics WHERE metric = "pageviews"')).s;
      const click2 = (await check2.get('SELECT SUM(value) as s FROM aggregated_metrics WHERE metric = "click"')).s;
      await check2.close();

      assert.strictEqual(pv2, 2);
      assert.strictEqual(click2, 1);
    } finally {
      cleanupDb(dbPath);
    }
  });

  test('stale sessions pruned and active sessions retained', async () => {
    const dbPath = createTempDbPath('sessions-prune');
    try {
      const storage = await openSqliteStorage({ sqlitePath: dbPath });
      const staleTime = new Date(Date.now() - 45 * 86400000).toISOString();
      const activeTime = new Date(Date.now() - 2 * 86400000).toISOString();

      await seedTestDb(dbPath, {
        sessions: [
          { id: 'stale_ses', started_at: staleTime, last_seen_at: staleTime },
          { id: 'active_ses', started_at: activeTime, last_seen_at: activeTime }
        ]
      });

      await storage.runRollup({ keepRawEventsDays: 30 });

      const check = openTestDb(dbPath);
      const staleCount = (await check.get('SELECT COUNT(*) as c FROM sessions WHERE id = "stale_ses"')).c;
      const activeCount = (await check.get('SELECT COUNT(*) as c FROM sessions WHERE id = "active_ses"')).c;
      await check.close();

      assert.strictEqual(staleCount, 0);
      assert.strictEqual(activeCount, 1);
    } finally {
      cleanupDb(dbPath);
    }
  });

  test('stale users pruned, active users retained, and mixed user-activity handled', async () => {
    const dbPath = createTempDbPath('users-prune');
    try {
      const storage = await openSqliteStorage({ sqlitePath: dbPath });
      const oldTime = new Date(Date.now() - 50 * 86400000).toISOString();
      const recentTime = new Date(Date.now() - 2 * 86400000).toISOString();

      await seedTestDb(dbPath, {
        users: [
          { id: 'stale_no_events', first_seen: oldTime, last_seen: oldTime },
          { id: 'active_user', first_seen: recentTime, last_seen: recentTime },
          { id: 'stale_last_seen_but_retained_event', first_seen: oldTime, last_seen: oldTime }
        ],
        events: [
          { event_type: 'login', user_id: 'stale_last_seen_but_retained_event', timestamp: recentTime }
        ]
      });

      await storage.runRollup({ keepRawEventsDays: 30 });

      const check = openTestDb(dbPath);
      const staleUserCount = (await check.get('SELECT COUNT(*) as c FROM users WHERE id = "stale_no_events"')).c;
      const activeUserCount = (await check.get('SELECT COUNT(*) as c FROM users WHERE id = "active_user"')).c;
      const mixedUserCount = (await check.get('SELECT COUNT(*) as c FROM users WHERE id = "stale_last_seen_but_retained_event"')).c;
      await check.close();

      assert.strictEqual(staleUserCount, 0, 'Orphaned stale user should be pruned');
      assert.strictEqual(activeUserCount, 1, 'Active user should be retained');
      assert.strictEqual(mixedUserCount, 1, 'User with retained active event should be kept');
    } finally {
      cleanupDb(dbPath);
    }
  });

  test('transaction rolls back on failure without partial data deletion', async () => {
    const dbPath = createTempDbPath('rollback-failure');
    try {
      const storage = await openSqliteStorage({ sqlitePath: dbPath });
      const oldDate = new Date(Date.now() - 40 * 86400000).toISOString();
      await storage.writeEvent({ event_type: 'pageview', timestamp: oldDate });

      // Trigger a failure by temporarily corrupting or locking aggregated_metrics
      const testDb = openTestDb(dbPath);
      await testDb.run('DROP TABLE aggregated_metrics');
      await testDb.close();

      await assert.rejects(
        async () => {
          await storage.runRollup({ keepRawEventsDays: 30 });
        },
        /no such table: aggregated_metrics/
      );

      const checkDb = openTestDb(dbPath);
      const eventCount = (await checkDb.get('SELECT COUNT(*) as c FROM events')).c;
      await checkDb.close();

      assert.strictEqual(eventCount, 1, 'Raw event should not be deleted if rollup failed');
    } finally {
      cleanupDb(dbPath);
    }
  });
});
