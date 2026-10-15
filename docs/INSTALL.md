# Installation and deployment

## Requirements

| | |
| --- | --- |
| Gateway computer | Windows 10/11, macOS 13+, or Linux; Node.js **22.13 or newer** (LTS); ~200 MB disk |
| Companion | Bitfocus Companion with the Satellite listener enabled (default port 16622 TCP, 16623 WebSocket). Mapped profiles need Satellite API 1.10+ — check the version shown in **Settings → Companion connection** after connecting |
| Clients | Any current browser: Chrome, Edge, Firefox, Safari on macOS/iPadOS, Chrome on Android |
| Network | Gateway reachable from clients on TCP 8420 (or your `PCH_PORT`); gateway can reach Companion on 16622/16623 |

No internet access is needed after installation. Docker is optional (see the end).

## Deployment configurations

**Configuration A — same computer.** Companion and the PCH gateway run on one machine. Set the Companion address to `127.0.0.1`.

**Configuration B — separate computers.** Companion runs on Computer A (e.g. `192.168.10.20`), the gateway on Computer B (e.g. `192.168.10.5`). Set the Companion address to Computer A's IP. Nothing in the source code changes between A and B — only the Companion address in Settings (or `PCH_COMPANION_HOST` on first start).

In both cases iPads/laptops open `http(s)://<gateway-address>:8420`.

## Install

### Windows

1. Install Node.js LTS (22.x) from <https://nodejs.org> (tick "Add to PATH").
2. Download or clone this repository, e.g. to `C:\PCH`.
3. Open PowerShell in that folder and run:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   scripts\setup.ps1
   ```
4. Edit `.env` (see [Configure](#configure)).
5. Start: `scripts\start.ps1`. Allow Node.js through Windows Defender Firewall on **Private** networks when prompted.

To run at login, create a Task Scheduler task that runs `powershell -ExecutionPolicy Bypass -File C:\PCH\scripts\start.ps1` with "Start in" set to `C:\PCH`.

### macOS

```bash
brew install node@22          # or the installer from nodejs.org
git clone <repo> pch && cd pch
scripts/setup.sh
nano .env
scripts/start.sh
```

macOS will ask whether Node may accept incoming connections — choose **Allow**.

### Linux

```bash
# Node 22 via your distribution, NodeSource, or nvm
scripts/setup.sh
nano .env
scripts/start.sh
```

Example systemd unit (`/etc/systemd/system/pch.service`):

```ini
[Unit]
Description=Production Control Hub gateway
After=network-online.target
Wants=network-online.target

[Service]
User=pch
WorkingDirectory=/opt/pch
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning apps/gateway/dist/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Configure

`.env` in the repository root (copied from `.env.example` by setup):

| Variable | Default | Notes |
| --- | --- | --- |
| `PCH_HOST` | `127.0.0.1` | **Set to the gateway's LAN IP** (e.g. `192.168.10.5`) so tablets can connect. `0.0.0.0` listens on every interface. |
| `PCH_PORT` | `8420` | |
| `PCH_DATA_DIR` | `./data` | SQLite database location. Back this folder up. |
| `PCH_TLS_CERT`, `PCH_TLS_KEY` | — | Enable HTTPS (recommended for iPad). |
| `PCH_COMPANION_HOST/PORT/TRANSPORT` | — | First-start seed only; afterwards use Settings. |
| `PCH_ADMIN_USERNAME/PASSWORD` | — | Optional unattended admin creation. |
| `PCH_ALLOWED_ORIGINS` | — | Extra origins (reverse proxy / alternate hostname). |
| `PCH_ALLOW_NON_PRIVATE_CLIENTS` | `false` | Keep `false`. PCH must not face the internet. |
| `PCH_SESSION_TTL_HOURS` | `12` | Sliding session lifetime. |
| `PCH_AUDIT_PRESSES` / `PCH_AUDIT_RETENTION_DAYS` | `true` / `90` | Activity log. |

### First start

On first start the console shows a banner with a **one-time setup code**. Open the gateway in a browser, enter the code, and create the admin account (password ≥ 10 characters). Then:

1. **Settings → Companion connection**: enter Companion's address, choose Satellite TCP (16622) or WebSocket (16623), **Save and connect**. The status table shows the Companion and Satellite API versions.
2. **Settings → Operators**: add operator (can press) and viewer (read-only) accounts.
3. Configure Companion and profiles: [COMPANION_SETUP.md](COMPANION_SETUP.md).

Lost the admin password? Stop the gateway and run `pnpm admin:reset-password <username>`.

## HTTPS and iPad

HTTP works on an iPad, but HTTPS unlocks the screen wake lock and the offline app shell, and protects sessions on shared networks. Use a private certificate authority:

```bash
scripts/gen-cert.sh 192.168.10.5 control-hub.local     # gateway IP and/or hostname
```

(On Windows, run it from Git Bash, or use [mkcert](https://github.com/FiloSottile/mkcert): `mkcert -install`, `mkcert 192.168.10.5`, and install mkcert's root CA on the iPad.)

Set in `.env`:

```
PCH_TLS_CERT=./certs/pch.crt
PCH_TLS_KEY=./certs/pch.key
```

Install the CA on each iPad:

1. Send `certs/pch-ca.crt` to the iPad (AirDrop, email, or download it from a file server). **Never** share `pch-ca.key`.
2. Open it; iPadOS says "Profile Downloaded". Go to **Settings → General → VPN & Device Management**, select the profile, **Install**.
3. Go to **Settings → General → About → Certificate Trust Settings** and turn on **full trust** for "Production Control Hub Local CA".
4. Open `https://192.168.10.5:8420` in Safari. There should be no warning.

Macs: double-click `pch-ca.crt`, add to the System keychain, set "When using this certificate" to *Always Trust*. Windows: `certutil -addstore -f Root pch-ca.crt` (admin). Android: Settings → Security → Install a certificate → CA certificate.

The server certificate is valid for 800 days (iOS rejects longer). Re-run `gen-cert.sh` to renew; the CA is reused.

### iPad operation

1. Open the gateway URL in Safari, sign in.
2. Share → **Add to Home Screen**. Launch from the icon for a full-screen, landscape surface without browser chrome.
3. Turn on **Settings → Accessibility → Guided Access** to lock the iPad to PCH during a show (optional).
4. Disable Auto-Lock or use HTTPS so the wake lock keeps the screen on.

If the iPad sleeps or Wi-Fi drops, the surface shows a red banner and disables keys; it reconnects automatically when the iPad wakes. Keys held at that moment are released by the gateway.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Tablet cannot open the page | `PCH_HOST` is not `127.0.0.1`; firewall allows TCP 8420 on private networks; both devices on the same subnet/VLAN; try `http://<ip>:8420/api/health` |
| "Forbidden" on every request | Client address is not private (e.g. coming through a public proxy/VPN). Keep clients on the LAN. |
| Signed in but immediately signed out on iPad | Using HTTPS with an untrusted cert, or mixing `http` and `https` URLs. Install the CA with full trust. |
| Companion lamp red, "No BEGIN received" | Wrong port (e.g. Companion's web UI 8000 instead of 16622), or Satellite listener disabled in Companion settings |
| Companion lamp red, "ECONNREFUSED" / timeout | Companion not running, wrong IP, firewall on Computer A blocking 16622/16623 |
| Mapped keys say "Turn on button subscriptions…" | Companion supports them but the setting is off: enable button subscriptions in Companion's Settings → Satellite |
| Mapped keys say "need Satellite API 1.10+" | Upgrade Companion, use a Companion surface profile, or configure the HTTP fallback port |
| Surface navigation bar buttons disabled | Satellite API < 1.10, or page changes not allowed: in Companion, open the `pch-…` surface's settings and enable the PCH page-change option |
| Keys show "stale" | Companion link dropped; images are from before the drop. Keys are disabled until fresh state arrives. |
| Protocol detail | Settings → Diagnostics shows the last 200 Satellite protocol lines (admins) |

## Optional: Docker

```bash
docker build -t pch .
docker run -d --name pch -p 8420:8420 -v pch-data:/data --env-file .env pch
```

Inside a container, `PCH_HOST` must be `0.0.0.0`. Client addresses seen through Docker's NAT are private, so the private-network guard still applies but cannot distinguish LAN from host. Prefer native installs on show machines. (The Dockerfile is provided but was not exercised in this build's test environment.)
