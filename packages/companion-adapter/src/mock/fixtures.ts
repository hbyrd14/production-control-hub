/**
 * Example Companion button layouts used by the mock server and documentation.
 *
 * Each button notes the real Companion action/feedback it stands in for. These are
 * illustrative mappings for the ATEM and vMix Companion modules; exact action names
 * depend on the module version installed in your Companion.
 */

export type MockBehavior =
  | { type: 'program'; group: string; input: number }
  | { type: 'preview'; group: string; input: number }
  | { type: 'cut'; group: string }
  | { type: 'auto'; group: string; durationMs: number }
  | { type: 'latch'; onColor: string }
  | { type: 'momentary' }
  | { type: 'pageup' }
  | { type: 'pagedown' };

export interface MockButton {
  text: string;
  background: string;
  textColor: string;
  behavior: MockBehavior;
  /** What this stands in for in a real Companion configuration */
  models: string;
}

export type MockPage = { name: string; buttons: Record<string, MockButton> };

const btn = (text: string, background: string, behavior: MockBehavior, models: string, textColor = '#ffffff'): MockButton => ({
  text,
  background,
  textColor,
  behavior,
  models,
});

function atemPage(): MockPage {
  const b: Record<string, MockButton> = {};
  for (let i = 0; i < 6; i++) {
    b[`0/${i}`] = btn(`PGM\n${i + 1}`, '#3a1d1d', { type: 'program', group: 'atem', input: i + 1 }, `ATEM: Set program input ${i + 1} + feedback "Tally: program"`);
    b[`1/${i}`] = btn(`PVW\n${i + 1}`, '#1d3a24', { type: 'preview', group: 'atem', input: i + 1 }, `ATEM: Set preview input ${i + 1} + feedback "Tally: preview"`);
  }
  b['0/7'] = btn('CUT', '#5a5a5a', { type: 'cut', group: 'atem' }, 'ATEM: CUT');
  b['1/7'] = btn('AUTO', '#5a5a5a', { type: 'auto', group: 'atem', durationMs: 800 }, 'ATEM: AUTO transition');
  b['2/0'] = btn('USK 1', '#24304a', { type: 'latch', onColor: '#d97706' }, 'ATEM: Upstream key 1 on air toggle + feedback');
  b['2/1'] = btn('DSK 1', '#24304a', { type: 'latch', onColor: '#d97706' }, 'ATEM: Downstream key 1 on air toggle + feedback');
  b['2/2'] = btn('MP1 PLAY', '#2b2b40', { type: 'momentary' }, 'ATEM: Media player 1 play');
  b['2/3'] = btn('MACRO 1', '#40302b', { type: 'momentary' }, 'ATEM: Run macro 1');
  b['2/7'] = btn('FTB', '#401515', { type: 'latch', onColor: '#dc2626' }, 'ATEM: Fade to black toggle + feedback');
  b['3/0'] = btn('ATEM', '#111111', { type: 'momentary' }, 'Label (no action)', '#9ca3af');
  b['3/6'] = btn('PAGE -', '#262626', { type: 'pageup' }, 'Companion page up');
  b['3/7'] = btn('PAGE +', '#262626', { type: 'pagedown' }, 'Companion page down');
  return { name: 'ATEM', buttons: b };
}

function vmixPage(): MockPage {
  const b: Record<string, MockButton> = {};
  for (let i = 0; i < 8; i++) {
    b[`0/${i}`] = btn(`IN ${i + 1}`, '#1d3a24', { type: 'preview', group: 'vmix', input: i + 1 }, `vMix: Preview input ${i + 1} + feedback "Input in preview"`);
    b[`1/${i}`] = btn(`LIVE ${i + 1}`, '#3a1d1d', { type: 'program', group: 'vmix', input: i + 1 }, `vMix: Cut direct to input ${i + 1} + feedback "Input live"`);
  }
  b['2/0'] = btn('PLAY', '#24304a', { type: 'momentary' }, 'vMix: Play input');
  b['2/1'] = btn('PAUSE', '#24304a', { type: 'momentary' }, 'vMix: Pause input');
  b['2/2'] = btn('STOP', '#24304a', { type: 'momentary' }, 'vMix: Restart/stop input');
  b['2/3'] = btn('OVL 1', '#2b2b40', { type: 'latch', onColor: '#d97706' }, 'vMix: Overlay 1 toggle + feedback');
  b['2/4'] = btn('OVL 2', '#2b2b40', { type: 'latch', onColor: '#d97706' }, 'vMix: Overlay 2 toggle + feedback');
  b['2/5'] = btn('MUTE MIC', '#2b2b2b', { type: 'latch', onColor: '#b91c1c' }, 'vMix: Audio mute toggle + feedback');
  b['2/6'] = btn('REC', '#3a1d1d', { type: 'latch', onColor: '#dc2626' }, 'vMix: Start/stop recording + feedback');
  b['2/7'] = btn('STREAM', '#3a1d1d', { type: 'latch', onColor: '#dc2626' }, 'vMix: Start/stop streaming + feedback');
  b['3/0'] = btn('CUT', '#5a5a5a', { type: 'cut', group: 'vmix' }, 'vMix: Cut');
  b['3/1'] = btn('FADE', '#5a5a5a', { type: 'auto', group: 'vmix', durationMs: 600 }, 'vMix: Fade');
  b['3/6'] = btn('PAGE -', '#262626', { type: 'pageup' }, 'Companion page up');
  b['3/7'] = btn('PAGE +', '#262626', { type: 'pagedown' }, 'Companion page down');
  return { name: 'vMix', buttons: b };
}

export function defaultMockPages(): Map<number, MockPage> {
  return new Map([
    [1, atemPage()],
    [2, vmixPage()],
  ]);
}
