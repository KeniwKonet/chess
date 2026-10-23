/** The drag rectangle for box selection. Position is written by the input handler, drawn here outside React renders. */
import { useEffect, useRef } from 'react';

export const box = { active: false, x0: 0, y0: 0, x1: 0, y1: 0 };

export function BoxSelect() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = ref.current;
      if (el) {
        if (box.active) {
          el.style.display = 'block';
          el.style.left = `${Math.min(box.x0, box.x1)}px`;
          el.style.top = `${Math.min(box.y0, box.y1)}px`;
          el.style.width = `${Math.abs(box.x1 - box.x0)}px`;
          el.style.height = `${Math.abs(box.y1 - box.y0)}px`;
        } else if (el.style.display !== 'none') el.style.display = 'none';
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <div ref={ref} className="box-select" style={{ display: 'none' }} aria-hidden="true" />;
}
