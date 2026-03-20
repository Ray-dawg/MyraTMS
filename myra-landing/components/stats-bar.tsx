'use client';

import { useEffect, useRef } from 'react';

const stats = [
  { target: 2400, suffix: '+', prefix: '', decimals: 0, label: 'Loads Moved Monthly', sublabel: '\u2191 40% MoM growth' },
  { target: 300, suffix: '+', prefix: '', decimals: 0, label: 'Verified Carriers', sublabel: 'FMCSA verified & insured' },
  { target: 98.4, suffix: '%', prefix: '', decimals: 1, label: 'On-Time Delivery Rate', sublabel: 'Industry avg is 79%' },
  { target: 30, suffix: ' min', prefix: '< ', decimals: 0, label: 'Avg Carrier Match Time', sublabel: 'Industry avg is 2\u20133 hours' },
];

export function StatsBar() {
  const barRef = useRef<HTMLElement>(null);
  const firedRef = useRef(false);
  const numRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    function countUp(el: HTMLDivElement, target: number, suffix: string, prefix: string, decimals: number) {
      const item = el.closest('.stat-item') as HTMLElement | null;
      if (item) item.classList.add('in-view');

      const duration = 1600;
      const start = performance.now();

      function tick(now: number) {
        const p = Math.min((now - start) / duration, 1);
        const ease = 1 - Math.pow(1 - p, 3); // ease-out-cubic
        const val = decimals > 0
          ? parseFloat((ease * target).toFixed(decimals))
          : Math.round(ease * target);
        const formatted = decimals > 0 ? val.toFixed(decimals) : val.toLocaleString();
        el.textContent = prefix + formatted + suffix;
        if (p < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }

    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !firedRef.current) {
          firedRef.current = true;
          numRefs.current.forEach((n, i) => {
            if (n) {
              setTimeout(() => countUp(n, stats[i].target, stats[i].suffix, stats[i].prefix, stats[i].decimals), i * 120);
            }
          });
        }
      },
      { threshold: 0.3 }
    );
    io.observe(bar);

    return () => io.disconnect();
  }, []);

  return (
    <section className="stats-bar" id="statsBar" ref={barRef}>
      <div className="stats-inner">
        {stats.map((s, i) => (
          <div className="stat-item" key={i}>
            <div
              className="stat-num"
              ref={(el) => { numRefs.current[i] = el; }}
            >
              0
            </div>
            <div className="stat-label">{s.label}</div>
            <div className="stat-sublabel">{s.sublabel}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
