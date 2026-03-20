'use client';

import { useEffect, useRef } from 'react';

const problems = [
  {
    num: '01',
    text: 'Brokers cold-call 10 carriers to fill one load',
    detail: 'The average broker makes 40+ calls per shipment. You wait. The truck doesn\u2019t show.',
    stat: '40+ calls',
  },
  {
    num: '02',
    text: 'Your freight disappears the moment it leaves',
    detail: 'No visibility. No updates. A phone call when it\u2019s already late.',
    stat: '0 updates',
  },
  {
    num: '03',
    text: 'Matching takes hours. You have a window.',
    detail: 'Manual brokerage means missed pickups, blown budgets, and unhappy clients.',
    stat: '2\u20133 hrs wasted',
  },
  {
    num: '04',
    text: '28% of carrier miles are empty',
    detail: 'Carriers deadhead back. You pay more to cover their inefficiency.',
    stat: '28% dead miles',
  },
];

export function ProblemSection() {
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('visible');
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.2, rootMargin: '0px 0px -40px 0px' }
    );

    rowRefs.current.forEach((r, i) => {
      if (r) {
        r.style.transitionDelay = i * 0.1 + 's';
        io.observe(r);
      }
    });

    return () => io.disconnect();
  }, []);

  return (
    <section className="problem-section">
      <div className="problem-inner">
        <div className="problem-eyebrow">The Problem</div>
        <div className="problem-headline">BROKEN.</div>
        <p className="problem-sub">
          Freight logistics hasn&apos;t fundamentally changed in <strong>30 years.</strong>
          <br />
          It&apos;s 2025. Your broker is still on hold.
        </p>
        <div className="problem-list">
          {problems.map((p, i) => (
            <div
              className="problem-row"
              key={i}
              ref={(el) => { rowRefs.current[i] = el; }}
            >
              <span className="problem-row-num">{p.num}</span>
              <div className="problem-row-bar"></div>
              <div className="problem-row-text">
                {p.text}
                <em>{p.detail}</em>
              </div>
              <div className="problem-stat">{p.stat}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
