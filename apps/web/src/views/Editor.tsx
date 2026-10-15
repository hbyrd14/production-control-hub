import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_STYLE,
  emptySlots,
  keyPosition,
  locationKey,
  validateProfileBody,
  type CompanionSlot,
  type KeyStyle,
  type NavSlot,
  type Page,
  type Profile,
  type ProfileBody,
  type Slot,
} from '@pch/shared';
import { KeyFace } from '../components/KeyFace';
import { KeyGrid } from '../components/KeyGrid';
import { StatusLamp } from '../components/StatusLamp';
import { ApiError, api, errorMessage } from '../lib/api';
import { useApp } from '../lib/store';

type Draft = { id: string; revision: number; body: ProfileBody };

function toDraft(p: Profile): Draft {
  const { id, revision, updatedAt: _u, ...body } = p;
  return { id, revision, body: structuredClone(body) };
}

const newId = () => Math.random().toString(36).slice(2, 10);

function companionSlot(page: number, row: number, column: number): CompanionSlot {
  return { kind: 'companion', location: { page, row, column }, mode: 'passthrough', holdMs: 800, windowMs: 350, secondary: null, presentation: 'companion', style: { ...DEFAULT_STYLE } };
}

function navSlot(action: NavSlot['action'] = 'next'): NavSlot {
  return { kind: 'nav', action, target: null, style: { ...DEFAULT_STYLE, background: '#30343f', label: action === 'next' ? 'Next' : action === 'prev' ? 'Prev' : action === 'back' ? 'Back' : 'Page' } };
}

export function Editor() {
  const setRoute = useApp((s) => s.setRoute);
  const toast = useApp((s) => s.toast);
  const liveView = useApp((s) => s.view);
  const liveKeys = useApp((s) => s.keys);
  const companion = useApp((s) => s.companion);

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pageId, setPageId] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (selectId?: string) => {
      const list = await api<Profile[]>('GET', '/api/profiles');
      setProfiles(list);
      const target = list.find((p) => p.id === (selectId ?? draft?.id ?? liveView?.profile?.id)) ?? list[0];
      if (target) {
        setDraft(toDraft(target));
        setPageId((cur) => (target.pages.some((p) => p.id === cur) ? cur : (liveView?.profile?.id === target.id ? liveView?.page?.id : null) ?? target.pages[0]?.id ?? null));
      }
      setDirty(false);
      setConflict(false);
    },
    [draft?.id, liveView?.profile?.id, liveView?.page?.id],
  );

  useEffect(() => {
    load().catch((e) => toast('error', errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const body = draft?.body;
  const page = body?.pages.find((p) => p.id === pageId) ?? null;
  const slot = page && sel !== null ? page.slots[sel]! : null;
  const problems = useMemo(() => (body ? validateProfileBody(body) : []), [body]);

  const mutate = (fn: (b: ProfileBody) => void) => {
    if (!draft) return;
    const b = structuredClone(draft.body);
    fn(b);
    setDraft({ ...draft, body: b });
    setDirty(true);
  };
  const mutatePage = (fn: (p: Page) => void) =>
    mutate((b) => {
      const p = b.pages.find((x) => x.id === pageId);
      if (p) fn(p);
    });
  const setSlot = (s: Slot) => mutatePage((p) => void (p.slots[sel!] = s));

  const switchProfile = (id: string) => {
    if (dirty && !confirm('Discard unsaved changes to this profile?')) return;
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    setDraft(toDraft(p));
    setPageId(p.pages[0]?.id ?? null);
    setSel(null);
    setDirty(false);
    setConflict(false);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const saved = await api<Profile>('PUT', `/api/profiles/${draft.id}`, { revision: draft.revision, profile: draft.body });
      setDraft(toDraft(saved));
      setProfiles((ps) => ps.map((p) => (p.id === saved.id ? saved : p)));
      setDirty(false);
      toast('info', 'Profile saved');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      toast('error', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const createProfile = async (kind: 'mapped' | 'surface') => {
    const name = prompt(kind === 'mapped' ? 'Name for the new profile' : 'Name for the new Companion surface profile');
    if (!name) return;
    const body: ProfileBody =
      kind === 'mapped'
        ? { name, kind, surfaceId: null, layout: { gapPx: 10, radiusPx: 10, showLabels: true, pinnedNav: true }, pages: [{ id: 'page-1', name: 'Page 1', isFolder: false, slots: emptySlots() }] }
        : { name, kind, surfaceId: `surface-${newId().slice(0, 4)}`, layout: { gapPx: 10, radiusPx: 10, showLabels: true, pinnedNav: true }, pages: [] };
    try {
      const p = await api<Profile>('POST', '/api/profiles', body);
      await load(p.id);
      toast('info', `Created ${p.name}`);
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };

  const duplicate = async () => {
    if (!draft) return;
    try {
      const p = await api<Profile>('POST', `/api/profiles/${draft.id}/duplicate`, {});
      await load(p.id);
      toast('info', `Duplicated as ${p.name}`);
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };

  const remove = async () => {
    if (!draft || !confirm(`Delete profile "${draft.body.name}"? This cannot be undone.`)) return;
    try {
      await api('DELETE', `/api/profiles/${draft.id}?revision=${draft.revision}`);
      setDraft(null);
      await load('');
      toast('info', 'Profile deleted');
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };

  const importFile = async (file: File) => {
    try {
      const doc = JSON.parse(await file.text());
      const p = await api<Profile>('POST', '/api/profiles/import', doc);
      await load(p.id);
      toast('info', `Imported ${p.name}`);
    } catch (e) {
      toast('error', `Import failed: ${errorMessage(e)}`);
    }
  };

  const onDrop = (from: number, to: number) => {
    if (from === to) return;
    mutatePage((p) => {
      const a = p.slots[from]!;
      p.slots[from] = p.slots[to]!;
      p.slots[to] = a;
    });
    setSel(to);
  };

  const livePreview = (i: number) => {
    if (!liveView || liveView.profile?.id !== draft?.id || liveView.page?.id !== pageId) return null;
    const k = liveKeys[i];
    const s = page?.slots[i];
    if (!k || s?.kind !== 'companion' || k.location !== locationKey(s.location)) return null;
    return k;
  };

  if (!draft || !body) return <div className="page"><p className="muted pad">Loading profiles…</p></div>;

  return (
    <div className="page editor">
      <header className="bar">
        <div className="bar-title">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => (!dirty || confirm('Leave without saving?')) && setRoute('operate')}
            data-testid="back-to-surface"
          >
            ← Surface
          </button>
          <select value={draft.id} onChange={(e) => switchProfile(e.target.value)} aria-label="Profile to edit" data-testid="editor-profile">
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {dirty && <span className="pill pill-warn">Unsaved</span>}
        </div>
        <StatusLamp compact />
        <div className="bar-actions">
          <details className="menu">
            <summary className="btn-ghost">Profile</summary>
            <div className="menu-body">
              <button type="button" onClick={() => void createProfile('mapped')}>New mapped profile</button>
              <button type="button" onClick={() => void createProfile('surface')}>New Companion surface profile</button>
              <button type="button" onClick={() => void duplicate()}>Duplicate</button>
              <a href={`/api/profiles/${draft.id}/export`} download>Export to file</a>
              <label className="menu-file">
                Import from file
                <input type="file" accept="application/json,.json" onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
              </label>
              <button type="button" className="danger" onClick={() => void remove()}>Delete profile</button>
            </div>
          </details>
          <button type="button" className="btn-primary" disabled={!dirty || saving || problems.length > 0} onClick={() => void save()} data-testid="save-profile">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>

      {conflict && (
        <div className="offline-banner" role="alert">
          Someone else saved this profile while you were editing.{' '}
          <button type="button" className="btn-small" onClick={() => void load(draft.id)}>
            Discard my changes and reload
          </button>
        </div>
      )}
      {problems.length > 0 && (
        <div className="problems" role="alert">
          {problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      )}

      <div className="editor-body">
        <div className="editor-main">
          <div className="profile-fields row">
            <label className="grow">
              Profile name
              <input value={body.name} maxLength={64} onChange={(e) => mutate((b) => void (b.name = e.target.value))} />
            </label>
            <label>
              Key spacing
              <input type="range" min={2} max={24} value={body.layout.gapPx} onChange={(e) => mutate((b) => void (b.layout.gapPx = Number(e.target.value)))} />
            </label>
            <label>
              Corner radius
              <input type="range" min={0} max={24} value={body.layout.radiusPx} onChange={(e) => mutate((b) => void (b.layout.radiusPx = Number(e.target.value)))} />
            </label>
            <label className="check">
              <input type="checkbox" checked={body.layout.pinnedNav} onChange={(e) => mutate((b) => void (b.layout.pinnedNav = e.target.checked))} />
              Navigation bar
            </label>
            <label className="check">
              <input type="checkbox" checked={body.layout.showLabels} onChange={(e) => mutate((b) => void (b.layout.showLabels = e.target.checked))} />
              Key labels
            </label>
          </div>

          {body.kind === 'surface' ? (
            <SurfaceProfileInfo
              surfaceId={body.surfaceId ?? ''}
              onChange={(v) => mutate((b) => void (b.surfaceId = v))}
              companionHost={companion?.host ?? null}
            />
          ) : (
            <>
              <PageTabs
                pages={body.pages}
                current={pageId}
                onSelect={(id) => {
                  setPageId(id);
                  setSel(null);
                }}
                onAdd={(isFolder) => {
                  const id = `${isFolder ? 'folder' : 'page'}-${newId()}`;
                  mutate((b) => void b.pages.push({ id, name: isFolder ? 'New folder' : `Page ${b.pages.filter((p) => !p.isFolder).length + 1}`, isFolder, slots: emptySlots() }));
                  setPageId(id);
                  setSel(null);
                }}
              />
              {page && (
                <>
                  <PageFields
                    page={page}
                    canDelete={body.pages.length > 1}
                    onRename={(n) => mutatePage((p) => void (p.name = n))}
                    onFolder={(f) => mutatePage((p) => void (p.isFolder = f))}
                    onMove={(d) =>
                      mutate((b) => {
                        const i = b.pages.findIndex((p) => p.id === pageId);
                        const j = i + d;
                        if (j < 0 || j >= b.pages.length) return;
                        [b.pages[i], b.pages[j]] = [b.pages[j]!, b.pages[i]!];
                      })
                    }
                    onDelete={() => {
                      if (!confirm(`Delete page "${page.name}"?`)) return;
                      mutate((b) => void (b.pages = b.pages.filter((p) => p.id !== pageId)));
                      setPageId(body.pages.find((p) => p.id !== pageId)?.id ?? null);
                      setSel(null);
                    }}
                    onFill={(n) => mutatePage((p) => void (p.slots = p.slots.map((_, i) => companionSlot(n, keyPosition(i).row, keyPosition(i).column))))}
                  />
                  <div className="editor-grid">
                    <KeyGrid gap={body.layout.gapPx} radius={body.layout.radiusPx} testId="editor-grid">
                      {page.slots.map((s, i) => (
                        <EditorKey key={i} index={i} slot={s} selected={sel === i} live={livePreview(i)} showLabels={body.layout.showLabels} onSelect={setSel} onDrop={onDrop} />
                      ))}
                    </KeyGrid>
                  </div>
                  <p className="hint">Select a key to configure it. Drag a key onto another to swap them.</p>
                </>
              )}
            </>
          )}
        </div>

        {body.kind === 'mapped' && (
          <aside className="inspector" aria-label="Key settings">
            {slot && sel !== null ? (
              <Inspector index={sel} slot={slot} pages={body.pages} profiles={profiles} onChange={setSlot} companionHost={companion?.host ?? null} />
            ) : (
              <p className="muted">Select a key on the grid to set what it does and how it looks.</p>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function SurfaceProfileInfo({ surfaceId, onChange, companionHost }: { surfaceId: string; onChange(v: string): void; companionHost: string | null }) {
  return (
    <div className="surface-info">
      <h2>Companion surface</h2>
      <p>
        This profile registers an 8 × 4 surface in Companion. Companion decides which page and buttons appear, draws every key, and handles page buttons. Configure
        the buttons in Companion, then use this profile to operate them.
      </p>
      <label>
        Surface ID (appears in Companion as <code>pch-{surfaceId || '…'}</code>)
        <input value={surfaceId} pattern="[a-zA-Z0-9-]{1,32}" maxLength={32} onChange={(e) => onChange(e.target.value)} />
      </label>
      <p className="hint">
        To let the navigation bar change Companion pages, open the surface's settings in Companion and enable “Allow page changes from Production Control Hub”.
        Changing the ID makes Companion treat it as a new surface.
      </p>
      {companionHost && (
        <p>
          <a href={`http://${companionHost}:8000`} target="_blank" rel="noreferrer">
            Open Companion's admin interface
          </a>{' '}
          <span className="muted">(assumes Companion's default web port 8000)</span>
        </p>
      )}
    </div>
  );
}

function PageTabs({ pages, current, onSelect, onAdd }: { pages: Page[]; current: string | null; onSelect(id: string): void; onAdd(folder: boolean): void }) {
  return (
    <div className="tabs" role="tablist">
      {pages.map((p) => (
        <button key={p.id} type="button" role="tab" aria-selected={p.id === current} className={p.id === current ? 'tab active' : 'tab'} onClick={() => onSelect(p.id)}>
          {p.isFolder ? '▸ ' : ''}
          {p.name}
        </button>
      ))}
      <button type="button" className="tab tab-add" onClick={() => onAdd(false)}>
        + Page
      </button>
      <button type="button" className="tab tab-add" onClick={() => onAdd(true)}>
        + Folder
      </button>
    </div>
  );
}

function PageFields({
  page,
  canDelete,
  onRename,
  onFolder,
  onMove,
  onDelete,
  onFill,
}: {
  page: Page;
  canDelete: boolean;
  onRename(n: string): void;
  onFolder(f: boolean): void;
  onMove(d: number): void;
  onDelete(): void;
  onFill(companionPage: number): void;
}) {
  return (
    <div className="row page-fields">
      <label className="grow">
        Page name
        <input value={page.name} maxLength={64} onChange={(e) => onRename(e.target.value)} data-testid="page-name-input" />
      </label>
      <label className="check" title="Folders are opened by a folder key and skipped by next/previous page">
        <input type="checkbox" checked={page.isFolder} onChange={(e) => onFolder(e.target.checked)} />
        Folder
      </label>
      <button type="button" className="btn-small" onClick={() => onMove(-1)}>
        Move left
      </button>
      <button type="button" className="btn-small" onClick={() => onMove(1)}>
        Move right
      </button>
      <button
        type="button"
        className="btn-small"
        onClick={() => {
          const n = Number(prompt('Map every key to the same position on Companion page:', '1'));
          if (Number.isInteger(n) && n >= 1 && confirm(`Replace all 32 keys on "${page.name}" with Companion page ${n}?`)) onFill(n);
        }}
      >
        Mirror a Companion page
      </button>
      <button type="button" className="btn-small danger" disabled={!canDelete} onClick={onDelete}>
        Delete page
      </button>
    </div>
  );
}

function EditorKey({
  index,
  slot,
  selected,
  live,
  showLabels,
  onSelect,
  onDrop,
}: {
  index: number;
  slot: Slot;
  selected: boolean;
  live: ReturnType<typeof useApp.getState>['keys'][number] | null;
  showLabels: boolean;
  onSelect(i: number): void;
  onDrop(from: number, to: number): void;
}) {
  const [over, setOver] = useState(false);
  const loc = slot.kind === 'companion' ? locationKey(slot.location) : null;
  return (
    <button
      type="button"
      className={`key edit-key ${selected ? 'is-selected' : ''} ${over ? 'is-drop' : ''} ${slot.kind === 'empty' ? 'is-empty' : ''}`}
      draggable={slot.kind !== 'empty'}
      onDragStart={(e) => e.dataTransfer.setData('text/x-pch-key', String(index))}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const from = Number(e.dataTransfer.getData('text/x-pch-key'));
        if (Number.isInteger(from)) onDrop(from, index);
      }}
      onClick={() => onSelect(index)}
      aria-pressed={selected}
      aria-label={`Key ${index + 1}`}
      data-testid={`edit-key-${index}`}
    >
      {slot.kind === 'empty' ? (
        <div className="face face-empty">
          <span className="face-text face-dim">+</span>
        </div>
      ) : slot.kind === 'nav' ? (
        <KeyFace view={null} style={slot.style} showLabels={showLabels} />
      ) : live && slot.presentation === 'companion' ? (
        <KeyFace view={live} />
      ) : slot.presentation === 'pch' ? (
        <KeyFace view={null} style={slot.style} showLabels={showLabels} />
      ) : (
        <div className="face face-mapped">
          <span className="face-text">{slot.style.label || 'Companion'}</span>
          <span className="face-loc">{loc}</span>
        </div>
      )}
      {slot.kind === 'companion' && slot.mode !== 'passthrough' && <span className={`key-badge badge-${slot.mode}`}>{slot.mode === 'confirm' ? '2×' : slot.mode === 'hold' ? '⏱' : '⋮'}</span>}
    </button>
  );
}

function Inspector({
  index,
  slot,
  pages,
  profiles,
  onChange,
  companionHost,
}: {
  index: number;
  slot: Slot;
  pages: Page[];
  profiles: Profile[];
  onChange(s: Slot): void;
  companionHost: string | null;
}) {
  const pos = keyPosition(index);
  const setKind = (kind: Slot['kind']) => {
    if (kind === slot.kind) return;
    if (kind === 'empty') onChange({ kind: 'empty' });
    else if (kind === 'companion') onChange(companionSlot(1, pos.row, pos.column));
    else onChange(navSlot());
  };
  return (
    <div className="form inspector-form" data-testid="inspector">
      <h2>
        Key {index + 1} <span className="muted">row {pos.row + 1}, column {pos.column + 1}</span>
      </h2>
      <label>
        Key does
        <select value={slot.kind} onChange={(e) => setKind(e.target.value as Slot['kind'])} data-testid="slot-kind">
          <option value="empty">Nothing (blank)</option>
          <option value="companion">Press a Companion button</option>
          <option value="nav">Navigate</option>
        </select>
      </label>

      {slot.kind === 'companion' && <CompanionFields slot={slot} onChange={onChange} companionHost={companionHost} />}
      {slot.kind === 'nav' && <NavFields slot={slot} pages={pages} profiles={profiles} onChange={onChange} />}
      {slot.kind !== 'empty' && (
        <StyleFields
          style={slot.style}
          note={slot.kind === 'companion' && slot.presentation === 'companion' ? 'The label below is shown only in the editor and when Companion has not sent an image.' : null}
          onChange={(style) => onChange({ ...slot, style } as Slot)}
        />
      )}
    </div>
  );
}

function LocationInput({ value, onChange, testId }: { value: { page: number; row: number; column: number }; onChange(v: { page: number; row: number; column: number }): void; testId?: string }) {
  const num = (k: 'page' | 'row' | 'column', min: number) => (
    <label>
      {k === 'page' ? 'Page' : k === 'row' ? 'Row' : 'Column'}
      <input
        type="number"
        min={min}
        value={k === 'page' ? value[k] : value[k] + 1}
        onChange={(e) => {
          const n = Math.max(min, Number(e.target.value) || min);
          onChange({ ...value, [k]: k === 'page' ? n : n - 1 });
        }}
        data-testid={testId ? `${testId}-${k}` : undefined}
      />
    </label>
  );
  return (
    <div className="row">
      {num('page', 1)}
      {num('row', 1)}
      {num('column', 1)}
    </div>
  );
}

const MODE_HELP: Record<CompanionSlot['mode'], string> = {
  passthrough: 'Press and release go straight to Companion. Companion handles latching, steps and timing.',
  confirm: 'First tap arms the key (amber). A second tap within 3 seconds sends the press.',
  hold: 'Nothing is sent unless the key is held for the set time. Use for stream stop, fade to black and similar.',
  double: 'One tap fires this button; two quick taps fire a second button instead.',
};

function CompanionFields({ slot, onChange, companionHost }: { slot: CompanionSlot; onChange(s: Slot): void; companionHost: string | null }) {
  return (
    <>
      <fieldset>
        <legend>Companion button</legend>
        <LocationInput value={slot.location} onChange={(location) => onChange({ ...slot, location })} testId="loc" />
        <p className="hint">
          Rows and columns count from 1, matching Companion's grid. Actions, steps and feedback are edited in Companion
          {companionHost ? (
            <>
              {' '}
              (
              <a href={`http://${companionHost}:8000`} target="_blank" rel="noreferrer">
                open Companion
              </a>
              )
            </>
          ) : null}
          .
        </p>
      </fieldset>
      <label>
        Press behaviour
        <select value={slot.mode} onChange={(e) => onChange({ ...slot, mode: e.target.value as CompanionSlot['mode'] })} data-testid="slot-mode">
          <option value="passthrough">Normal</option>
          <option value="confirm">Tap twice to confirm</option>
          <option value="hold">Hold to fire</option>
          <option value="double">Single / double press</option>
        </select>
        <span className="hint">{MODE_HELP[slot.mode]}</span>
      </label>
      {slot.mode === 'hold' && (
        <label>
          Hold for (ms)
          <input type="number" min={200} max={5000} step={100} value={slot.holdMs} onChange={(e) => onChange({ ...slot, holdMs: Number(e.target.value) })} />
        </label>
      )}
      {slot.mode === 'double' && (
        <fieldset>
          <legend>Double press fires</legend>
          <LocationInput value={slot.secondary ?? slot.location} onChange={(secondary) => onChange({ ...slot, secondary })} />
          <label>
            Double-press window (ms)
            <input type="number" min={150} max={3000} step={50} value={slot.windowMs} onChange={(e) => onChange({ ...slot, windowMs: Number(e.target.value) })} />
          </label>
          <p className="hint">A single tap waits for this window before firing, so it responds slightly later than a normal key.</p>
        </fieldset>
      )}
      <label>
        Key appearance
        <select value={slot.presentation} onChange={(e) => onChange({ ...slot, presentation: e.target.value as CompanionSlot['presentation'] })}>
          <option value="companion">Companion's live image and feedback</option>
          <option value="pch">This hub's label, colour and icon</option>
        </select>
      </label>
    </>
  );
}

const NAV_LABELS: Record<NavSlot['action'], string> = {
  next: 'Next page',
  prev: 'Previous page',
  goto: 'Go to a page',
  folder: 'Open a folder',
  back: 'Back out of folder',
  profile: 'Switch profile',
  'companion-next': 'Companion next page',
  'companion-prev': 'Companion previous page',
};

function NavFields({ slot, pages, profiles, onChange }: { slot: NavSlot; pages: Page[]; profiles: Profile[]; onChange(s: Slot): void }) {
  const options = slot.action === 'folder' ? pages.filter((p) => p.isFolder) : slot.action === 'goto' ? pages.filter((p) => !p.isFolder) : [];
  return (
    <>
      <label>
        Navigation
        <select value={slot.action} onChange={(e) => onChange({ ...slot, action: e.target.value as NavSlot['action'], target: null })}>
          {(['next', 'prev', 'goto', 'folder', 'back', 'profile'] as const).map((a) => (
            <option key={a} value={a}>
              {NAV_LABELS[a]}
            </option>
          ))}
        </select>
      </label>
      {(slot.action === 'goto' || slot.action === 'folder') && (
        <label>
          {slot.action === 'folder' ? 'Folder' : 'Page'}
          <select value={slot.target ?? ''} onChange={(e) => onChange({ ...slot, target: e.target.value || null })}>
            <option value="">Choose…</option>
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {slot.action === 'folder' && options.length === 0 && <span className="hint">Add a folder page first (“+ Folder”).</span>}
        </label>
      )}
      {slot.action === 'profile' && (
        <label>
          Profile
          <select value={slot.target ?? ''} onChange={(e) => onChange({ ...slot, target: e.target.value || null })}>
            <option value="">Choose…</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}

const ICONS = ['', '▶', '◀', '■', '●', '⏸', '⤺', '⚠', '★', '♪', '🎤', '🎥', '📺', '🔴', '🟢', '🔇', '⏺', '⏭', '⏮', '⬆', '⬇'];

function StyleFields({ style, note, onChange }: { style: KeyStyle; note: string | null; onChange(s: KeyStyle): void }) {
  const set = <K extends keyof KeyStyle>(k: K, v: KeyStyle[K]) => onChange({ ...style, [k]: v });
  return (
    <fieldset>
      <legend>Label and look</legend>
      {note && <p className="hint">{note}</p>}
      <label>
        Label
        <input value={style.label} maxLength={64} onChange={(e) => set('label', e.target.value)} data-testid="slot-label" />
      </label>
      <div className="row">
        <label>
          Background
          <input type="color" value={style.background} onChange={(e) => set('background', e.target.value)} />
        </label>
        <label>
          Text
          <input type="color" value={style.textColor} onChange={(e) => set('textColor', e.target.value)} />
        </label>
        <label>
          Size
          <input type="number" min={8} max={48} value={style.fontSize} onChange={(e) => set('fontSize', Number(e.target.value))} />
        </label>
        <label>
          Position
          <select value={style.placement} onChange={(e) => set('placement', e.target.value as KeyStyle['placement'])}>
            <option value="top">Top</option>
            <option value="center">Middle</option>
            <option value="bottom">Bottom</option>
          </select>
        </label>
      </div>
      <div className="icon-picker" role="radiogroup" aria-label="Icon">
        {ICONS.map((i) => (
          <button key={i || 'none'} type="button" role="radio" aria-checked={style.icon === i} className={style.icon === i ? 'active' : ''} onClick={() => set('icon', i)}>
            {i || 'None'}
          </button>
        ))}
      </div>
      <div className="row">
        <label className="file">
          Image
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) set('image', await shrinkImage(f));
            }}
          />
        </label>
        {style.image && (
          <button type="button" className="btn-small" onClick={() => set('image', null)}>
            Remove image
          </button>
        )}
      </div>
    </fieldset>
  );
}

/** Downscale uploaded artwork to 192 px (sharp at 2× for 96 px keys) and store as PNG. */
async function shrinkImage(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const size = 192;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const scale = Math.max(size / bmp.width, size / bmp.height);
  const w = bmp.width * scale;
  const h = bmp.height * scale;
  ctx.drawImage(bmp, (size - w) / 2, (size - h) / 2, w, h);
  return canvas.toDataURL('image/png');
}

