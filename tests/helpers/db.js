import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sqlite3 = require('sqlite3').verbose();

export function createTempDbPath(prefix = 'marple-test') {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return path.join(os.tmpdir(), `${prefix}-${unique}.sqlite`);
}

export function cleanupDb(dbPath) {
  if (!dbPath) return;
  const files = [
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
    `${dbPath}-journal`
  ];
  for (const f of files) {
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
      }
    } catch {
      // Ignore file busy / not found errors during cleanup
    }
  }
}

export function openTestDb(dbPath) {
  const db = new sqlite3.Database(dbPath);

  const get = (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
  };

  const all = (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
  };

  const run = (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve(this);
      });
    });
  };

  const exec = (sql) => {
    return new Promise((resolve, reject) => {
      db.exec(sql, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  };

  const close = () => {
    return new Promise((resolve, reject) => {
      db.close((err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  };

  return { raw: db, get, all, run, exec, close };
}

export async function seedTestDb(dbPath, { events = [], sessions = [], users = [], metrics = [] } = {}) {
  const testDb = openTestDb(dbPath);
  try {
    for (const ev of events) {
      await testDb.run(
        `INSERT INTO events(event_type, session_id, user_id, url, referrer, properties, ip, ua, country, browser, device_type, timestamp, utm_source, utm_medium, utm_campaign, utm_term, utm_content)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ev.event_type || 'test_event',
          ev.session_id || null,
          ev.user_id || null,
          ev.url || null,
          ev.referrer || null,
          JSON.stringify(ev.properties || {}),
          ev.ip || null,
          ev.ua || null,
          ev.country || null,
          ev.browser || null,
          ev.device_type || null,
          ev.timestamp || new Date().toISOString(),
          ev.utm_source || null,
          ev.utm_medium || null,
          ev.utm_campaign || null,
          ev.utm_term || null,
          ev.utm_content || null
        ]
      );
    }

    for (const ses of sessions) {
      await testDb.run(
        `INSERT INTO sessions(id, user_id, started_at, last_seen_at, referrer, landing_page, country, browser, device_type, ip, ua, is_active)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ses.id,
          ses.user_id || null,
          ses.started_at || new Date().toISOString(),
          ses.last_seen_at || new Date().toISOString(),
          ses.referrer || null,
          ses.landing_page || null,
          ses.country || null,
          ses.browser || null,
          ses.device_type || null,
          ses.ip || null,
          ses.ua || null,
          ses.is_active !== undefined ? ses.is_active : 1
        ]
      );
    }

    for (const u of users) {
      await testDb.run(
        `INSERT INTO users(id, first_seen, last_seen, country, browser, device_type, properties)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
        [
          u.id,
          u.first_seen || new Date().toISOString(),
          u.last_seen || new Date().toISOString(),
          u.country || null,
          u.browser || null,
          u.device_type || null,
          JSON.stringify(u.properties || {})
        ]
      );
    }

    for (const m of metrics) {
      await testDb.run(
        `INSERT INTO aggregated_metrics(date, metric, dimension, value)
         VALUES(?, ?, ?, ?)`,
        [
          m.date,
          m.metric,
          m.dimension !== undefined ? m.dimension : null,
          m.value !== undefined ? m.value : 0
        ]
      );
    }
  } finally {
    await testDb.close();
  }
}
