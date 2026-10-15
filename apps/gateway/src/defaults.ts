import { emptySlots, keyIndex, type ProfileBody, type Slot } from '@pch/shared';

/**
 * Example profiles created on first run. The mapped profile assumes Companion pages 1 and 2
 * are laid out like the bundled example (see docs/COMPANION_SETUP.md); edit freely.
 */

function companion(page: number, row: number, column: number, extra: Partial<Extract<Slot, { kind: 'companion' }>> = {}): Slot {
  return {
    kind: 'companion',
    location: { page, row, column },
    mode: 'passthrough',
    holdMs: 800,
    windowMs: 350,
    secondary: null,
    presentation: 'companion',
    style: { label: '', textColor: '#ffffff', background: '#1f2430', fontSize: 14, placement: 'center', icon: '', image: null },
    ...extra,
  };
}

function nav(action: Extract<Slot, { kind: 'nav' }>['action'], label: string, target: string | null = null, background = '#30343f', icon = ''): Slot {
  return {
    kind: 'nav',
    action,
    target,
    style: { label, textColor: '#e5e7eb', background, fontSize: 13, placement: icon ? 'bottom' : 'center', icon, image: null },
  };
}

function mirrorPage(companionPage: number): Slot[] {
  const slots = emptySlots();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 8; c++) slots[keyIndex(r, c)] = companion(companionPage, r, c);
  for (let c = 0; c < 5; c++) slots[keyIndex(3, c)] = companion(companionPage, 3, c);
  return slots;
}

export function defaultProfiles(): ProfileBody[] {
  const atem = mirrorPage(1);
  atem[keyIndex(3, 5)] = nav('folder', 'Safety', 'safety', '#4a3b12', '⚠');
  atem[keyIndex(3, 6)] = nav('prev', 'Prev', null, '#30343f', '◀');
  atem[keyIndex(3, 7)] = nav('next', 'Next', null, '#30343f', '▶');

  const vmix = mirrorPage(2);
  vmix[keyIndex(3, 5)] = nav('folder', 'Safety', 'safety', '#4a3b12', '⚠');
  vmix[keyIndex(3, 6)] = nav('prev', 'Prev', null, '#30343f', '◀');
  vmix[keyIndex(3, 7)] = nav('next', 'Next', null, '#30343f', '▶');

  const safety = emptySlots();
  safety[keyIndex(0, 0)] = companion(2, 2, 7, { mode: 'hold', holdMs: 1200 }); // vMix STREAM
  safety[keyIndex(0, 1)] = companion(2, 2, 6, { mode: 'confirm' }); // vMix REC
  safety[keyIndex(0, 2)] = companion(1, 2, 7, { mode: 'hold', holdMs: 1000 }); // ATEM FTB
  safety[keyIndex(1, 0)] = companion(1, 0, 7, { mode: 'double', secondary: { page: 1, row: 1, column: 7 } }); // CUT / double = AUTO
  safety[keyIndex(3, 0)] = nav('back', 'Back', null, '#30343f', '⤺');

  return [
    {
      name: 'Show Control',
      kind: 'mapped',
      surfaceId: null,
      layout: { gapPx: 10, radiusPx: 10, showLabels: true, pinnedNav: true },
      pages: [
        { id: 'atem', name: 'ATEM', isFolder: false, slots: atem },
        { id: 'vmix', name: 'vMix', isFolder: false, slots: vmix },
        { id: 'safety', name: 'Safety Controls', isFolder: true, slots: safety },
      ],
    },
    {
      name: 'Companion Surface',
      kind: 'surface',
      surfaceId: 'main',
      layout: { gapPx: 10, radiusPx: 10, showLabels: true, pinnedNav: true },
      pages: [],
    },
  ];
}
