import { describe, expect, it } from 'vitest';
import { applyNav, normalizeNav } from './navigation.js';
import { emptySlots, ProfileBodySchema, SlotSchema, validateProfileBody, type ProfileBody } from './model.js';
import { keyIndex, keyPosition, KEY_COUNT } from './grid.js';

const profile: ProfileBody = ProfileBodySchema.parse({
  name: 'Test',
  kind: 'mapped',
  pages: [
    { id: 'a', name: 'A', slots: emptySlots() },
    { id: 'f', name: 'Folder', isFolder: true, slots: emptySlots() },
    { id: 'b', name: 'B', slots: emptySlots() },
  ],
});

describe('grid', () => {
  it('maps indexes to an 8 × 4 layout', () => {
    expect(KEY_COUNT).toBe(32);
    expect(keyIndex(3, 7)).toBe(31);
    expect(keyPosition(9)).toEqual({ row: 1, column: 1 });
  });
});

describe('navigation', () => {
  it('cycles through non-folder pages', () => {
    const n0 = normalizeNav('p', profile, null);
    expect(n0.pageId).toBe('a');
    const n1 = applyNav(profile, n0, { action: 'next' });
    expect(n1.pageId).toBe('b'); // folder skipped
    expect(applyNav(profile, n1, { action: 'next' }).pageId).toBe('a');
    expect(applyNav(profile, n0, { action: 'prev' }).pageId).toBe('b');
  });

  it('enters and leaves folders', () => {
    const n0 = normalizeNav('p', profile, { pageId: 'b' });
    const inFolder = applyNav(profile, n0, { action: 'folder', target: 'f' });
    expect(inFolder).toMatchObject({ pageId: 'f', folderStack: ['b'] });
    expect(applyNav(profile, inFolder, { action: 'back' })).toMatchObject({ pageId: 'b', folderStack: [] });
    // next from inside a folder moves relative to the page the folder was opened from
    expect(applyNav(profile, inFolder, { action: 'next' }).pageId).toBe('a');
  });

  it('repairs stale navigation (deleted page)', () => {
    expect(normalizeNav('p', profile, { pageId: 'gone', folderStack: ['x'] })).toEqual({ profileId: 'p', pageId: 'a', folderStack: [] });
  });

  it('surface profiles have no PCH pages', () => {
    expect(normalizeNav('s', { kind: 'surface', pages: [] }, null)).toEqual({ profileId: 's', pageId: null, folderStack: [] });
  });
});

describe('profile validation', () => {
  it('flags missing navigation targets and double-press without a secondary', () => {
    const p = structuredClone(profile);
    p.pages[0]!.slots[0] = SlotSchema.parse({ kind: 'nav', action: 'folder', target: 'nope' });
    p.pages[0]!.slots[1] = SlotSchema.parse({ kind: 'companion', location: { page: 1, row: 0, column: 0 }, mode: 'double' });
    const errors = validateProfileBody(p);
    expect(errors.some((e) => e.includes('target page not found'))).toBe(true);
    expect(errors.some((e) => e.includes('secondary'))).toBe(true);
  });

  it('rejects pages without exactly 32 slots and non-data-URL images', () => {
    expect(ProfileBodySchema.safeParse({ name: 'x', kind: 'mapped', pages: [{ id: 'a', name: 'a', slots: [] }] }).success).toBe(false);
    const slots = emptySlots();
    const bad = { ...slots[0], kind: 'nav', action: 'next', style: { image: 'javascript:alert(1)' } };
    expect(ProfileBodySchema.safeParse({ name: 'x', kind: 'mapped', pages: [{ id: 'a', name: 'a', slots: [bad, ...slots.slice(1)] }] }).success).toBe(false);
  });

  it('requires a surface id for surface profiles', () => {
    expect(validateProfileBody(ProfileBodySchema.parse({ name: 's', kind: 'surface' }))).toContain('Surface profiles require a surfaceId');
  });
});
