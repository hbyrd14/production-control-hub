# Notes for AI assistants working on this repository

Production Control Hub controls live broadcast equipment. Treat every change to the press path as safety-critical.

## Ground rules

- **Never invent Companion protocol behaviour.** Cite <https://companion.free/for-developers/Satellite-API> for anything new, and update `docs/PROTOCOL_VALIDATION.md`.
- **Never queue, retry or replay key presses.** The adapter rejects commands while disconnected and only releases presses made in the current session (`epoch`). Keep it that way.
- Never point tests or scripts at a real Companion. Use `MockCompanionServer` (`packages/companion-adapter/src/mock`).
- Do not claim tests pass without running them; do not claim iPad Safari or hardware compatibility without real validation.
- Do not add Elgato branding, artwork or code.

## Layout

- `packages/shared` — schemas/types/navigation (imported as TS source by both apps)
- `packages/companion-adapter` — Satellite client + mock
- `apps/gateway` — Fastify + ws + `node:sqlite`; `hub.ts` is the coordinator, `interactions.ts` the gesture engine
- `apps/web` — React UI
- `tests/integration`, `tests/e2e`

## Commands

```
pnpm dev:mock          # full stack with simulated Companion
pnpm test              # vitest: unit + integration (real sockets, mock Companion)
pnpm build && pnpm test:e2e
pnpm lint && pnpm typecheck
```

## Gotchas

- `node:sqlite` is loaded via `process.getBuiltinModule` in `store.ts` because esbuild strips the `node:` prefix from unknown builtins and `sqlite` alone does not resolve. Node ≥ 22.13 required.
- Schema changes: add a new entry to `MIGRATIONS` in `store.ts`; never edit a shipped migration. Profile bodies are JSON validated by Zod; keep defaults on new fields so old rows still parse.
- Mutating REST calls require the `x-pch-request: 1` header (CSRF guard).
- WebSocket upgrades require an `Origin` matching `Host`.
- Playwright uses the preinstalled Chromium; WebKit is not available in the build environment.
