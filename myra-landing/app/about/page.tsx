import { PageHero } from '@/components/page-hero'

export default function AboutPage() {
  return (
    <>
      <PageHero
        eyebrow="About"
        title="Freight runs North America. We make sure it never stops."
        subtitle="Myra was built by people who got tired of watching a critical industry run on phone calls and spreadsheets."
      />

      <section className="content-section">
        <h2 className="section-headline">The industry had a problem. We had a fix.</h2>
        <div style={{ color: 'var(--text-muted)', fontSize: '15px', maxWidth: '640px', margin: '0 auto', lineHeight: 1.8, textAlign: 'center' }}>
          <p style={{ marginBottom: '20px' }}>
            Every day, billions of dollars of goods move across North America on trucks driven by owner-operators and small fleets — the backbone of the supply chain that nobody talks about.
          </p>
          <p style={{ marginBottom: '20px' }}>
            And every day, those carriers spend hours hunting loads on boards that haven&apos;t changed since 2003, while shippers sit on the phone waiting for a broker to &ldquo;call back with something.&rdquo;
          </p>
          <p>
            We built Myra because the technology to fix this has existed for years. The will to apply it to freight brokerage — with real standards, real verification, and real accountability — took a different kind of team. That team is Myra.
          </p>
        </div>
      </section>

      <section className="content-section alt">
        <div className="section-eyebrow">What We Believe</div>
        <h2 className="section-headline">Our Beliefs</h2>

        <div className="benefits-grid" style={{ maxWidth: '800px', margin: '0 auto', gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <div className="benefit-card">
            <div className="benefit-desc">
              A carrier should never drive empty when there&apos;s a load on their route.
            </div>
          </div>

          <div className="benefit-card">
            <div className="benefit-desc">
              A shipper should never wonder where their freight is.
            </div>
          </div>

          <div className="benefit-card">
            <div className="benefit-desc">
              &ldquo;Verified&rdquo; should mean something — not just a checkbox on a PDF.
            </div>
          </div>

          <div className="benefit-card">
            <div className="benefit-desc">
              The broker model can be better — more transparent, more accountable, and faster for everyone in the chain.
            </div>
          </div>
        </div>
      </section>

      <section className="content-section">
        <div className="section-eyebrow">Standards</div>
        <h2 className="section-headline">The Numbers That Matter</h2>

        <div className="benefits-grid" style={{ maxWidth: '900px', margin: '0 auto', gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="benefit-card" style={{ textAlign: 'center' }}>
            <div className="benefit-title" style={{ fontSize: '28px', marginBottom: '4px' }}>&lt; 30 min</div>
            <div className="benefit-desc">Carrier confirmed after load posted</div>
          </div>

          <div className="benefit-card" style={{ textAlign: 'center' }}>
            <div className="benefit-title" style={{ fontSize: '28px', marginBottom: '4px' }}>98.4%</div>
            <div className="benefit-desc">On-time delivery rate</div>
          </div>

          <div className="benefit-card" style={{ textAlign: 'center' }}>
            <div className="benefit-title" style={{ fontSize: '28px', marginBottom: '4px' }}>$2M+</div>
            <div className="benefit-desc">Minimum cargo insurance, every carrier</div>
          </div>

          <div className="benefit-card" style={{ textAlign: 'center' }}>
            <div className="benefit-title" style={{ fontSize: '28px', marginBottom: '4px' }}>85+</div>
            <div className="benefit-desc">Safety rating required, no exceptions</div>
          </div>

          <div className="benefit-card" style={{ textAlign: 'center' }}>
            <div className="benefit-title" style={{ fontSize: '28px', marginBottom: '4px' }}>48 hrs</div>
            <div className="benefit-desc">Carrier verification turnaround</div>
          </div>

          <div className="benefit-card" style={{ textAlign: 'center' }}>
            <div className="benefit-title" style={{ fontSize: '28px', marginBottom: '4px' }}>99.9%</div>
            <div className="benefit-desc">Platform uptime SLA</div>
          </div>
        </div>
      </section>

      <section className="content-section alt" style={{ textAlign: 'center' }}>
        <h2 className="section-headline">We&apos;re just getting started.</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '15px', maxWidth: '480px', margin: '0 auto 36px', lineHeight: 1.7 }}>
          Whether you move freight or need freight moved — Myra was built for you.
        </p>
        <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <a href="#" className="btn-primary-lg">Start Shipping</a>
          <a href="#" className="btn-primary-lg">Join the Network</a>
        </div>
      </section>
    </>
  )
}
