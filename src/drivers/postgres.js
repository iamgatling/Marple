import { parseBrowser, parseDevice, maskIp } from '../storage.js';

function tryParse(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id          SERIAL PRIMARY KEY,
  event_type  TEXT NOT NULL,
  session_id  TEXT,
  user_id     TEXT,
  url         TEXT,
  referrer    TEXT,
  properties  JSONB DEFAULT '{}'::jsonb,
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
  properties  JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS aggregated_metrics (
  id        SERIAL PRIMARY KEY,
  date      TEXT NOT NULL,
  metric    TEXT NOT NULL,
  dimension TEXT DEFAULT '',
  value     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(date, metric, dimension)
);
CREATE INDEX IF NOT EXISTS idx_agg_date ON aggregated_metrics(date);
`;

export default async function openPostgresStorage(config) {
  let pg;
  try {
    const pgModule = await import('pg');
    pg = pgModule.default || pgModule;
  } catch (err) {
    throw new Error('[Marple] PostgreSQL driver "pg" is not installed. Please run `npm install pg` to use the Postgres storage driver.');
  }

  const connectionString = config.postgresConnectionString || config.connectionString;
  if (!connectionString) {
    throw new Error('[Marple] Postgres storage requires a connectionString.');
  }

  const pool = new pg.Pool({ connectionString });
  
  await pool.query(PG_SCHEMA);

  const cutoffDays = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const sinceDefault = () => cutoffDays(30);

  const storageObj = {
    async writeEvent(ev) {
      const browser = parseBrowser(ev.ua);
      const device_type = parseDevice(ev.ua);
      const maskedIp = maskIp(ev.ip);
      
      await pool.query(
        `INSERT INTO events(event_type,session_id,user_id,url,referrer,properties,ip,ua,country,browser,device_type,timestamp)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [ev.event_type, ev.session_id, ev.user_id, ev.url, ev.referrer,
         ev.properties || {}, maskedIp, ev.ua, ev.country,
         browser, device_type, ev.timestamp]
      );

      if (ev.session_id) {
        await pool.query(
          `INSERT INTO sessions(id,user_id,started_at,last_seen_at,referrer,landing_page,country,browser,device_type,ip,ua,is_active)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)
           ON CONFLICT(id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at, is_active=1`,
          [ev.session_id, ev.user_id, ev.timestamp, ev.timestamp,
           ev.referrer, ev.url, ev.country, browser, device_type, maskedIp, ev.ua]
        );
      }

      if (ev.user_id) {
        await pool.query(
          `INSERT INTO users(id,first_seen,last_seen,country,browser,device_type)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(id) DO UPDATE SET last_seen=EXCLUDED.last_seen`,
          [ev.user_id, ev.timestamp, ev.timestamp, ev.country, browser, device_type]
        );
      }
    },

    async getOverview({ since } = {}) {
      const cutoff = since || sinceDefault();
      const fiveMinsAgo = new Date(Date.now() - 5 * 60000).toISOString();
      const [totalsRes, activeRes, topPagesRes, topReferrersRes, browsersRes, devicesRes, countriesRes, dailyViewsRes] = await Promise.all([
        pool.query(`SELECT COUNT(*) as te, COUNT(DISTINCT session_id) as us, COUNT(DISTINCT user_id) as uu FROM events WHERE timestamp>=$1`, [cutoff]),
        pool.query(`SELECT COUNT(*) as n FROM sessions WHERE last_seen_at >= $1`, [fiveMinsAgo]),
        pool.query(`SELECT url as page, COUNT(*) as views FROM events WHERE event_type='pageview' AND url IS NOT NULL AND timestamp>=$1 GROUP BY url ORDER BY views DESC LIMIT 10`, [cutoff]),
        pool.query(`SELECT referrer, COUNT(*) as count FROM events WHERE referrer IS NOT NULL AND referrer!='' AND timestamp>=$1 GROUP BY referrer ORDER BY count DESC LIMIT 10`, [cutoff]),
        pool.query(`SELECT browser, COUNT(*) as count FROM events WHERE timestamp>=$1 AND browser IS NOT NULL GROUP BY browser ORDER BY count DESC`, [cutoff]),
        pool.query(`SELECT device_type, COUNT(*) as count FROM events WHERE timestamp>=$1 AND device_type IS NOT NULL GROUP BY device_type ORDER BY count DESC`, [cutoff]),
        pool.query(`SELECT country, COUNT(*) as count FROM events WHERE timestamp>=$1 AND country IS NOT NULL AND country!='' GROUP BY country ORDER BY count DESC LIMIT 10`, [cutoff]),
        pool.query(`SELECT TO_CHAR(timestamp::timestamp, 'YYYY-MM-DD') as date, COUNT(*) as views FROM events WHERE event_type='pageview' AND timestamp>=$1 GROUP BY date ORDER BY date ASC`, [cutoff]),
      ]);

      const totals = totalsRes.rows[0];
      const active = activeRes.rows[0];

      return {
        totalEvents: parseInt(totals?.te || 0, 10),
        uniqueSessions: parseInt(totals?.us || 0, 10),
        uniqueUsers: parseInt(totals?.uu || 0, 10),
        activeNow: parseInt(active?.n || 0, 10),
        topPages: topPagesRes.rows.map(r => ({ ...r, views: parseInt(r.views, 10) })),
        topReferrers: topReferrersRes.rows.map(r => ({ ...r, count: parseInt(r.count, 10) })),
        browsers: browsersRes.rows.map(r => ({ ...r, count: parseInt(r.count, 10) })),
        devices: devicesRes.rows.map(r => ({ ...r, count: parseInt(r.count, 10) })),
        countries: countriesRes.rows.map(r => ({ ...r, count: parseInt(r.count, 10) })),
        dailyViews: dailyViewsRes.rows.map(r => ({ ...r, views: parseInt(r.views, 10) }))
      };
    },

    async getUsers({ limit = 50, offset = 0 } = {}) {
      const usersRes = await pool.query(
        `SELECT u.id, u.first_seen, u.last_seen, u.country, u.browser, u.device_type, COUNT(e.id) as event_count
         FROM users u LEFT JOIN events e ON e.user_id=u.id GROUP BY u.id ORDER BY u.last_seen DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      const totalRes = await pool.query(`SELECT COUNT(*) as n FROM users`);
      return {
        users: usersRes.rows.map(r => ({ ...r, event_count: parseInt(r.event_count, 10) })),
        total: parseInt(totalRes.rows[0]?.n || 0, 10)
      };
    },

    async getUserProfile(userId) {
      const userRes = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
      if (userRes.rowCount === 0) return null;
      const eventsRes = await pool.query(
        `SELECT event_type, url, properties, timestamp FROM events WHERE user_id=$1 ORDER BY timestamp DESC LIMIT 100`,
        [userId]
      );
      return {
        user: userRes.rows[0],
        events: eventsRes.rows.map(e => ({
          ...e,
          properties: typeof e.properties === 'string' ? tryParse(e.properties) : (e.properties || {})
        }))
      };
    },

    async getCohorts() {
      const res = await pool.query(`
        WITH base AS (
          SELECT id, TO_CHAR(first_seen::timestamp, 'IYYY-"W"IW') as cohort_week, first_seen FROM users
          ORDER BY first_seen DESC LIMIT 500
        ),
        act AS (
          SELECT b.id, b.cohort_week,
            TRUNC(EXTRACT(EPOCH FROM (s.started_at::timestamp - b.first_seen::timestamp)) / 604800) AS week_num
          FROM base b JOIN sessions s ON s.user_id=b.id
          WHERE TRUNC(EXTRACT(EPOCH FROM (s.started_at::timestamp - b.first_seen::timestamp)) / 604800) BETWEEN 0 AND 8
        )
        SELECT cohort_week,
          (SELECT COUNT(DISTINCT id) FROM base WHERE cohort_week=act.cohort_week) as cohort_size,
          week_num, COUNT(DISTINCT id) as retained
        FROM act GROUP BY cohort_week, week_num ORDER BY cohort_week DESC, week_num ASC
      `);
      return res.rows.map(r => ({
        ...r,
        cohort_size: parseInt(r.cohort_size, 10),
        retained: parseInt(r.retained, 10)
      }));
    },

    async getEvents({ since } = {}) {
      const cutoff = since || sinceDefault();
      const prev = new Date(Date.now() - 60 * 86400000).toISOString();
      const [eventsRes, prevEventsRes, trendRes] = await Promise.all([
        pool.query(`SELECT event_type, COUNT(*) as count, COUNT(DISTINCT user_id) as unique_users FROM events WHERE timestamp>=$1 AND event_type!='pageview' GROUP BY event_type ORDER BY count DESC`, [cutoff]),
        pool.query(`SELECT event_type, COUNT(*) as count FROM events WHERE timestamp>=$1 AND timestamp<$2 AND event_type!='pageview' GROUP BY event_type`, [prev, cutoff]),
        pool.query(`SELECT event_type, TO_CHAR(timestamp::timestamp, 'YYYY-MM-DD') as date, COUNT(*) as count FROM events WHERE timestamp>=$1 AND event_type!='pageview' GROUP BY event_type, date ORDER BY date ASC`, [cutoff])
      ]);
      
      const prevMap = Object.fromEntries(prevEventsRes.rows.map(e => [e.event_type, parseInt(e.count, 10)]));
      return {
        events: eventsRes.rows.map(e => ({
          ...e,
          count: parseInt(e.count, 10),
          unique_users: parseInt(e.unique_users, 10),
          prev_count: prevMap[e.event_type] || 0
        })),
        trend: trendRes.rows.map(e => ({ ...e, count: parseInt(e.count, 10) }))
      };
    },

    async getFunnel(steps) {
      if (!steps || steps.length < 2) return [];
      const results = [];
      let prevCount = null;
      let sessionFilter = '';
      let filterParams = [];

      for (const step of steps) {
        let count;
        const currentParamIdx = filterParams.length + 1;
        
        if (sessionFilter === '') {
          const queryStr = step.type === 'pageview'
            ? `SELECT COUNT(DISTINCT session_id) as count FROM events WHERE event_type='pageview' AND url LIKE $${currentParamIdx}`
            : `SELECT COUNT(DISTINCT session_id) as count FROM events WHERE event_type=$${currentParamIdx}`;
          const row = await pool.query(queryStr, step.type === 'pageview' ? [`%${step.value}%`] : [step.value]);
          count = parseInt(row.rows[0]?.count || 0, 10);
        } else {
          const queryStr = step.type === 'pageview'
            ? `SELECT COUNT(DISTINCT session_id) as count FROM events WHERE event_type='pageview' AND url LIKE $${currentParamIdx} AND session_id IN (${sessionFilter})`
            : `SELECT COUNT(DISTINCT session_id) as count FROM events WHERE event_type=$${currentParamIdx} AND session_id IN (${sessionFilter})`;
          
          const params = [...filterParams, step.type === 'pageview' ? `%${step.value}%` : step.value];
          const row = await pool.query(queryStr, params);
          count = parseInt(row.rows[0]?.count || 0, 10);
        }
        
        results.push({ step: step.label || step.value, count, dropoff: prevCount !== null ? Math.round((1 - count / (prevCount || 1)) * 100) : 0 });
        prevCount = count;

        if (step.type === 'pageview') {
          sessionFilter = sessionFilter === '' 
            ? `SELECT session_id FROM events WHERE event_type='pageview' AND url LIKE $${currentParamIdx}` 
            : `SELECT session_id FROM events WHERE event_type='pageview' AND url LIKE $${currentParamIdx} AND session_id IN (${sessionFilter})`;
          filterParams.push(`%${step.value}%`);
        } else {
          sessionFilter = sessionFilter === '' 
            ? `SELECT session_id FROM events WHERE event_type=$${currentParamIdx}` 
            : `SELECT session_id FROM events WHERE event_type=$${currentParamIdx} AND session_id IN (${sessionFilter})`;
          filterParams.push(step.value);
        }
      }
      return results;
    },

    async runRollup(cfg) {
      const cutoff = cutoffDays(cfg?.keepRawEventsDays || 30);
      
      await pool.query(
        `INSERT INTO aggregated_metrics(date,metric,dimension,value) 
         SELECT TO_CHAR(timestamp::timestamp, 'YYYY-MM-DD'), 'pageviews', '', COUNT(*) 
         FROM events WHERE event_type='pageview' AND timestamp<$1 
         GROUP BY TO_CHAR(timestamp::timestamp, 'YYYY-MM-DD')
         ON CONFLICT (date, metric, dimension) DO UPDATE SET value = EXCLUDED.value`,
        [cutoff]
      );
      
      await pool.query(
        `INSERT INTO aggregated_metrics(date,metric,dimension,value) 
         SELECT TO_CHAR(timestamp::timestamp, 'YYYY-MM-DD'), event_type, '', COUNT(*) 
         FROM events WHERE event_type!='pageview' AND timestamp<$1 
         GROUP BY event_type, TO_CHAR(timestamp::timestamp, 'YYYY-MM-DD')
         ON CONFLICT (date, metric, dimension) DO UPDATE SET value = EXCLUDED.value`,
        [cutoff]
      );
      
      await pool.query(`DELETE FROM events WHERE timestamp<$1`, [cutoff]);
      const rollupCutoff = cutoffDays(cfg?.keepRollupsDays || 365);
      await pool.query(`DELETE FROM aggregated_metrics WHERE date<$1`, [rollupCutoff]);
    },

    config
  };

  return storageObj;
}
