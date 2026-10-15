# Changelog

## 0.1.0 — 2026-10-15

First complete build, ready for controlled hardware testing.

### Added
- Companion Satellite adapter (TCP and WebSocket) with version-aware device registration, location subscriptions, keepalive, exponential backoff and no-replay reconnection.
- Mock Companion implementing the documented server protocol, with simulated ATEM and vMix pages and an HTTP inspector for testing.
- Gateway: Fastify REST API, authenticated WebSocket control channel, SQLite persistence with migrations, admin/operator/viewer roles, first-run setup code, rate limiting, CSRF and origin checks, private-network guard, audit log, optional HTTPS.
- Profiles: Companion surface profiles and mapped profiles with pages, folders, import/export, duplicate, optimistic-concurrency editing.
- PCH gestures: tap twice to confirm, hold to fire, single/double press.
- Web app: 8 × 4 operator surface, editor with drag-to-swap, settings, diagnostics with Satellite protocol log, PWA manifest, service worker (shell only), wake lock.
- Tests: Vitest unit + integration, Playwright end-to-end (Chromium desktop and touch).
- Docs, setup/start scripts for Windows/macOS/Linux, certificate script, CI workflow, optional Dockerfile.
