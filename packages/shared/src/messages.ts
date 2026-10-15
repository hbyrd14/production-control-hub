import { z } from 'zod';
import { KEY_COUNT } from './grid.js';
import { NavStateSchema, type NavState } from './navigation.js';
import type { InteractionMode, KeyStyle, LayoutPrefs, NavigationMode, ProfileKind, Role } from './model.js';

/* ------------------------------------------------------------------ */
/* Browser → gateway                                                   */
/* ------------------------------------------------------------------ */

const keyIndex = z.number().int().min(0).max(KEY_COUNT - 1);

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), nav: NavStateSchema.nullable().optional() }),
  z.object({ type: z.literal('key'), action: z.enum(['down', 'up', 'cancel']), index: keyIndex }),
  z.object({
    type: z.literal('nav'),
    action: z.enum(['next', 'prev', 'goto', 'folder', 'back', 'profile', 'companion-next', 'companion-prev']),
    target: z.string().max(64).optional(),
  }),
  /** Sent when the page is hidden/backgrounded: release anything this client holds. */
  z.object({ type: z.literal('releaseAll') }),
  z.object({ type: z.literal('ping'), t: z.number() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/* ------------------------------------------------------------------ */
/* Gateway → browser                                                   */
/* ------------------------------------------------------------------ */

export type CompanionConnectionState = 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'backoff';

export interface CompanionStatus {
  state: CompanionConnectionState;
  host: string | null;
  port: number | null;
  transport: 'tcp' | 'websocket' | null;
  apiVersion: string | null;
  companionVersion: string | null;
  capabilities: string[];
  supportsSubscriptions: boolean;
  supportsPageChange: boolean;
  lastError: string | null;
  nextRetryAt: number | null;
  connectedSince: number | null;
  attempt: number;
}

export type KeySource = 'empty' | 'companion' | 'pch' | 'unavailable';

export interface KeyView {
  index: number;
  source: KeySource;
  /** PNG data URL from Companion (when source = companion) */
  image: string | null;
  text: string | null;
  textColor: string | null;
  background: string | null;
  fontSize: number | null;
  /** Companion-reported pressed state */
  pressed: boolean;
  /** Image is from before the last disconnect and may not reflect current state */
  stale: boolean;
  /** PCH style (nav keys or presentation = pch) */
  style: KeyStyle | null;
  kind: 'empty' | 'companion' | 'nav' | 'surface';
  mode: InteractionMode | null;
  /** For hold-mode keys: how long the operator must hold */
  holdMs: number | null;
  navAction: string | null;
  companionType: 'BUTTON' | 'PAGEUP' | 'PAGEDOWN' | 'PAGENUM' | null;
  /** If set, the key cannot be operated and this explains why */
  disabledReason: string | null;
  /** Companion location this key is bound to, for display in the editor */
  location: string | null;
}

export interface ViewSnapshot {
  profile: { id: string; name: string; kind: ProfileKind; revision: number; layout: LayoutPrefs } | null;
  page: { id: string; name: string; isFolder: boolean } | null;
  nav: NavState | null;
  pages: { id: string; name: string; isFolder: boolean }[];
  profiles: { id: string; name: string; kind: ProfileKind }[];
  navigationMode: NavigationMode;
  companionPage: number | null;
}

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
}

export type ServerMessage =
  | { type: 'welcome'; user: SessionUser; clientId: string; version: string }
  | { type: 'status'; companion: CompanionStatus }
  | { type: 'view'; view: ViewSnapshot }
  | { type: 'keys'; keys: KeyView[] }
  | { type: 'key'; key: KeyView }
  | { type: 'feedback'; index: number; state: 'armed' | 'idle' | 'fired' | 'rejected'; message?: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'profilesChanged' }
  | { type: 'pong'; t: number };

export const WS_CLOSE_UNAUTHORIZED = 4401;
export const WS_CLOSE_FORBIDDEN_ORIGIN = 4403;
export const WS_CLOSE_SESSION_ENDED = 4410;
