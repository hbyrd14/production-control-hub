import { z } from 'zod';
import type { Page, ProfileBody } from './model.js';

export const NavStateSchema = z.object({
  profileId: z.string().max(64),
  pageId: z.string().max(64).nullable(),
  folderStack: z.array(z.string().max(64)).max(16).default([]),
});
export type NavState = z.infer<typeof NavStateSchema>;

function rootPages(profile: Pick<ProfileBody, 'pages'>): Page[] {
  return profile.pages.filter((p) => !p.isFolder);
}

/** Return a valid nav state for this profile, repairing anything stale (deleted pages, etc.). */
export function normalizeNav(profileId: string, profile: Pick<ProfileBody, 'pages' | 'kind'>, nav: Partial<NavState> | null | undefined): NavState {
  if (profile.kind === 'surface') return { profileId, pageId: null, folderStack: [] };
  const ids = new Set(profile.pages.map((p) => p.id));
  const first = rootPages(profile)[0]?.id ?? profile.pages[0]?.id ?? null;
  const pageId = nav?.pageId && ids.has(nav.pageId) ? nav.pageId : first;
  const folderStack = (nav?.folderStack ?? []).filter((id) => ids.has(id));
  // If the current page is not a folder, any stack is meaningless.
  const current = profile.pages.find((p) => p.id === pageId);
  return { profileId, pageId, folderStack: current?.isFolder ? folderStack : [] };
}

export type NavCommand =
  | { action: 'next' }
  | { action: 'prev' }
  | { action: 'goto'; target: string }
  | { action: 'folder'; target: string }
  | { action: 'back' };

export function applyNav(profile: Pick<ProfileBody, 'pages' | 'kind'>, nav: NavState, cmd: NavCommand): NavState {
  if (profile.kind === 'surface') return nav;
  const roots = rootPages(profile);
  const exists = (id: string) => profile.pages.some((p) => p.id === id);
  switch (cmd.action) {
    case 'next':
    case 'prev': {
      if (roots.length === 0) return nav;
      const base = nav.folderStack[0] ?? nav.pageId;
      const idx = Math.max(0, roots.findIndex((p) => p.id === base));
      const delta = cmd.action === 'next' ? 1 : -1;
      const nextIdx = (idx + delta + roots.length) % roots.length;
      return { ...nav, pageId: roots[nextIdx]!.id, folderStack: [] };
    }
    case 'goto':
      if (!exists(cmd.target)) return nav;
      return { ...nav, pageId: cmd.target, folderStack: [] };
    case 'folder':
      if (!exists(cmd.target) || cmd.target === nav.pageId || !nav.pageId) return nav;
      if (nav.folderStack.length >= 16) return nav;
      return { ...nav, pageId: cmd.target, folderStack: [...nav.folderStack, nav.pageId] };
    case 'back': {
      if (nav.folderStack.length === 0) return nav;
      const stack = [...nav.folderStack];
      const parent = stack.pop()!;
      return { ...nav, pageId: parent, folderStack: stack };
    }
  }
}
