# Marple

Marple is a self-hosted, privacy-first analytics package for JavaScript/TypeScript applications. It provides server-side event ingestion, a built-in analytics dashboard, and a lightweight browser SDK — all deployable as Express middleware with no external services required.

[![npm version](https://img.shields.io/npm/v/marple)](https://www.npmjs.com/package/marple)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Features

- **Batched Browser SDK**: Client-side event queue flushed every 10 seconds (or when the queue reaches 50 events), using `fetch` with `keepalive` or `navigator.sendBeacon` on page close.
- **Auto Page-View Tracking**: Fires a `pageview` on init, and patches `history.pushState` / `popstate` for SPA navigation.
- **Auto Link Tracking**: Detects outbound link clicks (`outbound_click`) and file download clicks (`download`) via a single delegated `document` listener — no configuration needed.
- **Privacy by Default (DNT & GPC)**: If `navigator.doNotTrack` or `navigator.globalPrivacyControl` is set, the SDK silently disables all event queuing and transmission.
- **UTM Parameter Extraction**: Automatically parses and stores `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, and `utm_content` from each event URL.
- **IP Masking**: The last octet of IPv4 addresses (and the last group of IPv6 addresses) is zeroed before storage.
- **Bot Filtering**: Events from known bots and crawlers are silently dropped on the server using [isbot](https://www.npmjs.com/package/isbot).
- **Rate Limiting**: The `/collect` endpoint enforces a per-IP limit of 100 requests per 60-second window.
- **SQLite & PostgreSQL Storage**: Zero-config SQLite (WAL mode) or a PostgreSQL connection string. You can also provide a fully custom `Driver` object.
  - *SQLite note: Uses `PRAGMA synchronous=NORMAL` — up to one transaction may be lost during an abrupt OS-level crash.*
- **Data Retention & Rollups**: Configurable raw event retention (default 30 days) and aggregated metric retention (default 365 days), with optional automatic rollup on startup.
- **Dashboard Middleware**: Mount a full analytics UI (overview, users, funnels, goal conversions, cohorts, events) at any Express route with a single call.
- **Mandatory Authentication**: The dashboard requires a developer-supplied `authenticate(req)` callback — there is no default open access.
- **Server-Side Tracking**: Call `marple.track()` directly from your backend to record server-generated events.
- **Custom Driver Support**: Pass any object implementing the `Driver` interface as `storage` to use your own database backend.
- **TypeScript First**: Full TypeScript types and `.d.ts` declarations included out of the box.
- **CLI**: `npx marple init` scaffolds a `marple.config.js` with sensible defaults.

---

## Requirements

- **Node.js >= 18**
- **SQLite** (peer dep): `npm install sqlite3`
- **PostgreSQL** (peer dep, optional): `npm install pg`

---

## Quick Start

```bash
npm install marple sqlite3
npx marple init
```

`npx marple init` creates a `marple.config.js` in your project root.

---

## Server Setup (Express)

```js
import express from 'express';
import { marple } from 'marple';

const app = express();

// 1. Initialise Marple
await marple.init({
  storage: 'sqlite',              // 'sqlite' | 'postgres' | custom Driver
  sqlitePath: './marple.sqlite',  // SQLite only; defaults to './marple.sqlite'

  // PostgreSQL alternative:
  // storage: 'postgres',
  // connectionString: 'postgres://user:pass@localhost:5432/marple_db',

  retention: {
    keepRawEventsDays: 30,   // Delete raw events older than 30 days
    keepRollupsDays: 365,    // Delete aggregated metrics older than 365 days
    autoRollup: true         // Run rollup automatically on init
  }
});

// 2. Mount the dashboard (authentication is mandatory)
app.use('/marple', marple.dashboard({
  authenticate: async (req) => {
    return req.session?.user?.isAdmin === true;
  }
}));

app.listen(3000);
```

---

## Browser SDK

The client SDK is served automatically at `/marple/client.js` once the middleware is mounted.

```html
<script src="/marple/client.js"></script>
<script>
  // Initialise — fires a pageview immediately and patches history for SPAs
  window.Marple.init({ endpoint: '/marple/collect' });

  // Track a custom event
  window.Marple.track('signup_button_clicked', { plan: 'pro' });

  // Identify the current user (persisted in localStorage)
  window.Marple.identify('user_123', { email: 'user@example.com' });
</script>
```

### `init(options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `endpoint` | `string` | `'/marple/collect'` | URL of the collect endpoint |
| `sessionId` | `string \| null` | auto-generated per tab | Override the session ID |
| `userId` | `string \| null` | from `localStorage` | Override the user ID |

### `track(eventType, properties?)`

Queues a custom event. Events are flushed every 10 seconds, when the queue reaches 50, or when the page is hidden/unloaded.

### `identify(userId, traits?)`

Sets the current user ID (stored in `localStorage` as `_marple_uid`) and emits an `identify` event with optional trait properties.

---

## Auto-Tracking Events

| Event | Trigger | Properties |
|---|---|---|
| `pageview` | On `init()`, `pushState`, and `popstate` | `{ title }` |
| `outbound_click` | Click on a link to a different hostname | `{ url, href, target }` |
| `download` | Click on a link with `download` attribute or a recognised file extension (`.pdf`, `.zip`, `.csv`, `.docx`, `.mp4`, etc.) | `{ url, href, extension, target }` |

Auto-tracking is set up once during `init()` and guarded against double-registration.

---

## Server-Side Tracking

Track events directly from your backend:

```js
await marple.track('order_completed', {
  orderId: 'abc-123',
  total: 49.99
}, {
  userId: 'user_456',
  sessionId: 'sid_xyz',
  ip: req.ip,
  ua: req.headers['user-agent'],
  url: 'https://myapp.com/checkout',
  referrer: req.headers['referer']
});
```

---

## Dashboard API Routes

All routes are relative to your mount path (e.g. `/marple`):

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/client.js` | No | Browser SDK JavaScript |
| `POST` | `/collect` | No | Event ingestion (bot-filtered, rate-limited) |
| `GET` | `/` | Yes | Analytics dashboard HTML |
| `GET` | `/api/overview` | Yes | Summary metrics. Params: `since`, `until`, `goal` |
| `GET` | `/api/users` | Yes | Paginated user list. Params: `limit`, `offset` |
| `GET` | `/api/users/:userId` | Yes | User profile and event history |
| `GET` | `/api/events` | Yes | Raw event stream. Params: `since`, `until` |
| `GET` | `/api/conversions` | Yes | Goal conversion stats. Params: `since`, `until`, `goal` |
| `GET` | `/api/cohorts` | Yes | Cohort data |
| `POST` | `/api/funnel` | Yes | Funnel analysis. Body: `{ steps: FunnelStep[] }` |
| `GET` | `/api/config` | Yes | Public (credential-stripped) server config |

The dashboard HTML is served with `X-Robots-Tag: noindex, nofollow` and `Cache-Control: no-store`.

---

## Authentication

The `authenticate` callback receives the raw Express `Request` object and must return `true` (or `Promise<true>`) to allow access. Any `false` return or thrown exception yields a `401 Unauthorized` response.

```js
app.use('/marple', marple.dashboard({
  authenticate: async (req) => {
    return req.headers.authorization === `Bearer ${process.env.DASHBOARD_TOKEN}`;
  }
}));
```

---

## Custom Driver

Implement the `Driver` interface to use any storage backend:

```ts
import type { Driver, TrackEvent } from 'marple';

const myDriver: Driver = {
  async writeEvent(ev: TrackEvent) { /* persist event */ },
  async getOverview(options)       { /* return OverviewData */ },
  async getUsers(options)          { /* return UsersData */ },
  async getFunnel(steps)           { /* return FunnelStepResult[] */ },
  // Optional methods:
  async getUserProfile(userId)     { /* return UserProfileData | null */ },
  async getCohorts()               { /* return any[] */ },
  async getEvents(options)         { /* return event stream */ },
  async getConversions(options)    { /* return GoalConversionData */ },
  async runRollup(config)          { /* aggregate and prune data */ },
  async getPublicConfig()          { /* return safe config subset */ },
};

await marple.init({ storage: myDriver });
```

---

## Data Retention & Rollups

Both SQLite and PostgreSQL drivers support automatic rollups that aggregate raw events into an `aggregated_metrics` table and prune old data.

```js
await marple.init({
  retention: {
    keepRawEventsDays: 30,   // Prune raw events older than N days
    keepRollupsDays: 365,    // Prune aggregated metrics older than N days
    autoRollup: true         // Run on startup (default: true)
  }
});
```

---

## TypeScript

All types are exported from `marple`:

```ts
import type {
  MarpleConfig,
  Driver,
  TrackEvent,
  OverviewData,
  OverviewOptions,
  UsersData,
  UserRecord,
  UserProfileData,
  FunnelStep,
  FunnelStepResult,
  GoalConversionData,
  RollupConfig,
} from 'marple';
```

---

## CLI

```bash
npx marple init    # Scaffold marple.config.js with defaults
npx marple help    # Show usage
```

`init` detects your framework (Express, Next.js, or plain Node.js) from `package.json` and prints tailored setup instructions.

---

## Repository

- **GitHub**: [github.com/iamgatling/Marple](https://github.com/iamgatling/Marple)
- **npm**: [npmjs.com/package/marple](https://www.npmjs.com/package/marple)
- **Issues**: [github.com/iamgatling/Marple/issues](https://github.com/iamgatling/Marple/issues)

## License

[MIT](LICENSE)
u
