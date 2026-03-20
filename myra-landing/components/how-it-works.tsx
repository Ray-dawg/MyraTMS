'use client';

import { useEffect, useRef } from 'react';

export function HowItWorks() {
  const nodesRowRef = useRef<HTMLDivElement>(null);
  const node2Ref = useRef<HTMLDivElement>(null);
  const node3Ref = useRef<HTMLDivElement>(null);
  const stepsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const nodesRow = nodesRowRef.current;
    const node2 = node2Ref.current;
    const node3 = node3Ref.current;
    const stepsContainer = stepsRef.current;
    if (!nodesRow || !stepsContainer) return;

    const steps = stepsContainer.querySelectorAll('.hiw-step');

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            // Reveal content rows
            steps.forEach((s) => s.classList.add('visible'));
            // Trigger line fill + activate nodes sequentially
            nodesRow.classList.add('animated');
            setTimeout(() => {
              if (node2) {
                node2.classList.add('active-node');
                const svg = node2.querySelector('svg');
                if (svg) svg.style.stroke = '#e8601f';
              }
            }, 600);
            setTimeout(() => {
              if (node3) {
                node3.classList.add('active-node');
                const svg = node3.querySelector('svg');
                if (svg) svg.style.stroke = '#e8601f';
              }
            }, 1100);
            io.disconnect();
          }
        });
      },
      { threshold: 0.3 }
    );
    io.observe(nodesRow);

    return () => io.disconnect();
  }, []);

  return (
    <section className="hiw-section">
      <div className="hiw-inner">
        <div className="hiw-eyebrow">The Solution</div>
        <h2 className="hiw-headline">
          Three steps.<br />
          <span>Zero friction.</span>
        </h2>

        <div className="hiw-outer">
          {/* Row A: Ghost numbers */}
          <div className="hiw-nums-row">
            <span className="hiw-ghost-num">01</span>
            <span className="hiw-ghost-num">02</span>
            <span className="hiw-ghost-num">03</span>
          </div>

          {/* Row B: Icon circles with connector line */}
          <div className="hiw-nodes-row" id="hiwNodesRow" ref={nodesRowRef}>
            <div className="hiw-line-fill" id="hiwLineFill"></div>

            <div className="hiw-node-col">
              <div className="hiw-step-node active-node" id="hiwNode1">
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#e8601f"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="12" x2="12" y1="18" y2="12" />
                  <line x1="9" x2="15" y1="15" y2="15" />
                </svg>
              </div>
            </div>

            <div className="hiw-node-col">
              <div className="hiw-step-node" id="hiwNode2" ref={node2Ref}>
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="rgba(255,255,255,.38)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              </div>
            </div>

            <div className="hiw-node-col">
              <div className="hiw-step-node" id="hiwNode3" ref={node3Ref}>
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="rgba(255,255,255,.38)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="3 11 22 2 13 21 11 13 3 11" />
                </svg>
              </div>
            </div>
          </div>

          {/* Row C: Title + body text */}
          <div className="hiw-steps" id="hiwSteps" ref={stepsRef}>
            <div className="hiw-step" id="hiwStep1">
              <div className="hiw-step-title">Post Your Load</div>
              <div className="hiw-step-body">
                Tell Myra what&apos;s moving, where, and when. Two minutes.
                No forms to fax, no brokers to brief.
              </div>
            </div>
            <div className="hiw-step" id="hiwStep2">
              <div className="hiw-step-title">AI Matches Instantly</div>
              <div className="hiw-step-body">
                Our engine scans 300+ verified carriers by lane, availability, and
                safety score. Best match confirmed in under 30 minutes.
              </div>
            </div>
            <div className="hiw-step" id="hiwStep3">
              <div className="hiw-step-title">Track to Delivery</div>
              <div className="hiw-step-body">
                Live GPS from pickup to signed POD. Exception alerts before
                problems happen. You&apos;ll know before your driver does.
              </div>
            </div>
          </div>
        </div>

        <div className="hiw-cta-row">
          <button className="btn-primary-lg">Start Shipping Today</button>
          <button className="btn-ghost-lg">Watch a Demo →</button>
        </div>
        <div className="btn-hint">No commitment · First load on us · Setup in 10 minutes</div>
      </div>
    </section>
  );
}
