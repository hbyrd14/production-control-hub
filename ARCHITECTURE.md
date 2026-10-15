# Architecture

## Overview

```
┌──────────────────────┐   HTTPS (REST)    ┌──────────────────────────────────────┐  Satellite API   ┌────────────┐
│ Browser / PWA        │ ───────────────▶ │ PCH gateway (Node.js 22)             │ ───────────────▶ │ Companion  │──▶ ATEM, vMix…
│ React + TypeScript   │ ◀── WebSocket ──▶ │  Fastify · ws · SQLite (node:sqlite) │  TCP 16622 or    │ (any host) │
│ apps/web             │   /ws (JSON)      │  apps/gateway                        │  WS 16623        └────────────┘
└──────────────────────┘                   │  └ CompanionAdapter (packages/…)     │
                                           └──────────────────────────────────────┘
```

Browsers never talk to Companion. All device-control credentials and the Companion address stay on the gateway.

## Packages

| Path | Role |
| --- | --- |
| `packages/shared` | Zod schemas and types shared by gateway and browser: grid geometry, profiles/pages/slots, WebSocket messages, navigation logic, validation |
| `packages/companion-adapter` | Satellite API client (`CompanionAdapter`), line codec, TCP/WebSocket transports, RGB→PNG encoder, HTTP fallback client, and the **mock Companion** (`/mock`) used by tests and demos |
| `apps/gateway` | HTTP/WebSocket server, auth, SQLite store with migrations, the `Hub` (multi-client coordination), `InteractionEngine` (PCH gestures), Companion service |
| `apps/web` | Operator surface, editor, settings, PWA shell |
| `tests/integration` | Gateway + mock Companion over real sockets |
| `tests/e2e` | Playwright against the production build |

`packages/ui` from the suggested layout was not created: UI components live in `apps/web/src/components` because nothing else consumes them yet.

## Companion integration

See [docs/PROTOCOL_VALIDATION.md](docs/PROTOCOL_VALIDATION.md) for sources and version requirements.

### Two ways to use Companion

| | Surface profile | Mapped profile |
| --- | --- | --- |
| Companion sees | A Satellite surface `pch-<surfaceId>` with 32 keys, 8 per row (`ADD-DEVICE`) | Button subscriptions by location (`ADD-SUB … LOCATION=page/row/col`) |
| Who owns layout & pages | Companion (page buttons, `CHANGE-PAGE`) | PCH pages and folders |
| Press | `KEY-PRESS DEVICEID KEY PRESSED` | `SUB-PRESS SUBID PRESSED` |
| Feedback | `KEY-STATE` | `SUB-STATE` |
| Minimum Satellite API | 1.0 (sized bitmaps 1.5, page change 1.10) | 1.10 (`SUBSCRIPTIONS` capability) |

When subscriptions are unavailable, mapped keys are shown as unavailable unless the optional HTTP fallback (`POST /api/location/<p>/<r>/<c>/down|up`) is configured; it can press but cannot show imagery.

### CompanionAdapter

`connect() · disconnect() · reconnect() · configure() · getConnectionState()`
`addSurface() · removeSurface() · pressButton() · releaseButton() · selectPage()`
`subscribe() · unsubscribe() · pressSubscription() · releaseSubscription()`
Events: `connection`, `keyState`, `subState`, `keysClear`, `surfaceRegistered`, `surfaceError`, `subError`, `locked`, `line`.

- Handshake: waits for `BEGIN` (rejects the port if none arrives within the connect timeout) and, for API ≥ 1.10, `CAPS`.
- Requests PNG bitmaps when `CAPS` advertises `BITMAP_FORMATS=…png`; otherwise converts raw RGB to PNG itself.
- Keepalive: `PING` every 2 s; the link is declared dead after 7 s of silence.
- Reconnect: exponential backoff with ±20 % jitter (`initialDelayMs`, `factor`, `maxDelayMs`), re-registers surfaces and subscriptions on every new session.

## Safety model

The core rule: **a command reaches Companion only as the direct result of an operator gesture in the current Companion session.**

1. **No queuing.** Presses while Companion or the gateway is offline are rejected with feedback; nothing is stored for later. The browser's socket client does not buffer either.
2. **No replay.** Each Companion session has an `epoch`. Held presses are forgotten (not re-sent) when a session ends; re-registration sends only `ADD-DEVICE`/`ADD-SUB`.
3. **No orphan releases.** The adapter only sends a release for a press it sent in the same session, so a reconnect cannot fire Companion "up" actions.
4. **Safe release.** When a browser disconnects, is backgrounded, loses pointer capture, receives `pointercancel`, or navigates away from a page, every key it holds is released. Graceful gateway shutdown releases held keys and sends `QUIT`.
5. **Reference counting.** If two operators hold the same key, Companion sees one press and one release.
6. **Stale imagery.** On disconnect keys are marked stale and disabled; on reconnect stale state is dropped and Companion redraws.
7. **One gesture engine.** Companion owns latching, steps and durations. PCH's `InteractionEngine` only adds confirm/hold/double gestures that decide *when* Companion sees a single down/up — so the two never double-trigger.

## Gateway

- **HTTP** (Fastify): `/api/auth/*`, `/api/me/password`, `/api/users`, `/api/profiles` (CRUD, duplicate, import, export), `/api/settings/companion`, `/api/settings/gateway`, `/api/companion/reconnect`, `/api/diagnostics`, `/api/audit`, plus the static web build with SPA fallback.
- **WebSocket** `/ws`: authenticated at upgrade by session cookie; Origin must match the Host (or `PCH_ALLOWED_ORIGINS`). Client → gateway: `hello`, `key {down|up|cancel}`, `nav`, `releaseAll`, `ping`. Gateway → client: `welcome`, `status`, `view`, `keys`, `key`, `feedback`, `notice`, `profilesChanged`, `pong`.
- **Hub**: per-client navigation (or one shared navigation), reference-counted subscriptions (a Companion location is subscribed once regardless of how many browsers show it), key-view computation, press routing.

## Security

| Control | Implementation |
| --- | --- |
| Authentication | Username/password (scrypt), opaque session token in an `HttpOnly; SameSite=Strict` cookie (`Secure` under HTTPS), SHA-256 hashed at rest, sliding expiry |
| Authorisation | `admin` (everything), `operator` (press, navigate), `viewer` (read-only) |
| First run | One-time 8-digit setup code printed to the gateway console, or `PCH_ADMIN_*` bootstrap |
| CSRF | Mutations require `X-PCH-Request: 1` (forces a CORS preflight that is never granted) and a same-origin `Origin` when present |
| WebSocket | Origin validation, cookie auth at upgrade, 16 KiB message cap, schema validation, periodic session re-check |
| Network | Binds to loopback by default; refuses clients from non-private addresses; warns when bound to all interfaces |
| Rate limits | Failed logins (8 per user+IP, 30 per IP per 5 min), API (300/min/IP), key events (40/s/client) |
| Headers | CSP (`script-src 'self'`), `X-Frame-Options: DENY`, `nosniff`, `no-referrer` |
| Audit | Logins, failures, user/profile/settings changes, Companion reconnects, key presses (configurable), retained 90 days |
| Secrets | No secrets in source; `.env`, `data/`, `certs/` are git-ignored |

## Data model (SQLite, `data/pch.sqlite`)

`schema_migrations`, `settings` (JSON values: `companion`, `gateway`), `users`, `sessions`, `profiles` (JSON body validated with Zod on every read/write, integer `revision` for optimistic concurrency), `audit`.

A profile is `{ name, kind, surfaceId, layout, pages[] }`; a page is `{ id, name, isFolder, slots[32] }`; a slot is `empty`, `companion { location, mode, holdMs, windowMs, secondary, presentation, style }` or `nav { action, target, style }`.

Companion remains authoritative for actions and feedback. PCH stores only presentation and location mappings.

### Smart Profiles (future)

Navigation is a pure function (`applyNav`) over `NavState { profileId, pageId, folderStack }`, and the hub sets each client's navigation through one path (`setNav`). A future rules engine (e.g. "switch to the vMix profile when Companion variable X = …") can drive `setNav` without touching the press path.

## Frontend

- React 18 + Zustand; no router dependency (hash routes `#/`, `#/edit`, `#/settings`).
- Keys use Pointer Events with pointer capture; `pointercancel`/lost capture → `cancel`; `touch-action: none`, no text selection, context menu suppressed.
- `KeyGrid` sizes square keys to fit both axes so the whole 8 × 4 surface is always visible.
- PWA: manifest (landscape, fullscreen), service worker caching only the shell (`/api` and `/ws` always go to the network). Wake lock while operating (HTTPS only).
- Font: Barlow Semi Condensed, bundled locally (no internet needed).
