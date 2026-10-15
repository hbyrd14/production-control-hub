# Contributing

## Setup

```bash
corepack enable
pnpm install
pnpm dev:mock
```

## Before opening a pull request

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e     # needs Playwright Chromium: pnpm exec playwright install chromium
```

CI runs the same steps on Linux, Windows and macOS (end-to-end on Linux).

## Guidelines

- TypeScript strict everywhere; validate every external input with Zod.
- Changes to `packages/companion-adapter` or the press path in `apps/gateway/src/hub.ts` / `interactions.ts` need tests that prove no command is sent unintentionally (see `adapter.test.ts` and `tests/integration/gateway.test.ts` for the pattern).
- Tests must use the mock Companion. Never connect automated tests to real switchers or streaming systems.
- Database changes go in a new migration in `apps/gateway/src/store.ts`.
- UI copy: plain, sentence case, say what happens ("Save and connect", not "Submit"). Red/green are reserved for Companion tally; amber means armed/attention.
- Update `CHANGELOG.md` and the relevant docs.
- Commit messages: imperative summary line, body explaining why.
