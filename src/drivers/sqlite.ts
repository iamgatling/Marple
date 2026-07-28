import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import { parseBrowser, parseDevice, maskIp, getPublicConfig } from '../storage.js';
import {
  Driver,
  TrackEvent,
  OverviewOptions,
  OverviewData,
  UsersOptions,
  UsersData,
  UserProfileData,
  FunnelStep,
  FunnelStepResult,
  RollupConfig,
  MarpleConfig
} from '../types.js';

const require = createRequire(import.meta.url);

function tryParse(str: string): Record<string, any> {
  try { return JSON.parse(str); } catch { return {}; }
}

const SQLITE_SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,
  session_id  TEXT,
  user_id     TEXT,
  url         TEXT,
  referrer    TEXT,
  properties  TEXT DEFAULT '{}',
  ip          TEXT,
  ua          TEXT,
  country     TEXT,
  browser     TEXT,
  device_type TEXT,
  timestamp   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evt_ts  ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_evt_uid ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_evt_sid ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_evt_typ ON events(event_type);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  started_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  referrer     TEXT,
  landing_page TEXT,
  country      TEXT,
  browser      TEXT,
  device_type  TEXT,
  ip           TEXT,
  ua           TEXT,
  is_active    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ses_uid ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_ses_ts  ON sessions(started_at);

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  country     TEXT,
  browser     TEXT,
  device_type TEXT,
  properties  TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS aggregated_metrics (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  date      TEXT NOT NULL,
  metric    TEXT NOT NULL,
  dimension TEXT,
  value     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(date, metric, dimension)
);
CREATE INDEX IF NOT EXISTS idx_agg_date ON aggregated_metrics(date);
`;

function dbAll(db: any, sql: string, p: any[] = []): Promise<any[]> {
  return new Promise((res, rej) => db.all(sql, p, (e: Error | null, r: any[]) => e ? rej(e) : res(r || [])));
}
function dbGet(db: any, sql: string, p: any[] = []): Promise<any> {
  return new Promise((res, rej) => db.get(sql, p, (e: Error | null, r: any) => e ? rej(e) : res(r || null)));
}
function dbRun(db: any, sql: string, p: any[] = []): Promise<any> {
  return new Promise((res, rej) => db.run(sql, p, function(this: any, e: Error | null) { e ? rej(e) : res(this); }));
}

export default async function openSqliteStorage(config: MarpleConfig): Promise<Driver> {
  const sqlite3 = require('sqlite3').verbose();
  const filePath = path.resolve(config.sqlitePath || './marple.sqlite');
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const db = new sqlite3.Database(filePath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
  await new Promise<void>((res, rej) => db.exec(SQLITE_SCHEMA, (e: Error | null) => e ? rej(e) : res()));

  const cutoffDays = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
  const sinceDefault = () => cutoffDays(30);

  const storageObj: Driver = {
    async writeEvent(ev: TrackEvent): Promise<void> {
      const browser = parseBrowser(ev.ua || '');
      const device_type = parseDevice(ev.ua || '');
      const maskedIp = maskIp(ev.ip);
      await dbRun(db,
        `INSERT INTO events(event_type,session_id,user_id,url,referrer,properties,ip,ua,country,browser,device_type,timestamp)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ev.event_type, ev.session_id, ev.user_id, ev.url, ev.referrer,
         JSON.stringify(ev.properties || {}), maskedIp, ev.ua, ev.country,
         browser, device_type, ev.timestamp]
      );
      if (ev.session_id) {
        await dbRun(db,
          `INSERT INTO sessions(id,user_id,started_at,last_seen_at,referrer,landing_page,country,browser,device_type,ip,ua,is_active)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,1)
           ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at, is_active=1`,
          [ev.session_id, ev.user_id, ev.timestamp, ev.timestamp,
           ev.referrer, ev.url, ev.country, browser, device_type, maskedIp, ev.ua]
        );
      }
      if (ev.user_id) {
        await dbRun(db,
          `INSERT INTO users(id,first_seen,last_seen,country,browser,device_type)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen`,
          [ev.user_id, ev.timestamp, ev.timestamp, ev.country, browser, device_type]
        );
      }
    },

    async getOverview({ since }: OverviewOptions = {}): Promise<OverviewData> {
      const cutoff = since || sinceDefault();
      const [totals, active, topPages, topReferrers, browsers, devices, countries, dailyViews] = await Promise.all([
        dbGet(db, `SELECT COUNT(*) as te, COUNT(DISTINCT session_id) as us, COUNT(DISTINCT user_id) as uu FROM events WHERE timestamp>=?`, [cutoff]),
        dbGet(db, `SELECT COUNT(*) as n FROM sessions WHERE last_seen_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-5 minutes')`),
        dbAll(db, `SELECT url as page, COUNT(*) as views FROM events WHERE event_type='pageview' AND url IS NOT NULL AND timestamp>=? GROUP BY url ORDER BY views DESC LIMIT 10`, [cutoff]),
        dbAll(db, `SELECT referrer, COUNT(*) as count FROM events WHERE referrer IS NOT NULL AND referrer!='' AND timestamp>=? GROUP BY referrer ORDER BY count DESC LIMIT 10`, [cutoff]),
        dbAll(db, `SELECT browser, COUNT(*) as count FROM events WHERE timestamp>=? AND browser IS NOT NULL GROUP BY browser ORDER BY count DESC`, [cutoff]),
        dbAll(db, `SELECT device_type, COUNT(*) as count FROM events WHERE timestamp>=? AND device_type IS NOT NULL GROUP BY device_type ORDER BY count DESC`, [cutoff]),
        dbAll(db, `SELECT country, COUNT(*) as count FROM events WHERE timestamp>=? AND country IS NOT NULL AND country!='' GROUP BY country ORDER BY count DESC LIMIT 10`, [cutoff]),
        dbAll(db, `SELECT substr(timestamp,1,10) as date, COUNT(*) as views FROM events WHERE event_type='pageview' AND timestamp>=? GROUP BY date ORDER BY date ASC`, [cutoff]),
      ]);
      return {
        totalEvents: totals?.te || 0, uniqueSessions: totals?.us || 0,
        uniqueUsers: totals?.uu || 0, activeNow: active?.n || 0,
        topPages, topReferrers, browsers, devices, countries, dailyViews
      };
    },

    async getUsers({ limit = 50, offset = 0 }: UsersOptions = {}): Promise<UsersData> {
      const users = await dbAll(db,
        `SELECT u.id, u.first_seen, u.last_seen, u.country, u.browser, u.device_type, COUNT(e.id) as event_count
         FROM users u LEFT JOIN events e ON e.user_id=u.id GROUP BY u.id ORDER BY u.last_seen DESC LIMIT ? OFFSET ?`,
        [limit, offset]
      );
      const totalRow = await dbGet(db, `SELECT COUNT(*) as n FROM users`);
      const total = totalRow?.n || 0;
      return { users, total };
    },

    async getUserProfile(userId: string): Promise<UserProfileData | null> {
      const user = await dbGet(db, `SELECT * FROM users WHERE id=?`, [userId]);
      if (!user) return null;
      const events = await dbAll(db,
        `SELECT event_type, url, properties, timestamp FROM events WHERE user_id=? ORDER BY timestamp DESC LIMIT 100`,
        [userId]
      );
      return { user, events: events.map((e: any) => ({ ...e, properties: tryParse(e.properties) })) };
    },

    async getCohorts(): Promise<any[]> {
      return dbAll(db, `
        WITH base AS (
          SELECT id, strftime('%Y-W%W', first_seen) as cohort_week, first_seen FROM users
          ORDER BY first_seen DESC LIMIT 500
        ),
        act AS (
          SELECT b.id, b.cohort_week,
            CAST((julianday(s.started_at) - julianday(b.first_seen)) / 7 AS INTEGER) as week_num
          FROM base b JOIN sessions s ON s.user_id=b.id
          WHERE CAST((julianday(s.started_at) - julianday(b.first_seen)) / 7 AS INTEGER) BETWEEN 0 AND 8
        )
        SELECT cohort_week,
          (SELECT COUNT(DISTINCT id) FROM base WHERE cohort_week=act.cohort_week) as cohort_size,
          week_num, COUNT(DISTINCT id) as retained
        FROM act GROUP BY cohort_week, week_num ORDER BY cohort_week DESC, week_num ASC
      `);
    },

    async getEvents({ since }: OverviewOptions = {}): Promise<any> {
      const cutoff = since || sinceDefault();
      const prev = new Date(Date.now() - 60 * 86400000).toISOString();
      const [events, prevEvents, trend] = await Promise.all([
        dbAll(db, `SELECT event_type, COUNT(*) as count, COUNT(DISTINCT user_id) as unique_users FROM events WHERE timestamp>=? AND event_type!='pageview' GROUP BY event_type ORDER BY count DESC`, [cutoff]),
        dbAll(db, `SELECT event_type, COUNT(*) as count FROM events WHERE timestamp>=? AND timestamp<? AND event_type!='pageview' GROUP BY event_type`, [prev, cutoff]),
        dbAll(db, `SELECT event_type, substr(timestamp,1,10) as date, COUNT(*) as count FROM events WHERE timestamp>=? AND event_type!='pageview' GROUP BY event_type, date ORDER BY date ASC`, [cutoff]),
      ]);
      const prevMap = Object.fromEntries(prevEvents.map((e: any) => [e.event_type, e.count]));
      return { events: events.map((e: any) => ({ ...e, prev_count: prevMap[e.event_type] || 0 })), trend };
    },

    async getFunnel(steps: FunnelStep[]): Promise<FunnelStepResult[]> {
      if (!steps || steps.length < 2) return [];
      const results: FunnelStepResult[] = [];
      let prevCount: number | null = null;
      let sessionFilter = '';
      let filterParams: string[] = [];

      for (const step of steps) {
        let count: number;
        if (sessionFilter === '') {
          const row = step.type === 'pageview'
            ? await dbGet(db, `SELECT COUNT(DISTINCT session_id) as count FROM events WHERE event_type='pageview' AND url LIKE ?`, [`%${step.value}%`])
            : await dbGet(db, `SELECT COUNT(DISTINCT session_id) as count FROM events WHERE event_type=?`, [step.value]);
          count = row?.count || 0;
        } else {
          const row = step.type === 'pageview'
            ? await dbGet(db, `SELECT COUNT(DISTINCT session_id) as count FROM events WHERE event_type='pageview' AND url LIKE ? AND session_id IN (${sessionFilter})`, [`%${step.value}%`, ...filterParams])
            : await dbGet(db, `SELECT COUNT(DISTINCT session_id) as count FROM events WHERE event_type=? AND session_id IN (${sessionFilter})`, [step.value, ...filterParams]);
          count = row?.count || 0;
        }

        results.push({ step: step.label || step.value, count, dropoff: prevCount !== null ? Math.round((1 - count / (prevCount || 1)) * 100) : 0 });
        prevCount = count;

        if (step.type === 'pageview') {
          sessionFilter = sessionFilter === '' ? `SELECT session_id FROM events WHERE event_type='pageview' AND url LIKE ?` : `SELECT session_id FROM events WHERE event_type='pageview' AND url LIKE ? AND session_id IN (${sessionFilter})`;
          filterParams.push(`%${step.value}%`);
        } else {
          sessionFilter = sessionFilter === '' ? `SELECT session_id FROM events WHERE event_type=?` : `SELECT session_id FROM events WHERE event_type=? AND session_id IN (${sessionFilter})`;
          filterParams.push(step.value);
        }
      }
      return results;
    },

    async runRollup(cfg?: RollupConfig): Promise<void> {
      const cutoff = cutoffDays(cfg?.keepRawEventsDays || 30);
      await dbRun(db, `INSERT OR REPLACE INTO aggregated_metrics(date,metric,dimension,value) SELECT substr(timestamp,1,10),'pageviews',NULL,COUNT(*) FROM events WHERE event_type='pageview' AND timestamp<? GROUP BY substr(timestamp,1,10)`, [cutoff]);
      await dbRun(db, `INSERT OR REPLACE INTO aggregated_metrics(date,metric,dimension,value) SELECT substr(timestamp,1,10),event_type,NULL,COUNT(*) FROM events WHERE event_type!='pageview' AND timestamp<? GROUP BY event_type, substr(timestamp,1,10)`, [cutoff]);
      await dbRun(db, `DELETE FROM events WHERE timestamp<?`, [cutoff]);
      const rollupCutoff = cutoffDays(cfg?.keepRollupsDays || 365);
      await dbRun(db, `DELETE FROM aggregated_metrics WHERE date<?`, [rollupCutoff]);
    },

    getPublicConfig(): MarpleConfig {
      return getPublicConfig(config);
    },

    config
  };

  return storageObj;
}
