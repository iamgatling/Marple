# Marple

Marple is a self-hosted analytics package for JavaScript applications.

## Features

- **Batched non-blocking event ingestion**: High-performance client-side batching and background flushing.
- **Automatic Event Tracking**: Out-of-the-box tracking for outbound link clicks (`outbound_click`) and file download links (`download`).
- **Privacy First (DNT & GPC)**: Respects browser `Do Not Track` (DNT) and `Global Privacy Control` (GPC) headers automatically.
- **Local Storage Options**: SQLite with WAL support or PostgreSQL database engines.
  - *Note: SQLite uses `PRAGMA synchronous=NORMAL` for optimal performance, which may result in up to one transaction loss during an OS-level crash.*
- **Mobile-Responsive Dashboard**: Built-in, lightweight Express/Next.js dashboard middleware with dynamic responsive layout.
- **Explicit authentication**: Customizable authentication callback wrapper for `/marple`.
- **Zero-config Setup**: Quick setup via `npx marple init`.
- **TypeScript First**: Full TypeScript types and definitions included out of the box.

## Quick Start

```bash
npm install marple
npx marple init
```

## Example

```js
import express from 'express';
import { marple } from 'marple';

const app = express();

await marple.init({
  // Use SQLite (default)
  storage: 'sqlite',
  // Or PostgreSQL:
  // storage: 'postgres',
  // connectionString: 'postgres://user:pass@localhost:5432/marple_db',
  
  retention: {
    keepRawEventsDays: 30,
    keepRollupsDays: 365,
    autoRollup: true
  }
});

app.use('/marple', marple.dashboard({
  authenticate: async (req) => {
    return req.session?.user?.isAdmin === true;
  }
}));

app.listen(3000);
```

## Client Tracking

Include the client SDK in your front-end (assuming you mounted the dashboard at `/marple`):

```html
<script src="/marple/client.js"></script>
<script>
  window.Marple.init({ endpoint: '/marple/collect' });
  
  // Track custom events
  window.Marple.track('button_clicked', { color: 'red' });
  
  // Identify user
  window.Marple.identify('user_123', { plan: 'pro' });
</script>
```

### Auto-Tracking & Privacy Features

- **Outbound Link Clicks**: Clicks on links leading to external domains automatically emit an `outbound_click` event with target URL and link properties.
- **File Downloads**: Clicks on links to files (e.g. `.pdf`, `.zip`, `.csv`, `.docx`, etc.) automatically trigger a `download` event with file metadata and extension.
- **Do Not Track & Global Privacy Control**: If the user has DNT (`navigator.doNotTrack`) or GPC (`navigator.globalPrivacyControl`) enabled in their browser, the SDK automatically disables event queuing and telemetry transmission.

## Authenticating the Dashboard

The dashboard is protected via the `authenticate` callback in your middleware options. Return `true` if the request is authorized, or `false` to block access.

```javascript
app.use('/marple', marple.dashboard({
  authenticate: async (req) => {
    // Example: checking an authorization header or session cookie
    return req.headers.authorization === 'Bearer SECRET_TOKEN';
  }
}));
```

