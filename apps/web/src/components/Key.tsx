import { memo, useCallback, useRef, useState } from 'react';
import type { KeyView } from '@pch/shared';
import type { KeyFeedback } from '../lib/store';
import { KeyFace } from './KeyFace';

interface Props {
  view: KeyView;
  feedback: KeyFeedback | undefined;
  interactive: boolean;
  showLabels: boolean;
  showLocation: boolean;
  onAction(index: number, action: 'down' | 'up' | 'cancel'): void;
}

/**
 * One control key. Pointer Events with capture give reliable press/release on mouse,
 * pen and touch; pointercancel and lost capture always produce a cancel so Companion
 * never sees a stuck key.
 */
export const Key = memo(function Key({ view, feedback, interactive, showLabels, showLocation, onAction }: Props) {
  const pointer = useRef<number | null>(null);
  const [down, setDown] = useState(false);
  const disabled = !interactive || !!view.disabledReason || view.kind === 'empty';

  const finish = useCallback(
    (action: 'up' | 'cancel') => {
      if (pointer.current === null) return;
      pointer.current = null;
      setDown(false);
      onAction(view.index, action);
    },
    [onAction, view.index],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (pointer.current !== null || e.button > 0) return;
    if (view.kind === 'empty') return;
    pointer.current = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported */
    }
    setDown(true);
    onAction(view.index, 'down');
  };

  const fb = feedback?.state;
  const classes = [
    'key',
    down && !disabled ? 'is-down' : '',
    view.pressed ? 'is-companion-pressed' : '',
    disabled ? 'is-disabled' : '',
    view.stale ? 'is-stale' : '',
    fb ? `fb-${fb}` : '',
    view.kind === 'nav' ? 'is-nav' : '',
    view.kind === 'empty' ? 'is-empty' : '',
    view.mode && view.mode !== 'passthrough' ? `mode-${view.mode}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const label = view.style?.label || view.text || view.location || `Key ${view.index + 1}`;

  return (
    <button
      type="button"
      className={classes}
      data-index={view.index}
      data-testid={`key-${view.index}`}
      aria-label={label + (view.disabledReason ? ` (${view.disabledReason})` : '')}
      aria-disabled={disabled}
      title={view.disabledReason ?? undefined}
      onPointerDown={onPointerDown}
      onPointerUp={() => finish('up')}
      onPointerCancel={() => finish('cancel')}
      onLostPointerCapture={() => finish('cancel')}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat && !disabled) {
          e.preventDefault();
          pointer.current = -1;
          setDown(true);
          onAction(view.index, 'down');
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') finish('up');
      }}
      onBlur={() => finish('cancel')}
      style={fb === 'armed' && view.mode === 'hold' && view.holdMs ? ({ '--hold': `${view.holdMs}ms` } as React.CSSProperties) : undefined}
    >
      <KeyFace view={view} showLabels={showLabels} showLocation={showLocation} />
      {view.mode && view.mode !== 'passthrough' && <span className={`key-badge badge-${view.mode}`} aria-hidden>{badgeText(view.mode)}</span>}
      {fb === 'armed' && <span className="key-armed" aria-hidden>{view.mode === 'confirm' ? 'Tap again' : 'Hold'}</span>}
    </button>
  );
});

function badgeText(mode: string) {
  return mode === 'confirm' ? '2×' : mode === 'hold' ? '⏱' : mode === 'double' ? '⋮' : '';
}
