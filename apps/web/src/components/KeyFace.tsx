import type { KeyStyle, KeyView } from '@pch/shared';

/** Visual content of a key (no interaction). Used by the operator grid and the editor. */
export function KeyFace({ view, style, showLabels = true, showLocation = false }: { view: KeyView | null; style?: KeyStyle | null; showLabels?: boolean; showLocation?: boolean }) {
  if (!view && !style) return <div className="face face-empty" />;

  // Companion-rendered bitmap takes precedence when Companion owns the visual.
  if (view && view.source === 'companion' && view.image) {
    return (
      <div className="face">
        <img className="face-img" src={view.image} alt={view.text ?? ''} draggable={false} />
        {showLocation && view.location && <span className="face-loc">{view.location}</span>}
      </div>
    );
  }

  if (view && view.source === 'companion') {
    // Companion sent colour/text but no bitmap.
    return (
      <div className="face" style={{ background: view.background ?? '#000', color: view.textColor ?? '#fff' }}>
        <span className="face-text" style={{ fontSize: view.fontSize ? `calc(var(--key) * ${Math.min(view.fontSize, 30) / 96})` : undefined }}>
          {view.text}
        </span>
      </div>
    );
  }

  const s = style ?? view?.style;
  if (s) {
    return (
      <div className={`face face-pch place-${s.placement}`} style={{ background: s.background, color: s.textColor }}>
        {s.image && <img className="face-img" src={s.image} alt="" draggable={false} />}
        {s.icon && <span className="face-icon">{s.icon}</span>}
        {showLabels && s.label && (
          <span className="face-text" style={{ fontSize: `calc(var(--key) * ${s.fontSize / 96})` }}>
            {s.label}
          </span>
        )}
        {!s.label && !s.icon && !s.image && view?.location && <span className="face-text face-dim">{view.location}</span>}
        {showLocation && view?.location && <span className="face-loc">{view.location}</span>}
      </div>
    );
  }

  if (view?.source === 'unavailable') {
    return (
      <div className="face face-unavailable">
        <span className="face-text face-dim">{view.location ?? '—'}</span>
      </div>
    );
  }
  return <div className="face face-empty" />;
}
