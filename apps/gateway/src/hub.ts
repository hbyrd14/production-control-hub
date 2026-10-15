import type { CompanionKeyState } from '@pch/companion-adapter';
import {
  ClientMessageSchema,
  KEY_COUNT,
  GRID_COLUMNS,
  applyNav,
  locationKey,
  normalizeNav,
  roleCan,
  type CompanionLocation,
  type KeyView,
  type NavState,
  type Profile,
  type ServerMessage,
  type SessionUser,
  type Slot,
  type ViewSnapshot,
  PCH_VERSION,
} from '@pch/shared';
import { RateLimiter } from './auth.js';
import type { CompanionService } from './companion-service.js';
import { InteractionEngine, targetKey, type Effect, type KeyConfig, type Target } from './interactions.js';
import type { Logger } from './logger.js';
import type { Store } from './store.js';

export interface HubClient {
  id: string;
  user: SessionUser;
  sessionHash: string;
  ip: string | null;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

interface ClientCtx extends HubClient {
  nav: NavState | null;
  subs: Set<string>;
  ready: boolean;
}

export function subIdFor(l: CompanionLocation): string {
  return `pch_${l.page}_${l.row}_${l.column}`;
}

export function deviceIdFor(surfaceId: string): string {
  return `pch-${surfaceId}`;
}

const SURFACE_PRODUCT = 'Production Control Hub';

export class Hub {
  private clients = new Map<string, ClientCtx>();
  private profiles: Profile[] = [];
  private surfaceStates = new Map<string, (CompanionKeyState | null)[]>();
  private subStates = new Map<string, CompanionKeyState>();
  private subLocations = new Map<string, CompanionLocation>();
  private subRefs = new Map<string, Set<string>>();
  private pressCounts = new Map<string, number>();
  private stale = false;
  private readyEpoch = -1;
  private sharedNav: NavState | null = null;
  private registeredDevices = new Set<string>();
  private readonly engine: InteractionEngine;
  private readonly pressLimiter = new RateLimiter(40, 1000);

  constructor(
    private readonly store: Store,
    private readonly companion: CompanionService,
    private readonly log: Logger,
    private readonly opts: { auditPresses: boolean },
  ) {
    this.engine = new InteractionEngine((key, effect) => this.onEffect(key, effect));
    const a = companion.adapter;
    a.on('keyState', (deviceId, index, st) => this.onSurfaceKey(deviceId, index, st));
    a.on('keysClear', (deviceId) => this.onKeysClear(deviceId));
    a.on('subState', (subId, st) => this.onSubState(subId, st));
    a.on('surfaceError', (deviceId, m) => this.broadcast({ type: 'notice', level: 'error', message: `Companion rejected surface ${deviceId}: ${m}` }));
    a.on('subError', (subId, m) => this.log.warn(`subscription ${subId} failed: ${m}`));
    a.on('surfaceRegistered', () => this.refreshAll());
    companion.on('status', (status) => {
      if (status.state !== 'connected') this.onCompanionLost();
      else this.onCompanionReady();
      this.broadcast({ type: 'status', companion: status });
    });
    this.reloadProfiles();
  }

  /* ------------------------------------------------------------------ */
  /* Client lifecycle                                                    */
  /* ------------------------------------------------------------------ */

  attach(client: HubClient): void {
    const ctx: ClientCtx = { ...client, nav: null, subs: new Set(), ready: false };
    this.clients.set(client.id, ctx);
    ctx.send({ type: 'welcome', user: client.user, clientId: client.id, version: PCH_VERSION });
    ctx.send({ type: 'status', companion: this.companion.status() });
  }

  detach(clientId: string): void {
    const c = this.clients.get(clientId);
    if (!c) return;
    // Safe release: anything this browser was holding is released now.
    this.engine.cancelPrefix(`${clientId}:`);
    this.setClientSubs(c, new Set());
    this.clients.delete(clientId);
  }

  clientCount(): number {
    return this.clients.size;
  }

  clientSummaries() {
    return [...this.clients.values()].map((c) => ({ id: c.id, user: c.user.username, role: c.user.role, ip: c.ip, profileId: c.nav?.profileId ?? null, pageId: c.nav?.pageId ?? null }));
  }

  /** Close every connection belonging to a user (role change, disable, logout everywhere). */
  disconnectUser(userId: string, code: number, reason: string): void {
    for (const c of this.clients.values()) if (c.user.id === userId) c.close(code, reason);
  }

  disconnectSession(sessionHash: string, code: number, reason: string): void {
    for (const c of this.clients.values()) if (c.sessionHash === sessionHash) c.close(code, reason);
  }

  handleMessage(clientId: string, raw: string): void {
    const c = this.clients.get(clientId);
    if (!c) return;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return c.send({ type: 'notice', level: 'error', message: 'Malformed message' });
    }
    const parsed = ClientMessageSchema.safeParse(data);
    if (!parsed.success) return c.send({ type: 'notice', level: 'error', message: 'Invalid message' });
    const msg = parsed.data;
    switch (msg.type) {
      case 'ping':
        return c.send({ type: 'pong', t: msg.t });
      case 'hello':
        c.ready = true;
        this.setNav(c, this.gatewayNavMode() === 'shared' ? this.getSharedNav() : (msg.nav ?? null), false);
        return;
      case 'key':
        return this.onKey(c, msg.action, msg.index);
      case 'releaseAll':
        this.engine.cancelPrefix(`${c.id}:`);
        return;
      case 'nav':
        return this.onNav(c, msg.action, msg.target ?? null);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Profiles & settings changes                                         */
  /* ------------------------------------------------------------------ */

  reloadProfiles(): void {
    this.profiles = this.store.listProfiles();
    this.syncSurfaces();
  }

  /** Call after any profile CRUD. Re-validates every client's navigation. */
  onProfilesChanged(): void {
    this.reloadProfiles();
    if (this.sharedNav) this.sharedNav = this.normalize(this.sharedNav);
    for (const c of this.clients.values()) {
      if (!c.ready) continue;
      c.send({ type: 'profilesChanged' });
      this.setNav(c, c.nav, true);
    }
  }

  onGatewaySettingsChanged(): void {
    for (const c of this.clients.values()) if (c.ready) this.setNav(c, this.gatewayNavMode() === 'shared' ? this.getSharedNav() : c.nav, true);
  }

  private gatewayNavMode() {
    return this.store.getGatewaySettings().navigationMode;
  }

  private defaultProfile(): Profile | null {
    const id = this.store.getGatewaySettings().defaultProfileId;
    return this.profiles.find((p) => p.id === id) ?? this.profiles[0] ?? null;
  }

  private getSharedNav(): NavState | null {
    if (!this.sharedNav) {
      const p = this.defaultProfile();
      this.sharedNav = p ? normalizeNav(p.id, p, null) : null;
    }
    return this.sharedNav;
  }

  private normalize(nav: Partial<NavState> | null): NavState | null {
    const profile = this.profiles.find((p) => p.id === nav?.profileId) ?? this.defaultProfile();
    if (!profile) return null;
    return normalizeNav(profile.id, profile, profile.id === nav?.profileId ? nav : null);
  }

  private syncSurfaces(): void {
    const desired = new Set(this.profiles.filter((p) => p.kind === 'surface' && p.surfaceId).map((p) => deviceIdFor(p.surfaceId!)));
    for (const d of this.registeredDevices) {
      if (!desired.has(d)) {
        this.companion.adapter.removeSurface(d);
        this.surfaceStates.delete(d);
        this.registeredDevices.delete(d);
      }
    }
    for (const d of desired) {
      if (this.registeredDevices.has(d)) continue;
      this.registeredDevices.add(d);
      this.companion.adapter.addSurface({ deviceId: d, productName: SURFACE_PRODUCT, keysTotal: KEY_COUNT, keysPerRow: GRID_COLUMNS, canChangePageLabel: 'Allow page changes from Production Control Hub' });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Navigation                                                          */
  /* ------------------------------------------------------------------ */

  private setNav(c: ClientCtx, nav: Partial<NavState> | null, force: boolean): void {
    const next = this.normalize(nav);
    const changed = force || JSON.stringify(next) !== JSON.stringify(c.nav);
    if (changed && c.nav && (c.nav.profileId !== next?.profileId || c.nav.pageId !== next?.pageId)) {
      // Never carry a held key across a page/profile change.
      this.engine.cancelPrefix(`${c.id}:`);
    }
    c.nav = next;
    this.setClientSubs(c, this.subsForView(c));
    c.send({ type: 'view', view: this.viewSnapshot(c) });
    c.send({ type: 'keys', keys: this.computeKeys(c) });
  }

  private onNav(c: ClientCtx, action: string, target: string | null): void {
    const profile = this.profileOf(c);
    if (!profile || !c.nav) return;
    const shared = this.gatewayNavMode() === 'shared';
    if (action === 'companion-next' || action === 'companion-prev') {
      if (!roleCan.press(c.user.role)) return this.reject(c, -1, 'Read-only account');
      if (profile.kind !== 'surface' || !profile.surfaceId) return;
      const r = this.companion.adapter.selectPage(deviceIdFor(profile.surfaceId), action === 'companion-next' ? 'next' : 'previous');
      if (!r.ok) c.send({ type: 'notice', level: 'warn', message: r.reason });
      return;
    }
    if (shared && !roleCan.press(c.user.role)) {
      return c.send({ type: 'notice', level: 'warn', message: 'Shared navigation: read-only accounts cannot change pages' });
    }
    let next: NavState | null = c.nav;
    if (action === 'profile') {
      const p = this.profiles.find((x) => x.id === target);
      if (!p) return c.send({ type: 'notice', level: 'warn', message: 'Profile not found' });
      next = normalizeNav(p.id, p, null);
    } else if (action === 'next' || action === 'prev' || action === 'back') {
      next = applyNav(profile, c.nav, { action });
    } else if ((action === 'goto' || action === 'folder') && target) {
      next = applyNav(profile, c.nav, { action, target });
    }
    if (shared) {
      this.sharedNav = next;
      for (const other of this.clients.values()) if (other.ready) this.setNav(other, next, false);
    } else {
      this.setNav(c, next, false);
    }
  }

  private profileOf(c: ClientCtx): Profile | null {
    return this.profiles.find((p) => p.id === c.nav?.profileId) ?? null;
  }

  private pageOf(c: ClientCtx) {
    const p = this.profileOf(c);
    return p?.pages.find((pg) => pg.id === c.nav?.pageId) ?? null;
  }

  private viewSnapshot(c: ClientCtx): ViewSnapshot {
    const p = this.profileOf(c);
    const page = this.pageOf(c);
    let companionPage: number | null = null;
    if (p?.kind === 'surface' && p.surfaceId) {
      const loc = this.surfaceStates.get(deviceIdFor(p.surfaceId))?.find((s) => s?.location)?.location;
      companionPage = loc ? Number(loc.split('/')[0]) : null;
    }
    return {
      profile: p ? { id: p.id, name: p.name, kind: p.kind, revision: p.revision, layout: p.layout } : null,
      page: page ? { id: page.id, name: page.name, isFolder: page.isFolder } : null,
      nav: c.nav,
      pages: p?.pages.map((pg) => ({ id: pg.id, name: pg.name, isFolder: pg.isFolder })) ?? [],
      profiles: this.profiles.map((x) => ({ id: x.id, name: x.name, kind: x.kind })),
      navigationMode: this.gatewayNavMode(),
      companionPage,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Subscriptions                                                       */
  /* ------------------------------------------------------------------ */

  private subsForView(c: ClientCtx): Set<string> {
    const page = this.pageOf(c);
    const out = new Set<string>();
    if (!page) return out;
    for (const s of page.slots) {
      if (s.kind !== 'companion') continue;
      for (const l of [s.location, s.mode === 'double' ? s.secondary : null]) {
        if (!l) continue;
        const id = subIdFor(l);
        this.subLocations.set(id, l);
        out.add(id);
      }
    }
    return out;
  }

  private setClientSubs(c: ClientCtx, next: Set<string>): void {
    for (const id of c.subs) {
      if (next.has(id)) continue;
      const refs = this.subRefs.get(id);
      refs?.delete(c.id);
      if (refs && refs.size === 0) {
        this.subRefs.delete(id);
        this.subStates.delete(id);
        this.companion.adapter.unsubscribe(id);
      }
    }
    for (const id of next) {
      if (c.subs.has(id)) continue;
      let refs = this.subRefs.get(id);
      if (!refs) {
        refs = new Set();
        this.subRefs.set(id, refs);
        this.companion.adapter.subscribe(id, this.subLocations.get(id)!);
      }
      refs.add(c.id);
    }
    c.subs = next;
  }

  /* ------------------------------------------------------------------ */
  /* Key views                                                           */
  /* ------------------------------------------------------------------ */

  private computeKeys(c: ClientCtx): KeyView[] {
    return Array.from({ length: KEY_COUNT }, (_, i) => this.keyView(c, i));
  }

  private keyView(c: ClientCtx, index: number): KeyView {
    const base: KeyView = {
      index,
      source: 'empty',
      image: null,
      text: null,
      textColor: null,
      background: null,
      fontSize: null,
      pressed: false,
      stale: false,
      style: null,
      kind: 'empty',
      mode: null,
      holdMs: null,
      navAction: null,
      companionType: null,
      disabledReason: null,
      location: null,
    };
    const profile = this.profileOf(c);
    if (!profile) return { ...base, source: 'unavailable', disabledReason: 'No profile configured' };
    const connected = this.companion.adapter.isConnected();

    if (profile.kind === 'surface') {
      const deviceId = deviceIdFor(profile.surfaceId ?? 'main');
      const st = this.surfaceStates.get(deviceId)?.[index] ?? null;
      const v: KeyView = { ...base, kind: 'surface', mode: 'passthrough' };
      if (st) Object.assign(v, fromCompanion(st), { stale: this.stale });
      else v.source = 'unavailable';
      if (!connected) v.disabledReason = 'Companion offline';
      else if (!this.companion.adapter.isSurfaceRegistered(deviceId)) v.disabledReason = 'Registering surface with Companion…';
      else if (!st) v.disabledReason = 'Waiting for Companion';
      if (st) v.location = st.location;
      return v;
    }

    const page = this.pageOf(c);
    const slot: Slot | undefined = page?.slots[index];
    if (!slot || slot.kind === 'empty') return base;

    if (slot.kind === 'nav') {
      const v: KeyView = { ...base, source: 'pch', kind: 'nav', style: slot.style, navAction: slot.action };
      if ((slot.action === 'goto' || slot.action === 'folder') && !profile.pages.some((p) => p.id === slot.target)) v.disabledReason = 'Target page missing';
      if (slot.action === 'profile' && !this.profiles.some((p) => p.id === slot.target)) v.disabledReason = 'Target profile missing';
      if (slot.action === 'back' && (c.nav?.folderStack.length ?? 0) === 0) v.disabledReason = 'Already at top level';
      if (slot.action === 'companion-next' || slot.action === 'companion-prev') v.disabledReason = 'Only available on Companion surface profiles';
      return v;
    }

    // Companion-mapped key
    const subId = subIdFor(slot.location);
    const v: KeyView = { ...base, kind: 'companion', mode: slot.mode, holdMs: slot.mode === 'hold' ? slot.holdMs : null, location: locationKey(slot.location), style: slot.style };
    const st = this.subStates.get(subId);
    if (st) Object.assign(v, fromCompanion(st), { stale: this.stale });
    else v.source = slot.presentation === 'pch' ? 'pch' : 'unavailable';
    if (slot.presentation === 'pch') v.source = 'pch';

    if (!connected) {
      v.disabledReason = 'Companion offline';
    } else if (!this.companion.adapter.supportsSubscriptions()) {
      if (this.companion.canUseHttpFallback()) {
        v.source = 'pch'; // no imagery without subscriptions; show PCH style
        v.disabledReason = null;
      } else {
        v.source = 'unavailable';
        v.disabledReason = 'Mapped keys need Companion Satellite API 1.10+ (or enable the HTTP fallback)';
      }
    } else if (!st) {
      v.disabledReason = 'Waiting for Companion';
    }
    return v;
  }

  private sendKeyToClientsShowing(predicate: (c: ClientCtx, index: number) => boolean): void {
    for (const c of this.clients.values()) {
      if (!c.ready) continue;
      for (let i = 0; i < KEY_COUNT; i++) if (predicate(c, i)) c.send({ type: 'key', key: this.keyView(c, i) });
    }
  }

  private refreshAll(): void {
    for (const c of this.clients.values()) if (c.ready) c.send({ type: 'keys', keys: this.computeKeys(c) });
  }

  /* ------------------------------------------------------------------ */
  /* Companion events                                                    */
  /* ------------------------------------------------------------------ */

  private onSurfaceKey(deviceId: string, index: number, st: CompanionKeyState): void {
    if (index < 0 || index >= KEY_COUNT) return;
    let arr = this.surfaceStates.get(deviceId);
    if (!arr) {
      arr = Array.from({ length: KEY_COUNT }, () => null);
      this.surfaceStates.set(deviceId, arr);
    }
    const prevPage = arr.find((s) => s?.location)?.location?.split('/')[0];
    arr[index] = st;
    const newPage = st.location?.split('/')[0];
    const onDevice = (c: ClientCtx) => {
      const p = this.profileOf(c);
      return p?.kind === 'surface' && deviceIdFor(p.surfaceId ?? '') === deviceId;
    };
    this.sendKeyToClientsShowing((c, i) => i === index && onDevice(c));
    if (newPage && newPage !== prevPage) {
      for (const c of this.clients.values()) if (c.ready && onDevice(c)) c.send({ type: 'view', view: this.viewSnapshot(c) });
    }
  }

  private onKeysClear(deviceId: string): void {
    const arr = this.surfaceStates.get(deviceId);
    if (!arr) return;
    arr.fill(null);
    this.refreshAll();
  }

  private onSubState(subId: string, st: CompanionKeyState): void {
    if (!this.subRefs.has(subId)) return;
    this.subStates.set(subId, st);
    const refs = this.subRefs.get(subId)!;
    this.sendKeyToClientsShowing((c, i) => {
      if (!refs.has(c.id)) return false;
      const s = this.pageOf(c)?.slots[i];
      return s?.kind === 'companion' && subIdFor(s.location) === subId;
    });
  }

  private onCompanionLost(): void {
    // Forget every in-flight gesture. Nothing is replayed when the link returns.
    this.engine.resetAll();
    this.pressCounts.clear();
    if (!this.stale) {
      this.stale = true;
      this.refreshAll();
    }
  }

  private onCompanionReady(): void {
    const epoch = this.companion.adapter.getConnectionState().epoch;
    if (epoch === this.readyEpoch) return;
    this.readyEpoch = epoch;
    this.stale = false;
    // Fresh KEY-STATE / SUB-STATE will follow from Companion; drop stale imagery now.
    this.surfaceStates.clear();
    this.subStates.clear();
    this.refreshAll();
  }

  /* ------------------------------------------------------------------ */
  /* Key presses                                                         */
  /* ------------------------------------------------------------------ */

  private reject(c: ClientCtx, index: number, message: string): void {
    c.send({ type: 'feedback', index, state: 'rejected', message });
  }

  private onKey(c: ClientCtx, action: 'down' | 'up' | 'cancel', index: number): void {
    const key = `${c.id}:${index}`;
    if (action === 'up') return this.engine.up(key);
    if (action === 'cancel') return this.engine.cancel(key);

    if (!roleCan.press(c.user.role)) return this.reject(c, index, 'Read-only account');
    if (!this.pressLimiter.take(c.id)) return this.reject(c, index, 'Too many presses; slow down');

    const profile = this.profileOf(c);
    if (!profile) return this.reject(c, index, 'No profile');

    if (profile.kind === 'surface') {
      const deviceId = deviceIdFor(profile.surfaceId ?? 'main');
      if (!this.companion.adapter.isConnected()) return this.reject(c, index, 'Companion offline — command not sent');
      if (!this.companion.adapter.isSurfaceRegistered(deviceId)) return this.reject(c, index, 'Surface not registered with Companion');
      return this.engine.down(key, { mode: 'passthrough', holdMs: 0, windowMs: 0, primary: { kind: 'surface', deviceId, index }, secondary: null });
    }

    const slot = this.pageOf(c)?.slots[index];
    if (!slot || slot.kind === 'empty') return;
    if (slot.kind === 'nav') {
      if (slot.action === 'companion-next' || slot.action === 'companion-prev') return;
      return this.onNav(c, slot.action, slot.target);
    }

    if (!this.companion.adapter.isConnected()) return this.reject(c, index, 'Companion offline — command not sent');
    const useSubs = this.companion.adapter.supportsSubscriptions();
    if (!useSubs && !this.companion.canUseHttpFallback()) return this.reject(c, index, 'Companion does not support mapped keys');
    const toTarget = (l: CompanionLocation): Target =>
      useSubs ? { kind: 'sub', subId: subIdFor(l), location: locationKey(l) } : { kind: 'http', location: locationKey(l) };
    const cfg: KeyConfig = {
      mode: slot.mode,
      holdMs: slot.holdMs,
      windowMs: slot.windowMs,
      primary: toTarget(slot.location),
      secondary: slot.secondary ? toTarget(slot.secondary) : null,
    };
    if (useSubs && !this.companion.adapter.isSubscribed(subIdFor(slot.location))) return this.reject(c, index, 'Waiting for Companion');
    this.engine.down(key, cfg);
  }

  private onEffect(key: string, effect: Effect): void {
    const sep = key.lastIndexOf(':');
    const clientId = key.slice(0, sep);
    const index = Number(key.slice(sep + 1));
    const c = this.clients.get(clientId);
    if (effect.type === 'feedback') {
      c?.send({ type: 'feedback', index, state: effect.state });
      return;
    }
    if (effect.type === 'down') this.pressTarget(effect.target, c ?? null, index);
    else this.releaseTarget(effect.target);
  }

  /** Reference-counted so two operators holding the same key never double-trigger or release early. */
  private pressTarget(t: Target, c: ClientCtx | null, index: number): void {
    const k = targetKey(t);
    const n = this.pressCounts.get(k) ?? 0;
    this.pressCounts.set(k, n + 1);
    if (n > 0) return;
    const result =
      t.kind === 'surface'
        ? this.companion.adapter.pressButton(t.deviceId, t.index)
        : t.kind === 'sub'
          ? this.companion.adapter.pressSubscription(t.subId)
          : this.httpPress(t.location, 'down', c, index);
    if (!result.ok) {
      this.pressCounts.delete(k);
      if (c) this.reject(c, index, result.reason);
      return;
    }
    if (this.opts.auditPresses && c) {
      this.store.audit('key.press', { id: c.user.id, username: c.user.username }, { target: k, index }, c.ip);
    }
  }

  private releaseTarget(t: Target): void {
    const k = targetKey(t);
    const n = this.pressCounts.get(k) ?? 0;
    if (n === 0) return;
    if (n > 1) {
      this.pressCounts.set(k, n - 1);
      return;
    }
    this.pressCounts.delete(k);
    if (t.kind === 'surface') this.companion.adapter.releaseButton(t.deviceId, t.index);
    else if (t.kind === 'sub') this.companion.adapter.releaseSubscription(t.subId);
    else this.httpPress(t.location, 'up', null, -1);
  }

  private httpPress(location: string, dir: 'down' | 'up', c: ClientCtx | null, index: number): { ok: true } | { ok: false; reason: string } {
    const http = this.companion.httpFallback();
    if (!http) return { ok: false, reason: 'HTTP fallback not configured' };
    const [page, row, column] = location.split('/').map(Number) as [number, number, number];
    const p = dir === 'down' ? http.down({ page, row, column }) : http.up({ page, row, column });
    p.catch((err: Error) => {
      this.log.warn(`HTTP fallback ${dir} ${location} failed: ${err.message}`);
      if (c) this.reject(c, index, `Companion HTTP error: ${err.message}`);
    });
    return { ok: true };
  }

  broadcast(msg: ServerMessage): void {
    for (const c of this.clients.values()) c.send(msg);
  }
}

function fromCompanion(st: CompanionKeyState): Partial<KeyView> {
  return {
    source: 'companion',
    image: st.image,
    text: st.text,
    textColor: st.textColor,
    background: st.color,
    fontSize: st.fontSize,
    pressed: st.pressed,
    companionType: st.type,
  };
}
