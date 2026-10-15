# Companion configuration guide

PCH never edits Companion's buttons, actions or feedbacks. You build those in Companion's own web interface (default `http://<companion-host>:8000`); PCH presses them and shows their imagery.

## 1. Enable the Satellite listener

In Companion: **Settings → Satellite**. Confirm the **Satellite Listen Port** (default 16622 TCP; WebSocket is 16623 in Companion 3.5+). If Companion runs in Docker or behind a firewall, open both ports to the PCH gateway.

In PCH: **Settings → Companion connection** → Companion's address, transport, port → **Save and connect**. Both lamps in the top bar turn green. The status table shows the Companion version, the Satellite API version and the capabilities Companion advertised.

## 2. Choose a profile type

### Companion surface profile — Companion owns everything

PCH appears in Companion's **Surfaces** list as `pch-<surfaceId>` ("Production Control Hub"), an 8 × 4 surface. Use it exactly like a physical deck:

- Buttons, pages, page up/down buttons, steps, latching and durations are all Companion's.
- Every browser on the same surface profile shares that one Companion surface (and therefore its current page).
- To let PCH's navigation bar change pages (Satellite API 1.10+), open the surface's settings in Companion and enable **Allow page changes from Production Control Hub**. Companion ignores page-change requests until you do.
- Want different operators on different pages? Create another surface profile (Profile menu → *New Companion surface profile*); it registers a second surface.

### Mapped profile — PCH owns pages, Companion owns buttons

Each PCH key points at a Companion button by **page / row / column** (rows and columns count from 1 in the editor, matching Companion's grid). PCH pages and folders can mix buttons from any Companion pages, and add:

| Press behaviour | Use for | What Companion receives |
| --- | --- | --- |
| Normal | Almost everything | Press and release exactly as the operator does them |
| Tap twice to confirm | Recording start/stop, overlays you rarely use | Nothing on the first tap (key turns amber); a press/release on a second tap within 3 s |
| Hold to fire | Stream stop, fade to black, anything irreversible | Nothing unless the key is held for the configured time (an amber bar fills), then press; release on lift |
| Single / double press | CUT on one tap, AUTO on two | A press/release on the first button after the double-press window, or on the second button if tapped twice |

Mapped profiles require Companion's Satellite **subscriptions** (Satellite API 1.10+, `SUBSCRIPTIONS` capability). **In Companion 5.x this is a setting that is off by default:** turn on button subscriptions in Companion's **Settings → Satellite**. Companion drops its Satellite connections when the setting changes; PCH reconnects on its own. If your Companion is older, either use a surface profile or set **HTTP fallback port** (Companion's web port, e.g. 8000) in Settings — mapped keys can then press via Companion's HTTP API `/api/location/<page>/<row>/<column>/down|up`, but show only PCH's labels, not Companion's images or feedback. (If Companion's HTTP API is restricted in its settings, the fallback will fail with an error toast.)

**Avoid double-triggering:** leave latching/toggle behaviour to Companion (step buttons or toggle actions) and use PCH's gestures only for operator safety. Don't put a Companion "duration" action and a PCH hold-to-fire on the same intent unless you mean both.

## 3. Example layout (bundled)

The first-run "Show Control" profile and the mock Companion assume this layout. Recreate it in Companion to get a working demo with real gear, or adapt the profile in the editor. Action/feedback names below are those of the Companion **Blackmagic ATEM** and **Studio Automation vMix** modules; exact wording varies by module version.

**Companion page 1 — ATEM** (rows/columns from 1)

| Row \ Col | 1–6 | 8 |
| --- | --- | --- |
| 1 | PGM 1–6: *Set input on Program* (ME1, input n); feedback *Tally: Program* (red) | CUT: *Cut* |
| 2 | PVW 1–6: *Set input on Preview*; feedback *Tally: Preview* (green) | AUTO: *Auto transition* |
| 3 | col 1 USK 1 *Upstream key on air (toggle)* + feedback; col 2 DSK 1 *Downstream key on air (toggle)*; col 3 MP1 *Media player play*; col 4 MACRO 1 *Run macro*; col 8 FTB *Fade to black* + feedback | |
| 4 | col 1 label; cols 7–8 page up / page down | |

**Companion page 2 — vMix**

| Row | Buttons |
| --- | --- |
| 1 | IN 1–8: *Preview input n*; feedback *Input in preview* |
| 2 | LIVE 1–8: *Cut direct to input n*; feedback *Input is live* |
| 3 | PLAY, PAUSE, STOP (*Play/Pause/Restart input*), OVL 1, OVL 2 (*Overlay toggle* + feedback), MUTE MIC (*Audio mute toggle*), REC (*Start/stop recording* + feedback), STREAM (*Start/stop streaming* + feedback) |
| 4 | CUT, FADE; cols 7–8 page up / page down |

The bundled "Safety Controls" folder maps STREAM (hold 1.2 s), REC (tap twice), FTB (hold 1 s) and CUT/AUTO (single/double).

Capabilities depend on your switcher model and module version (number of inputs, keyers, media players). PCH hard-codes no device model; it only presses Companion buttons.

## 4. Advanced macros

Stacked, delayed and conditional actions belong in Companion (action sets, internal actions, triggers). PCH deliberately has no second automation engine. In the PCH editor, the **open Companion** link next to a mapped key opens Companion's interface (it assumes port 8000; adjust the URL if yours differs).

## 5. Validating with real equipment

Before a show:

1. Run the [hardware validation checklist](TEST_REPORT.md#hardware-validation-checklist).
2. Put irreversible actions (stream stop, FTB, record stop) behind *Hold to fire* or *Tap twice*.
3. Give camera/graphics operators **viewer** accounts unless they need to press.
4. Watch **Settings → Diagnostics → Satellite protocol log** the first time you press each key type.
