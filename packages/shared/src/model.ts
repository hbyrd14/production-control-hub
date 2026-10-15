import { z } from 'zod';
import { KEY_COUNT } from './grid.js';

/* ------------------------------------------------------------------ */
/* Companion addressing                                                */
/* ------------------------------------------------------------------ */

export const CompanionLocationSchema = z.object({
  page: z.number().int().min(1).max(99999),
  row: z.number().int().min(0).max(999),
  column: z.number().int().min(0).max(999),
});
export type CompanionLocation = z.infer<typeof CompanionLocationSchema>;

export function locationKey(l: CompanionLocation): string {
  return `${l.page}/${l.row}/${l.column}`;
}

/* ------------------------------------------------------------------ */
/* Presentation (PCH-owned styling)                                    */
/* ------------------------------------------------------------------ */

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected #RRGGBB');

export const TextPlacementSchema = z.enum(['top', 'center', 'bottom']);
export type TextPlacement = z.infer<typeof TextPlacementSchema>;

/** Max size of an uploaded key image stored in the DB (data URL characters). */
export const MAX_IMAGE_DATA_URL_LENGTH = 300_000;

export const KeyStyleSchema = z.object({
  label: z.string().max(64).default(''),
  textColor: hexColor.default('#ffffff'),
  background: hexColor.default('#1f2430'),
  fontSize: z.number().int().min(8).max(48).default(14),
  placement: TextPlacementSchema.default('center'),
  icon: z.string().max(8).default(''),
  image: z
    .string()
    .max(MAX_IMAGE_DATA_URL_LENGTH)
    .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/, 'Image must be a base64 data URL')
    .nullable()
    .default(null),
});
export type KeyStyle = z.infer<typeof KeyStyleSchema>;

export const DEFAULT_STYLE: KeyStyle = KeyStyleSchema.parse({});

/* ------------------------------------------------------------------ */
/* Slots                                                               */
/* ------------------------------------------------------------------ */

/**
 * How PCH interprets a pointer gesture on a Companion-mapped key.
 *  - passthrough: down/up forwarded 1:1. Companion owns latching, steps, durations. (default)
 *  - confirm:     first tap arms (no command), second tap within window fires a momentary press.
 *  - hold:        command fires only after the key is held for holdMs (safety for high-impact keys).
 *  - double:      single tap fires `location`, double tap fires `secondary` (single is delayed by the window).
 * Only passthrough sends Companion separate down/up; others send a momentary press (down then up).
 */
export const InteractionModeSchema = z.enum(['passthrough', 'confirm', 'hold', 'double']);
export type InteractionMode = z.infer<typeof InteractionModeSchema>;

export const NavActionSchema = z.enum(['next', 'prev', 'goto', 'folder', 'back', 'profile', 'companion-next', 'companion-prev']);
export type NavAction = z.infer<typeof NavActionSchema>;

export const EmptySlotSchema = z.object({ kind: z.literal('empty') });

export const CompanionSlotSchema = z.object({
  kind: z.literal('companion'),
  location: CompanionLocationSchema,
  mode: InteractionModeSchema.default('passthrough'),
  holdMs: z.number().int().min(200).max(5000).default(800),
  windowMs: z.number().int().min(150).max(3000).default(350),
  secondary: CompanionLocationSchema.nullable().default(null),
  /** 'companion' = show Companion's live bitmap (default); 'pch' = show PCH style instead. */
  presentation: z.enum(['companion', 'pch']).default('companion'),
  style: KeyStyleSchema.default({}),
});

export const NavSlotSchema = z.object({
  kind: z.literal('nav'),
  action: NavActionSchema,
  /** page id for goto/folder; profile id for profile */
  target: z.string().max(64).nullable().default(null),
  style: KeyStyleSchema.default({}),
});

export const SlotSchema = z.discriminatedUnion('kind', [EmptySlotSchema, CompanionSlotSchema, NavSlotSchema]);
export type Slot = z.infer<typeof SlotSchema>;
export type CompanionSlot = z.infer<typeof CompanionSlotSchema>;
export type NavSlot = z.infer<typeof NavSlotSchema>;

/* ------------------------------------------------------------------ */
/* Pages & profiles                                                    */
/* ------------------------------------------------------------------ */

export const PageSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  name: z.string().min(1).max(64),
  /** A folder page is only reachable through a folder key; excluded from next/prev cycling. */
  isFolder: z.boolean().default(false),
  slots: z.array(SlotSchema).length(KEY_COUNT),
});
export type Page = z.infer<typeof PageSchema>;

/**
 * Profile kinds:
 *  - surface: PCH registers an 8×4 Satellite surface. Companion decides what is shown and owns paging.
 *  - mapped:  PCH pages/folders; each key maps to an explicit Companion location (Satellite subscriptions, API ≥ 1.10).
 */
export const ProfileKindSchema = z.enum(['surface', 'mapped']);
export type ProfileKind = z.infer<typeof ProfileKindSchema>;

export const LayoutPrefsSchema = z.object({
  gapPx: z.number().int().min(2).max(32).default(10),
  radiusPx: z.number().int().min(0).max(32).default(10),
  showLabels: z.boolean().default(true),
  pinnedNav: z.boolean().default(true),
});
export type LayoutPrefs = z.infer<typeof LayoutPrefsSchema>;

export const ProfileBodySchema = z.object({
  name: z.string().min(1).max(64),
  kind: ProfileKindSchema,
  /** surface profiles: stable Satellite device id suffix (letters/digits/-) */
  surfaceId: z.string().regex(/^[a-zA-Z0-9-]{1,32}$/).nullable().default(null),
  pages: z.array(PageSchema).max(200).default([]),
  layout: LayoutPrefsSchema.default({}),
});
export type ProfileBody = z.infer<typeof ProfileBodySchema>;

export const ProfileSchema = ProfileBodySchema.extend({
  id: z.string(),
  revision: z.number().int().min(1),
  updatedAt: z.string(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const ProfileExportSchema = z.object({
  format: z.literal('pch-profile'),
  version: z.literal(1),
  exportedAt: z.string(),
  profile: ProfileBodySchema,
});
export type ProfileExport = z.infer<typeof ProfileExportSchema>;

export function emptySlots(): Slot[] {
  return Array.from({ length: KEY_COUNT }, () => ({ kind: 'empty' as const }));
}

export function validateProfileBody(body: ProfileBody): string[] {
  const errors: string[] = [];
  if (body.kind === 'surface' && !body.surfaceId) errors.push('Surface profiles require a surfaceId');
  if (body.kind === 'mapped' && body.pages.length === 0) errors.push('Mapped profiles need at least one page');
  if (body.kind === 'mapped' && !body.pages.some((p) => !p.isFolder)) errors.push('Mapped profiles need at least one non-folder page');
  const ids = new Set<string>();
  for (const p of body.pages) {
    if (ids.has(p.id)) errors.push(`Duplicate page id: ${p.id}`);
    ids.add(p.id);
  }
  for (const p of body.pages) {
    p.slots.forEach((s, i) => {
      if (s.kind === 'nav' && (s.action === 'goto' || s.action === 'folder')) {
        if (!s.target || !ids.has(s.target)) errors.push(`Page "${p.name}" key ${i + 1}: navigation target page not found`);
      }
      if (s.kind === 'companion' && s.mode === 'double' && !s.secondary) {
        errors.push(`Page "${p.name}" key ${i + 1}: double-press mode requires a secondary location`);
      }
    });
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* Users & settings                                                    */
/* ------------------------------------------------------------------ */

export const RoleSchema = z.enum(['admin', 'operator', 'viewer']);
export type Role = z.infer<typeof RoleSchema>;

export const roleCan = {
  press: (r: Role) => r === 'admin' || r === 'operator',
  edit: (r: Role) => r === 'admin',
  admin: (r: Role) => r === 'admin',
};

export const CompanionSettingsSchema = z.object({
  host: z.string().min(1).max(253).regex(/^[a-zA-Z0-9.\-:[\]]+$/, 'Host must be an IP address or hostname'),
  port: z.number().int().min(1).max(65535),
  transport: z.enum(['tcp', 'websocket']),
  connectTimeoutMs: z.number().int().min(500).max(60000).default(5000),
  reconnect: z
    .object({
      initialDelayMs: z.number().int().min(100).max(60000).default(1000),
      maxDelayMs: z.number().int().min(500).max(300000).default(30000),
      factor: z.number().min(1.1).max(5).default(2),
    })
    .default({}),
  bitmapSize: z.number().int().min(72).max(288).default(144),
  /** Optional HTTP API base port, used only as a press/release fallback when Satellite subscriptions are unavailable. */
  httpFallbackPort: z.number().int().min(1).max(65535).nullable().default(null),
  enabled: z.boolean().default(true),
});
export type CompanionSettings = z.infer<typeof CompanionSettingsSchema>;

export const NavigationModeSchema = z.enum(['per-client', 'shared']);
export type NavigationMode = z.infer<typeof NavigationModeSchema>;

export const GatewaySettingsSchema = z.object({
  navigationMode: NavigationModeSchema.default('per-client'),
  defaultProfileId: z.string().nullable().default(null),
});
export type GatewaySettings = z.infer<typeof GatewaySettingsSchema>;
