import { test, describe } from 'node:test';
import assert from 'node:assert';
import { maskIp } from '../dist/storage.js';
import openSqliteStorage from '../dist/drivers/sqlite.js';
import { createTempDbPath, cleanupDb, openTestDb } from './helpers/db.js';

describe('IP Anonymization & Privacy (IPv4 /24 and IPv6 /48)', () => {
  describe('Unit: maskIp', () => {
    test('masks IPv4 addresses by zeroing the last octet (/24)', () => {
      assert.strictEqual(maskIp('192.168.1.42'), '192.168.1.0');
      assert.strictEqual(maskIp('10.0.0.254'), '10.0.0.0');
      assert.strictEqual(maskIp('172.16.50.123'), '172.16.50.0');
      assert.strictEqual(maskIp('127.0.0.1:8080'), '127.0.0.0');
    });

    test('masks IPv4-mapped IPv6 addresses to normalized IPv4 /24', () => {
      assert.strictEqual(maskIp('::ffff:192.168.1.42'), '192.168.1.0');
      assert.strictEqual(maskIp('[::ffff:10.0.0.1]:3000'), '10.0.0.0');
    });

    test('masks IPv6 addresses by zeroing the last 80 bits (/48 prefix)', () => {
      assert.strictEqual(
        maskIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334'),
        '2001:db8:85a3::'
      );
      assert.strictEqual(maskIp('2001:db8:85a3::1'), '2001:db8:85a3::');
      assert.strictEqual(maskIp('2001:db8::1'), '2001:db8::');
      assert.strictEqual(maskIp('fe80::1ff:fe23:4567:890a'), 'fe80::');
      assert.strictEqual(maskIp('::1'), '::');
      assert.strictEqual(maskIp('[2001:db8:abcd::1]:443'), '2001:db8:abcd::');
    });

    test('handles empty or null values safely', () => {
      assert.strictEqual(maskIp(null), null);
      assert.strictEqual(maskIp(undefined), null);
      assert.strictEqual(maskIp(''), null);
    });
  });

  describe('Integration: Driver IP Masking on Event Write', () => {
    test('SQLite driver writes masked IP addresses to events table', async () => {
      const dbPath = createTempDbPath('mask-ip-test');
      try {
        const storage = await openSqliteStorage({ sqlitePath: dbPath });
        await storage.writeEvent({
          event_type: 'v4_event',
          ip: '203.0.113.195'
        });
        await storage.writeEvent({
          event_type: 'v6_event',
          ip: '2001:db8:cafe:1234::99'
        });

        const testDb = openTestDb(dbPath);
        const rows = await testDb.all('SELECT event_type, ip FROM events ORDER BY id ASC');
        await testDb.close();

        assert.strictEqual(rows.length, 2);
        assert.strictEqual(rows[0].ip, '203.0.113.0');
        assert.strictEqual(rows[1].ip, '2001:db8:cafe::');
      } finally {
        cleanupDb(dbPath);
      }
    });
  });
});
