# Production Control Hub

A browser-based, 32-key (8 × 4) production control surface powered by [Bitfocus Companion](https://bitfocus.io/companion). Operate ATEM, vMix and anything else Companion controls from an iPad, Surface, laptop or desktop browser — no physical deck and no native app required. Everything runs on your local network; no cloud services.

```
 iPad / laptop / touchscreen ──HTTPS + WebSocket──▶ PCH gateway ──Satellite TCP/WS──▶ Companion ──▶ ATEM, vMix, …
          (browser, PWA)                          (Node.js + SQLite)                 (same or other computer)
```

## What it does

- **8 × 4 control surface** that scales to any screen, with Companion's live key images, tally and feedback.
- **Two profile types**
  - *Companion surface*: PCH registers an 8 × 4 Satellite surface. Companion owns the layout, pages and imagery — it behaves like a physical XL-class deck.
  - *Mapped*: PCH pages and folders where each key points at a specific Companion button (page/row/column), with optional operator-safety gestures: **tap twice to confirm**, **hold to fire**, and **single/double press**.
- **Safe by design**: commands are never queued or replayed. If Companion or the gateway drops, keys disable immediately, held keys are released, and nothing is sent when the link returns.
- **Multi-operator**: any number of browsers; feedback stays in sync; per-browser or shared page navigation; read-only viewer accounts.
- **Editor** for profiles, pages, folders, key labels, colours, icons and images, plus import/export.
- **Security**: authenticated sessions, admin/operator/viewer roles, CSRF and WebSocket origin checks, refusal of non-private client addresses, login rate limiting, audit log, optional HTTPS with a local CA for iPads.

## Quick start (development, no hardware needed)

Requires Node.js 22.13+ and pnpm (`corepack enable`).

```bash
pnpm install
pnpm dev:mock
```

This starts a **mock Companion** (simulated ATEM on page 1 and vMix on page 2), the gateway, and the web app at <http://127.0.0.1:5173>. The gateway console prints a one-time setup code; use it to create the admin account.

## Production

```bash
scripts/setup.sh          # Windows: scripts\setup.ps1
# edit .env (at minimum PCH_HOST), optionally scripts/gen-cert.sh for HTTPS
scripts/start.sh          # Windows: scripts\start.ps1
```

Then open `http(s)://<gateway-address>:8420` from any device on the production LAN. Full instructions for Windows, macOS, Linux and iPad: [docs/INSTALL.md](docs/INSTALL.md).

## Documentation

| Document | Contents |
| --- | --- |
| [docs/INSTALL.md](docs/INSTALL.md) | Installation, deployment configurations A and B, HTTPS and iPad setup, troubleshooting |
| [docs/COMPANION_SETUP.md](docs/COMPANION_SETUP.md) | Configuring Companion, example ATEM/vMix layouts, surface vs mapped profiles |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components, protocols, safety model, data model |
| [docs/PROTOCOL_VALIDATION.md](docs/PROTOCOL_VALIDATION.md) | What was verified about the Companion Satellite API and version requirements |
| [docs/TEST_REPORT.md](docs/TEST_REPORT.md) | Test results, operational readiness, known limitations, next steps |
| [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md) | Original product requirements |
| [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md) · [CLAUDE.md](CLAUDE.md) | Development workflow, history, notes for AI assistants |

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` / `pnpm dev:mock` | Development (with your Companion / with the mock) |
| `pnpm mock:companion` | Mock Companion on its own (TCP 16622, WS 16623, inspector 16680) |
| `pnpm build` · `pnpm start` | Production build and run |
| `pnpm test` | Unit + integration tests (Vitest) |
| `pnpm test:e2e` | Browser tests (Playwright, Chromium) against the built app and mock |
| `pnpm lint` · `pnpm typecheck` | ESLint, TypeScript strict |
| `pnpm admin:reset-password <user>` | Recover admin access (gateway stopped) |

## Status

Version 0.1.1 is **show-ready for the validated setup**: Companion 5.1.0 controlling a Blackmagic ATEM Television Studio and vMix, operated from an iPad and a Windows PC. Automated tests pass and the hardware validation checklist was completed on real gear — see [docs/TEST_REPORT.md](docs/TEST_REPORT.md). Re-run the checklist when any part of that setup changes.

Production Control Hub is an independent project. It is not affiliated with Elgato or Bitfocus and uses no Elgato software, branding or artwork.
