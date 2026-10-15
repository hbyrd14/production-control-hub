import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { GRID_COLUMNS, GRID_ROWS } from '@pch/shared';

/**
 * Fits an 8×4 grid of square keys into the available space (both axes),
 * so the full surface is always visible without scrolling.
 */
export function KeyGrid({ gap, radius, children, testId }: { gap: number; radius: number; children: ReactNode; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(64);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      const byW = (width - gap * (GRID_COLUMNS - 1)) / GRID_COLUMNS;
      const byH = (height - gap * (GRID_ROWS - 1)) / GRID_ROWS;
      setSize(Math.max(28, Math.floor(Math.min(byW, byH))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [gap]);

  return (
    <div className="grid-host" ref={ref}>
      <div
        className="grid"
        data-testid={testId}
        style={{ '--key': `${size}px`, '--gap': `${gap}px`, '--radius': `${radius}px` } as React.CSSProperties}
      >
        {children}
      </div>
    </div>
  );
}
