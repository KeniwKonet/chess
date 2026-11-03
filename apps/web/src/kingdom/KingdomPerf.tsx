/** Frame-rate readout for Chess Kingdom (Settings → Performance stats). */
import { useEffect, useRef } from 'react';
import { useUi } from '../state/ui';
import { perf } from '../hud/perf';

export function KingdomPerf() {
  const show = useUi((s) => s.showPerf);
  const quality = useUi((s) => s.quality);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!show) return;
    const id = setInterval(() => {
      if (ref.current) ref.current.textContent = `${perf.fps.toFixed(0)} fps   ${perf.ms.toFixed(1)} ms\ndraw calls  ${perf.calls}\ntriangles   ${perf.triangles.toLocaleString()}\npixel ratio ${perf.dpr.toFixed(2)}   quality ${quality}`;
    }, 400);
    return () => clearInterval(id);
  }, [show, quality]);
  if (!show) return null;
  return (
    <div className="perf panel k-perf" aria-label="Performance">
      <pre ref={ref}>measuring…</pre>
    </div>
  );
}
