# Phase 0 — Companion protocol validation

## Sources consulted (October 2026)

- Companion Satellite API specification — <https://companion.free/for-developers/Satellite-API>
- Companion HTTP remote control (v4.3) — <https://companion.free/user-guide/v4.3/remote-control/http-remote-control>
- Companion Satellite user guide (v4.3) — <https://companion.free/user-guide/v4.3/remote-control/satellite>

No undocumented messages or endpoints are used. Where the documentation is silent, the adapter is lenient (see "Gaps").

## Findings

| Topic | Documented behaviour | PCH implementation |
| --- | --- | --- |
| Transport | TCP 16622; WebSocket 16623 (Companion 3.5+). One message per line. | Both transports, user-selectable; port configurable |
| Handshake | Server sends `BEGIN CompanionVersion=… ApiVersion=…`; API ≥ 1.10 sends `CAPS` immediately after | Waits for `BEGIN`; waits up to 750 ms for `CAPS` on ≥ 1.10; feature flags absent ⇒ disabled |
| Keepalive | Client should `PING` about every 2 s; must answer server `PING` with `PONG` | 2 s ping, 7 s silence ⇒ dead link; answers server pings |
| Surface | `ADD-DEVICE DEVICEID PRODUCT_NAME KEYS_TOTAL KEYS_PER_ROW BITMAPS COLORS TEXT TEXT_STYLE …` | 32 keys, 8 per row; `BITMAPS=<size>` (≥ 1.5) else `true`; `COLORS=hex` (≥ 1.6); `TEXT_STYLE` (≥ 1.4); `BRIGHTNESS=false` (≥ 1.7); `SERIAL` and `CAN_CHANGE_PAGE` (≥ 1.10); `BITMAP_FORMAT=png` only when advertised |
| Press | `KEY-PRESS DEVICEID KEY PRESSED=true/false` | Exact; one down and one up per gesture |
| Feedback | `KEY-STATE DEVICEID KEY TYPE PRESSED BITMAP COLOR TEXTCOLOR TEXT(base64) FONT_SIZE LOCATION` | Parsed; `KEY` accepted as number or `row/col` |
| Bitmaps | Raw base64 RGB by default; PNG/WebP data URL if `BITMAP_FORMAT` negotiated (≥ 1.12) | PNG requested when available; raw RGB converted to PNG by the gateway |
| Page change | `CHANGE-PAGE DEVICEID DIRECTION=1/0` (≥ 1.10), only if `CAN_CHANGE_PAGE` label was given and the user enabled it on the surface; always answers OK | Supported; UI explains the Companion-side checkbox |
| Location subscriptions | `ADD-SUB SUBID LOCATION=page/row/col BITMAP COLORS TEXT TEXT_STYLE`, `SUB-STATE`, `SUB-PRESS`, `REMOVE-SUB` (≥ 1.10) | Used for mapped profiles, reference-counted, re-added on reconnect |
| Locking | `LOCKED-STATE` — while locked no drawing, input ignored | Event surfaced (UI treatment is a next-phase item) |
| HTTP API | `POST /api/location/<p>/<r>/<c>/press|down|up`; no endpoint sets a surface's page | Optional fallback for mapped presses only |
| Authentication | Neither the Satellite API nor the HTTP page documents authentication | Companion must be reachable only from the gateway; see INSTALL network guidance |

## Version requirements

| Feature | Satellite API |
| --- | --- |
| Surface profile (press, colours, text) | 1.0+ (sized bitmaps 1.5+, hex colours 1.6+) |
| PCH-initiated page change on a surface | 1.10+ and enabled per surface in Companion |
| Mapped profiles with live imagery | 1.10+ with `SUBSCRIPTIONS` |
| Server-side PNG bitmaps | 1.12+ (otherwise converted by the gateway) |
| WebSocket transport | Companion 3.5+ |

The gateway displays the Companion version and Satellite API version it negotiated (**Settings → Companion connection**). The documentation does not map Companion release numbers to API versions, so PCH reports what the server declares rather than assuming.

## Proof of concept

`packages/companion-adapter` contains the adapter and a mock Companion that implements the server side of the documented protocol (BEGIN/CAPS, ADD-DEVICE, KEY-PRESS/KEY-STATE, ADD-SUB/SUB-STATE/SUB-PRESS, CHANGE-PAGE, PING/PONG, version-dependent behaviour down to API 1.7). `adapter.test.ts` verifies over real TCP **and** WebSocket sockets:

- handshake and capability negotiation;
- 32-key registration and PNG key images;
- byte-exact press/release lines;
- no release without a matching press; no queuing while offline;
- drop → backoff → re-registration with **no replay**;
- exponential backoff growth and cap;
- hung-peer detection via keepalive;
- graceful disconnect releases held keys then `QUIT`;
- subscriptions, cross-client tally feedback, re-subscription;
- API 1.7 fallback (raw RGB, no subscriptions, no page change).

**Not yet verified against a real Companion instance.** The mock follows the published specification; real-world differences (for example exact `ADD-DEVICE OK` arguments, or how a given Companion release renders `CAN_CHANGE_PAGE`) must be confirmed in hardware validation.

## Gaps in the documentation and how PCH handles them

- `ADD-DEVICE OK` arguments are not specified → the adapter accepts OK with or without `DEVICEID`.
- Mapping of legacy key numbers to positions in `KEY-STATE` is not described → the adapter assumes `row * KEYS_PER_ROW + column`, consistent with simple-mode `KEYS_PER_ROW`; verify on hardware.
- No keepalive timeout value → 7 s chosen (3.5 × the recommended ping interval).
- No authentication → network isolation is the control.
