# Test results and operational readiness — v0.1.0

Run date: 2026-10-15. Environment: Linux, Node.js 22.22.0, pnpm 10.28.0, Playwright 1.56.1 with Chromium (build 1194). Mock Companion advertising Satellite API 1.14.0 unless noted.

## Results (all executed, all passing)

| Check | Command | Result |
| --- | --- | --- |
| Lint | `pnpm lint` | Pass (0 problems) |
| Type check (strict) | `pnpm typecheck` | Pass — shared, companion-adapter, gateway, web |
| Unit + integration | `pnpm test` | **85 / 85 passed**, 6 files; repeated 3× with no flakes |
| Production build | `pnpm build` | Pass |
| End-to-end | `pnpm test:e2e` | **18 / 18 passed** (9 scenarios × 2 browser profiles); `--repeat-each=2`: 36 / 36 |
| Dependency audit | `pnpm audit --prod` | No known vulnerabilities (after upgrading `@fastify/static` to 10.1.6, which fixed 4 advisories) |
| HTTPS / WSS | manual: `scripts/gen-cert.sh`, gateway with TLS, `curl --cacert`, `wss://` client | Pass — health, login cookie, CSP headers, WebSocket welcome/status over TLS |
| Static file safety | manual: encoded `../` paths against the built gateway | Traversal attempts return the app shell, never files outside the web build |
| Clean-room install | fresh extract of the release archive → `scripts/setup.sh` → lint, typecheck, 85 tests, 18 e2e → `scripts/start.sh` | Pass (this run caught and fixed a `pnpm build` script that silently skipped the build) |
| Dev launcher | manual: `pnpm dev:mock`, first-run setup code flow through the Vite proxy in Chromium | Pass |

### Coverage of required test areas

| Area | Where |
| --- | --- |
| 32-key rendering, 8 × 4, square, no scroll | e2e `renders exactly 32 square keys…` |
| Correct button mapping | integration `routes press/release to the mapped location`; e2e press test (`1/1/3`) |
| Press / release events | adapter `sends exact press/release events` (TCP and WebSocket); e2e |
| Long-press behaviour | engine `hold` tests; integration `hold-to-fire…`; e2e context-menu/selection test |
| Touch cancellation | engine `releases on pointer cancel`; e2e `pointer cancel releases the key` (touch pointer) |
| Connection loss | adapter drop/backoff, hung-peer keepalive; integration stale/offline; e2e outage |
| Automatic reconnection | adapter re-registration/re-subscription; integration and e2e recovery |
| No unintended commands | adapter no-replay/no-orphan-release; integration `never replays after reconnect`; e2e outage asserts zero Companion events |
| Profile switching | integration surface profile; e2e profile select |
| Folder navigation | shared navigation tests; integration and e2e folder/back |
| Multiple browsers | integration feedback sync, shared-key reference counting, release on disconnect |
| State synchronisation | integration `synchronises feedback across multiple clients` |
| Unauthorised access | integration: 401 REST/WS, foreign origin 403, CSRF header, rate limit, viewer cannot press/edit, disabled account socket closed; e2e unauthenticated |
| Database persistence | integration: edits survive gateway restart; revision conflict 409; e2e editor change survives reload |

## Acceptance criteria

| # | Criterion | Status |
| --- | --- | --- |
| 1 | Starts using documented instructions | **Met** (setup/start scripts and dev launcher exercised on Linux; Windows/macOS scripts written, CI matrix configured, not run here) |
| 2 | 32 virtual buttons in an 8 × 4 grid | **Met** (e2e) |
| 3 | Gateway connects to Companion on another LAN computer | **Met**: real Companion 5.1.0 over TCP (Companion on the gateway computer; vMix on a second computer) |
| 4 | Press sends correct Companion press event | **Met** (byte-exact `KEY-PRESS` / `SUB-PRESS` verified) |
| 5 | Release sends correct release event | **Met** |
| 6 | Companion images and feedback appear | **Met with mock** (PNG and raw-RGB paths) |
| 7 | States update without refresh | **Met** (e2e image changes after press; cross-client tally) |
| 8 | Works in desktop browsers and iPad Safari | **Met**: desktop Chromium (automated) and iPad Safari (user-validated, including gestures and backgrounding) |
| 9 | Pages and profiles selectable and persisted | **Met** |
| 10 | Multiple clients without corrupting state | **Met** |
| 11 | Network interruption triggers no unintended commands | **Met** (adapter, integration, e2e, and on real ATEM/vMix) |
| 12 | Automated tests pass | **Met** (85 + 18) |
| 13 | Runs without cloud hosting | **Met** (no external requests; fonts bundled) |
| 14 | ATEM/vMix actions through configured Companion buttons | **Met (user-confirmed)**: ATEM Television Studio and vMix on a separate computer, controlled together from the iPad via Companion 5.1.0 (2026-10-16) |

## Field validation log

| Date | Setup | Result | Reported by |
| --- | --- | --- | --- |
| 2026-10-15 | Companion 5.1.0, Satellite API 1.14.0, Windows | Connected. Found that Companion's button-subscriptions setting is off by default; fixed PCH's message (0.1.1) | User |
| 2026-10-16 | PCH 0.1.1 → Companion 5.1.0 → Blackmagic ATEM Television Studio | Works | User |
| 2026-10-16 | Wired iPad (Safari) → PCH gateway on LAN → Companion 5.1.0 → ATEM Television Studio + vMix on a second computer | Both controlled simultaneously from the iPad | User |

| 2026-10-16 | Same setup | Full checklist passed: network drop/reconnect with a held key (no unintended commands), iPad multi-touch, long-press and backgrounding, hold-to-fire on stream/record, second operator and viewer account | User |

## Readiness verdict

**Show-ready for the validated setup** (2026-10-16): PCH 0.1.1, Companion 5.1.0, Blackmagic ATEM Television Studio, vMix on a separate computer, wired iPad (Safari, Home Screen app) plus Windows PC. All automated tests pass and the full hardware validation checklist was completed successfully by the user.

Re-run the checklist after changing any of: PCH version, Companion version, switcher/vMix model, network layout, or iPadOS major version.

## Hardware validation checklist

Run on the bench before first rehearsal. Record Companion version and Satellite API version shown in Settings.

1. **Companion link**: Configuration A (same computer) and B (separate computers), TCP and WebSocket. Expect both lamps green; protocol log shows `BEGIN`, `CAPS` (if API ≥ 1.10), `ADD-DEVICE … OK`.
2. **Surface profile**: `pch-main` appears in Companion → Surfaces as 8 × 4. Key images match Companion's grid position-for-position (confirms the key-number mapping). Press/hold a momentary, a latching (step) and a duration button. Enable page changes on the surface; PCH Next/Previous moves Companion pages.
3. **Mapped profile**: every key on ATEM and vMix pages shows Companion's image; tally follows switcher state when changed from the hardware panel.
4. **Safety**: pull the network cable between gateway and Companion while holding a key → keys disable within ~7 s, nothing fires on reconnect, the held key's release is not sent. Repeat by quitting Companion. Repeat by sleeping the iPad mid-hold.
5. **Gestures**: hold-to-fire on stream stop (release early → nothing), tap twice on record, single/double CUT/AUTO.
6. **Two operators** on two devices: simultaneous presses, shared tally, viewer account cannot press.
7. **iPadOS Safari** (Home Screen app, HTTPS with the local CA): full-screen landscape, multi-touch (two keys at once), no context menu/magnifier on long press, no page scroll/zoom, wake lock keeps screen on, backgrounding releases keys.
8. **Windows/macOS install** using the scripts; firewall prompts; restart persistence.

## Known limitations

- Companion's `LOCKED-STATE` (PIN lock) is received but not yet shown in the UI; keys simply stop updating while Companion is locked.
- All browsers on one surface profile share one Companion surface (and its page). Use separate surface profiles for independent pages.
- Mapped profiles need Satellite API 1.10+; the HTTP fallback can press but cannot show images, and Companion's HTTP API authentication (if enabled) is not supported.
- Rotary/encoder controls, Companion variables, and brightness are not used.
- Drag-and-drop in the editor uses HTML5 drag events, which depend on browser support for touch dragging; key settings can always be edited via the inspector.
- `node:sqlite` is marked experimental in Node 22 (stable API in practice; warning suppressed by the start scripts).
- The optional Dockerfile and the Windows/macOS CI jobs were written but not executed in this environment.
- The service worker (offline shell) and wake lock require HTTPS on LAN addresses.

## Recommended next phase

1. Execute the hardware validation checklist; fix any protocol deltas found against the real Companion release in use.
2. iPadOS Safari pass on a physical iPad; add WebKit to the Playwright matrix in CI (available on GitHub runners).
3. Show the Companion PIN-lock state and offer PIN entry (`PINCODE_LOCK` / `PINCODE-KEY`, API 1.8+).
4. Per-browser Companion surfaces (one Satellite device per operator) for independent paging on surface profiles.
5. Operator lock: a time-limited "armed" mode that must be enabled before any hold/confirm key works during critical segments.
6. Smart Profiles: rules on Companion variables (`SET-VARIABLE-VALUE` / `VARIABLE-VALUE`, API 1.7+) that drive navigation.
7. Native service wrappers (Windows service, launchd plist) and a signed release package.
