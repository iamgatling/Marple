# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.4.0] - 2026-10-01

### Security

- **Country spoofing fixed**: Client-provided `country` in `/collect` payloads is now ignored by default. Country is resolved only from trusted reverse-proxy headers (`cf-ipcountry`, `x-country-code`, `cloudfront-viewer-country`) when `trustProxy` is enabled and the peer socket is verified. Use `trustClientCountry: true` to explicitly opt in to client-reported countries.
- **IP spoofing via `X-Forwarded-For` fixed**: `trustProxy` now defaults to `false`. Direct socket IP is always used for rate limiting and persistence unless explicitly configured. Numeric hop-count mode is documented with a security warning.
- **CIDR proxy allowlists added**: `trustProxy` now accepts IP/CIDR notation (`'10.0.0.0/8'`, `'2001:db8::/32'`, arrays thereof) so the direct peer socket is verified before accepting forwarded headers.
- **Bounded request parsing**: `/collect` rejects bodies over 64 KB with `413 Payload Too Large`, handles `Content-Length` pre-checks, and safely destroys the request stream after rejection.
- **Rate limiter hardened**: Bounded map size prevents memory exhaustion from rotating attacker keys. `429` responses include `Retry-After`.
- **Error leakage removed**: Internal exception messages, storage errors, and SQL exceptions are no longer surfaced in HTTP responses. Public errors use stable typed codes: `BAD_REQUEST`, `INVALID_PAYLOAD`, `INVALID_STEPS`, `FUNNEL_ERROR`, `INTERNAL_ERROR`.
- **Cohort table XSS fixed**: Dashboard cohort week and size values are escaped via `esc()` before HTML insertion.
- **Security headers added**: All responses include `X-Content-Type-Options: nosniff` and `X-Frame-Options: SAMEORIGIN`.

### Added

- `trustProxy` option in `MarpleConfig`: `false` (default), `true`, numeric hop count, single IP/CIDR string, or array of IP/CIDR strings.
- `trustClientCountry` option in `MarpleConfig`: opt-in to accepting client-reported country values. Defaults to `false`.
- CIDR subnet matching for IPv4 and IPv6 proxy allowlists.
- Funnel `since`/`until` date range filtering, validated and applied across all funnel steps in SQLite and PostgreSQL.
- Chronological funnel step matching — each step must occur strictly after the previous step within the same session.
- Startup data rollup — `marple.init()` runs rollup automatically when `retention.autoRollup: true`.
- Automatic `marple.config.js` loading from working directory when no explicit options are passed.
- Dual CJS/ESM output — `require('marple')` and `require('marple/client')` work without experimental flags.
- Full ingestion validation schema — types, lengths, depth (max 3), key count (max 50), serialized size (max 16 KB), batch size (max 50).
- `Retry-After` header on `429` responses.
- `Allow` header on `405 Method Not Allowed` responses.
- IPv4 /24 and IPv6 /48 IP anonymization, with IPv4-mapped IPv6 normalization.
- 111-test suite across 12 test files covering all defects and security boundaries.

### Changed

- `405 Method Not Allowed` now includes correct `Allow` headers.
- Dashboard parameter validation clamps `limit` (1–100), `offset` (≥ 0), and rejects oversized `goal` strings.
- Server timestamp, user-agent, and IP always override any client-provided values.
- `npm test` builds before running: `npm run build && node --test tests/*.test.js`.
- Added `npm run test:run` for post-build test execution.

### Fixed

- Multi-chunk oversized `/collect` bodies return `413` (previously crashed or hung).
- Reversed funnel steps no longer produce non-zero counts.
- Funnel date ranges are now applied (previously ignored).
- Stale sessions and orphaned users pruned on rollup (previously retained indefinitely).
- Startup rollup executes when `autoRollup: true` (previously skipped).
- `marple.config.js` is loaded from the working directory (previously unused).
- `require('marple')` resolves correctly (previously failed with ESM-only output).

### Migration Notes

- **`trustProxy`**: Add `trustProxy: true` or a CIDR allowlist to `marple.init()` if deploying behind a reverse proxy.
- **Country data**: New events will have `country: null` unless a trusted proxy header is present or `trustClientCountry: true` is set. Existing rows are unaffected.
- **`autoRollup`**: Add `retention: { autoRollup: false }` if running rollups in a separate worker process.

---

## [2.3.0] and earlier

Initial release. See repository history for prior changes.
