# Marple

Marple is a Self-hosted analytics package for JavaScript applications.

## Features

- Batched non-blocking event ingestion
- Local storage using SQLite with WAL or PostgreSQL
  - *Note: SQLite uses `PRAGMA synchronous=NORMAL` for optimal performance, which may result in up to one transaction loss during an OS-level crash.*
- Minimal dashboard middleware for Express/Next.js
- Explicit authentication wrapper for `/marple`
- A zero-config `npx marple init` setup helper

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
