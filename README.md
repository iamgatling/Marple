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
- **IP Masking**: Client IP addresses are anonymized before storage by zeroing the last octet (/24) for IPv4 and zeroing the last 80 bits (/48 subnet) for IPv6, fully supporting compressed IPv6 and IPv4-mapped IPv6 addresses.
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

### ESM (`import`)

```js
import express from 'express';
import { marple } from 'marple';

const app = express();

await marple.init({
  storage: 'sqlite',
  sqlitePath: './marple.sqlite',
  retention: {
    keepRawEventsDays: 30,
    keepRollupsDays: 365,
    autoRollup: true
  }
});

app.use('/marple', marple.dashboard({
  authenticate: async (req) => req.session?.user?.isAdmin === true
}));

app.listen(3000);
```

### CommonJS (`require`)

Marple provides dual module output and works seamlessly in CommonJS projects:

```js
const express = require('express');
const { marple } = require('marple');

const app = express();

marple.init({
  storage: 'sqlite',
  sqlitePath: './marple.sqlite'
}).then(() => {
  app.use('/marple', marple.dashboard({
    authenticate: (req) => req.headers['x-auth-token'] === process.env.AUTH_TOKEN
  }));
  app.listen(3000);
});
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

Both SQLite and PostgreSQL drivers support automatic, transactional, and idempotent rollups that aggregate raw events into an `aggregated_metrics` table and prune old data.

Rollup execution:
- Aggregates pageviews and custom events by date into `aggregated_metrics` without double-counting.
- Prunes raw `events` older than `keepRawEventsDays`.
- Prunes stale `sessions` (`last_seen_at` older than `keepRawEventsDays`).
- Prunes orphaned `users` (`last_seen` older than `keepRawEventsDays` with no remaining retained events).
- Prunes `aggregated_metrics` older than `keepRollupsDays`.
- Runs automatically during `marple.init()` when `autoRollup` is `true` (default).

```js
await marple.init({
  retention: {
    keepRawEventsDays: 30,   // Prune raw events, stale sessions, and orphaned users
    keepRollupsDays: 365,    // Prune aggregated metrics older than N days
    autoRollup: true         // Run automatically on init (default: true)
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

## Configuration

Options can be passed directly to `marple.init(options)`, imported from `marple.config.js`, or loaded automatically when calling `marple.init()` without arguments:

```js
// marple.config.js
export default {
  storage: 'sqlite',
  sqlitePath: './marple.sqlite',
  retention: {
    keepRawEventsDays: 30,
    keepRollupsDays: 365,
    autoRollup: true
  }
};
```

To avoid unexpected code execution from `process.cwd()`, `marple.init()` only loads `marple.config.js` if no explicit configuration is provided. You can also explicitly load configuration using `await marple.loadConfig()`.

---

## Proxy Configuration & Client IP Resolution

Marple never trusts `X-Forwarded-For` headers by default. Direct peer IP addresses (`req.socket.remoteAddress`) are used for rate limiting and event persistence unless explicitly configured via `trustProxy`.

```js
await marple.init({
  // Direct Node (default): ignores X-Forwarded-For to prevent IP spoofing
  trustProxy: false,

  // Single reverse proxy (e.g. Nginx, Heroku, AWS ALB):
  // Note: numeric hop counts assume network topology guarantees the peer is a trusted proxy.
  // trustProxy: true, // or trustProxy: 1

  // Multiple reverse proxies (e.g. Cloudflare -> Nginx -> Node):
  // trustProxy: 2,

  // Specific trusted proxy IP / CIDR subnet allowlist:
  // Supports IPv4/IPv6 addresses and CIDR notation (e.g. subnets):
  // trustProxy: ['127.0.0.1', '10.0.0.0/8', '172.16.0.0/12', '2001:db8::/32']
});
```

> **Security Note on Numeric Hop Counts**: A numeric `trustProxy` setting (such as `1` or `2`) relies on the upstream network architecture ensuring that connections only arrive from your trusted reverse proxies. If your Node process is directly accessible by public clients, use an IP/CIDR allowlist mode instead to verify the direct peer socket address.

---

## Privacy & Data Anonymization

Marple is designed to comply with privacy frameworks (such as GDPR and ePrivacy) out of the box:

- **IP Anonymization**: All IP addresses are masked before being written to persistent storage:
  - **IPv4**: The last octet (8 bits) is zeroed (`192.168.1.42` -> `192.168.1.0`), preserving only the `/24` network prefix.
  - **IPv6**: The last 80 bits are zeroed (`2001:db8:85a3::8a2e:370:7334` -> `2001:db8:85a3::`), preserving only the `/48` prefix.
  - **IPv4-Mapped IPv6**: Addresses like `::ffff:192.168.1.42` are resolved and masked to standard IPv4 prefixes (`192.168.1.0`).
  - **Compressed Notation**: Full support for `::` shorthand and bracketed notation with port numbers.
- **Do Not Track & Global Privacy Control**: If `navigator.doNotTrack === '1'` or `navigator.globalPrivacyControl === true`, client event capture is completely disabled.
- **No Third-Party Transmission**: Data stays entirely inside your chosen SQLite or PostgreSQL database.

---

## Security & Trust Boundaries

- **Identity & Attribution Boundaries**: Client-provided `user_id` and `session_id` are unauthenticated browser tokens (pseudonymous client-controlled labels), NOT verified identities. They are subject to strict shape and length validation, but must never be used as trusted credentials or access control tokens.
- **Server-Derived Geolocation**: Ingestion checks for trusted reverse proxy geolocation headers (`cf-ipcountry`, `x-country-code`, `cloudfront-viewer-country`) and prioritizes them over unauthenticated client-reported country values.
- **Bounded Stream Parsing**: The `/collect` ingestion endpoint bounds raw incoming chunks and terminates parsing with `413 Payload Too Large` if requests exceed 64 KB, safely handling aborted streams, unconsumed buffers, and preventing memory exhaustion.
- **Safe Public Error Boundaries**: Internal exception messages, storage failures, and database queries are never leaked to public or unauthenticated callers. Errors are returned as stable, typed codes (`BAD_REQUEST`, `INVALID_PAYLOAD`, `INVALID_STEPS`, `FUNNEL_ERROR`, `INTERNAL_ERROR`).
- **Strict Ingestion Schema**: All event properties are validated against size and depth constraints (maximum 50 events per batch, property recursion depth limit of 3, key count limit of 50, serialized size limit of 16 KB). Malformed items or invalid structures return `400 Bad Request`.
- **HTTP Method Enforcement**: Endpoints strictly enforce allowable HTTP methods. `/collect` and `/api/funnel` accept only `POST`; dashboard and other API endpoints accept only `GET` and `HEAD`. Any unauthorized method receives `405 Method Not Allowed` with an appropriate `Allow` response header.
- **Security Headers**: Standard security headers are returned on all responses:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: SAMEORIGIN`
- **Rate Limiting**: `/collect` enforces a rolling limit of 100 requests per 60 seconds per resolved IP address. Exceeded limits yield `429 Too Many Requests` with a `Retry-After` header. The internal rate limiter automatically prunes stale keys and is bounded to prevent denial-of-service.
- **Mandatory Dashboard Authentication**: All dashboard and administrative API routes require explicit authentication via developer-provided `authenticate(req)` function.

---

## Migration & Upgrade Guide

### Upgrading to 2.3.0+

- **Dual Module Output**: Marple exports both CommonJS (`main`: `./dist/cjs/index.js`) and ESM (`module`: `./dist/index.js`) via package `exports`. `require('marple')` and `require('marple/client')` work out-of-the-box without requiring experimental Node flags.
- **Startup Data Rollups**: If `retention` is configured, automatic rollup is enabled by default (`autoRollup: true`). During `marple.init()`, old raw events, stale sessions, and orphaned users are pruned within a single atomic transaction. Set `autoRollup: false` if you run rollups in a separate worker process.
- **Reverse Proxy Configurations**: By default, `trustProxy` is `false`. If Marple is deployed behind a reverse proxy (e.g. Nginx, Cloudflare, AWS ALB), configure `trustProxy: true` (or an explicit IP / CIDR allowlist) in your `marple.init()` options so rate limiting and persistence resolve the genuine client IP address.
- **Strict Funnel Analysis**: Funnel steps are evaluated in chronological order within each session. Events matching prior steps later in time will not erroneously match earlier steps. Date ranges (`since` and `until`) are validated and applied across all funnel steps.
- **Generated Configuration Auto-Loading**: `marple.init()` automatically checks for and loads `marple.config.js` in the current working directory only when no explicit options are passed directly.

---

## Repository

- **GitHub**: [github.com/iamgatling/Marple](https://github.com/iamgatling/Marple)
- **npm**: [npmjs.com/package/marple](https://www.npmjs.com/package/marple)
- **Issues**: [github.com/iamgatling/Marple/issues](https://github.com/iamgatling/Marple/issues)

## License

[MIT](LICENSE)
