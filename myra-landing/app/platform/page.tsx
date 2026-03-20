import { PageHero } from '@/components/page-hero'
import { SecurityBand } from '@/components/security-band'

export default function PlatformPage() {
  return (
    <>
      <PageHero
        eyebrow="The Platform"
        title="One platform. Every load. Zero gaps."
        subtitle="From posting to POD — the entire freight brokerage operation, automated and visible, in one place."
      />

      <section className="content-section" style={{ textAlign: 'center' }}>
        <a href="#" className="btn-primary-lg">Request a Demo</a>
      </section>

      <section className="content-section">
        <div className="section-eyebrow">Capabilities</div>
        <h2 className="section-headline">What the Platform Does</h2>

        <div className="benefits-grid">
          <div className="benefit-card">
            <div className="benefit-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e8601f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <div className="benefit-title">AI Load Matching Engine</div>
            <div className="benefit-desc">
              The moment a load is posted, our matching engine evaluates 300+ carriers against lane fit, equipment type, availability, and safety score. A verified carrier is confirmed in under 30 minutes. No human broker in the loop.
            </div>
          </div>

          <div className="benefit-card">
            <div className="benefit-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e8601f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </div>
            <div className="benefit-title">Real-Time Shipment Tracking</div>
            <div className="benefit-desc">
              GPS-synced tracking updates every 15 minutes. Live location, ETA recalculation, and exception alerts — all surfaced before the shipper has to ask. Accessible via web and mobile.
            </div>
          </div>

          <div className="benefit-card">
            <div className="benefit-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e8601f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            </div>
            <div className="benefit-title">Carrier Verification Engine</div>
            <div className="benefit-desc">
              Automated FMCSA checks, safety rating pulls, insurance verification, and adverse press monitoring — run at onboarding and re-verified before every load assignment.
            </div>
          </div>

          <div className="benefit-card">
            <div className="benefit-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e8601f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
            </div>
            <div className="benefit-title">Document Automation</div>
            <div className="benefit-desc">
              Bills of lading, load confirmations, invoices, and POD collection — generated, sent, and filed automatically. No email chains. No missing paperwork.
            </div>
          </div>

          <div className="benefit-card">
            <div className="benefit-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e8601f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="1" x2="12" y2="23" />
                <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
              </svg>
            </div>
            <div className="benefit-title">Rate Intelligence</div>
            <div className="benefit-desc">
              Live market rate analysis on every lane. Shippers see fair market pricing. Carriers see competitive offers. Nobody is guessing.
            </div>
          </div>

          <div className="benefit-card">
            <div className="benefit-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e8601f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                <line x1="6" y1="6" x2="6.01" y2="6" />
                <line x1="6" y1="18" x2="6.01" y2="18" />
              </svg>
            </div>
            <div className="benefit-title">TMS Integration</div>
            <div className="benefit-desc">
              Connects with existing shipper TMS platforms. No workflow disruption. Myra fits where you already work.
            </div>
          </div>
        </div>
      </section>

      <section className="content-section alt">
        <div className="section-eyebrow">Infrastructure</div>
        <h2 className="section-headline">Built for Reliability</h2>

        <div className="benefits-grid" style={{ maxWidth: '800px', margin: '0 auto', gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <div className="benefit-card">
            <div className="benefit-title">99.9% SLA</div>
            <div className="benefit-desc">Platform uptime guarantee</div>
          </div>
          <div className="benefit-card">
            <div className="benefit-title">SOC 2 Type II</div>
            <div className="benefit-desc">256-bit TLS &middot; CTPAT Certified</div>
          </div>
          <div className="benefit-card">
            <div className="benefit-title">FMCSA Licensed</div>
            <div className="benefit-desc">Broker Authority #12847</div>
          </div>
          <div className="benefit-card">
            <div className="benefit-title">$2M Cargo Coverage</div>
            <div className="benefit-desc">Required on every carrier</div>
          </div>
        </div>
      </section>

      <SecurityBand />

      <section className="content-section" style={{ textAlign: 'center' }}>
        <h2 className="section-headline">See it move a load.</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '15px', maxWidth: '480px', margin: '0 auto 36px', lineHeight: 1.7 }}>
          Book a 20-minute demo. We&apos;ll run a live match on a real lane.
        </p>
        <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <a href="#" className="btn-primary-lg">Book a Demo</a>
          <a href="#" className="btn-ghost-lg">Read the Docs &rarr;</a>
        </div>
      </section>
    </>
  )
}
