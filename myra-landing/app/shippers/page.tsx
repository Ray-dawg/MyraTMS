import { PageHero } from '@/components/page-hero'

export default function ShippersPage() {
  return (
    <>
      <PageHero
        eyebrow="For Shippers"
        title="Confirmed carrier. 30 minutes. Every time."
        subtitle="Post a load. Our AI finds a vetted, insured carrier — matched to your lane, on your timeline. You see it happen live."
      />

      <section className="content-section" style={{ textAlign: 'center' }}>
        <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap', marginBottom: '24px' }}>
          <a href="#" className="btn-primary-lg">Post Your First Load Free</a>
          <a href="#" className="btn-ghost-lg">Already shipping? Talk to our team &rarr;</a>
        </div>
      </section>

      <section className="content-section">
        <h2 className="section-headline">You&apos;ve been here before.</h2>

        <blockquote style={{ color: 'var(--text-primary)', fontSize: '17px', fontStyle: 'italic', maxWidth: '520px', margin: '0 auto 32px', lineHeight: 1.7, textAlign: 'center', borderLeft: 'none' }}>
          &ldquo;It&apos;s Wednesday. The load needs to move Friday.<br />
          Your broker is &apos;working on it.&apos;<br />
          Your client is already emailing.<br />
          This is the last time.&rdquo;
        </blockquote>

        <div className="pain-points">
          <div className="pain-point-row">
            <div className="pain-point-bar" />
            <div className="pain-point-text">
              Carrier confirmed — then cancels day-of
            </div>
          </div>

          <div className="pain-point-row">
            <div className="pain-point-bar" />
            <div className="pain-point-text">
              Rate quoted — then revised upward
            </div>
          </div>

          <div className="pain-point-row">
            <div className="pain-point-bar" />
            <div className="pain-point-text">
              &ldquo;In transit&rdquo; — until it isn&apos;t, and nobody called
            </div>
          </div>

          <div className="pain-point-row">
            <div className="pain-point-bar" />
            <div className="pain-point-text">
              Broker who handles your account changes — again
            </div>
          </div>
        </div>
      </section>

      <section className="content-section alt">
        <div className="section-eyebrow">How It Works</div>
        <h2 className="section-headline">Four Steps to Better Freight</h2>

        <div className="steps-row">
          <div className="step-card">
            <div className="step-number">01</div>
            <div className="step-card-title">Post your load</div>
            <div className="step-card-desc">
              Origin, destination, weight, date. Two minutes. No broker briefing required.
            </div>
          </div>

          <div className="step-card">
            <div className="step-number">02</div>
            <div className="step-card-title">Myra matches a verified carrier</div>
            <div className="step-card-desc">
              Our AI scans lane fit, safety score, and live availability. You get a confirmed carrier — not a callback.
            </div>
          </div>

          <div className="step-card">
            <div className="step-number">03</div>
            <div className="step-card-title">Watch it move</div>
            <div className="step-card-desc">
              Live GPS tracking from pickup through delivery. Exception alerts the moment anything changes. Signed POD when it&apos;s done.
            </div>
          </div>

          <div className="step-card">
            <div className="step-number">04</div>
            <div className="step-card-title">Pay once, simply</div>
            <div className="step-card-desc">
              One transparent rate — a percentage of freight value. Subscription shippers get a locked discount rate on every load.
            </div>
          </div>
        </div>
      </section>

      <section className="content-section">
        <div className="section-eyebrow">What &ldquo;verified&rdquo; actually means at Myra</div>
        <h2 className="section-headline">We check what your broker doesn&apos;t.</h2>
        <div style={{ maxWidth: '480px', margin: '0 auto 32px', textAlign: 'left' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: '15px', lineHeight: 2.2 }}>
            &#10003; FMCSA registration — active and in good standing<br />
            &#10003; Safety rating — 85 or above, no exceptions<br />
            &#10003; Cargo insurance — $2M minimum, verified current<br />
            &#10003; E&amp;O insurance — confirmed and on file<br />
            &#10003; No adverse press or regulatory action<br />
            &#10003; Financial stability — carrier has operational runway
          </div>
        </div>
        <blockquote style={{ color: 'var(--text-primary)', fontSize: '17px', fontStyle: 'italic', maxWidth: '520px', margin: '0 auto', lineHeight: 1.7, textAlign: 'center', borderLeft: 'none' }}>
          &ldquo;The carrier that picks up your freight has been vetted more thoroughly than most companies vet full-time employees.&rdquo;
        </blockquote>
      </section>

      <section className="content-section alt">
        <div className="section-eyebrow">Transparent pricing. No surprises.</div>
        <h2 className="section-headline">Two Plans. One Promise.</h2>

        <div className="benefits-grid" style={{ maxWidth: '800px', margin: '0 auto', gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <div className="benefit-card">
            <div className="benefit-title">Spot Shipper</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '12px' }}>Per-load &middot; percentage of freight value</div>
            <div className="benefit-desc">
              No subscription. No commitment. Post when you need it, pay only when you ship.
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '12px' }}>Best for: Occasional shippers, first-time loads.</div>
            <div style={{ marginTop: '16px' }}>
              <a href="#" className="btn-primary-lg" style={{ fontSize: '14px', padding: '12px 28px' }}>Ship Your First Load</a>
            </div>
          </div>

          <div className="benefit-card" style={{ border: '1px solid var(--accent)' }}>
            <div style={{ color: 'var(--accent)', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>Recommended</div>
            <div className="benefit-title">Retainer Shipper</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '12px' }}>Monthly subscription + reduced per-load rate</div>
            <div className="benefit-desc">
              Lock in a lower percentage rate on every load. Priority matching. Dedicated account access.
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '12px' }}>Best for: Logistics managers shipping multiple loads per month.</div>
            <div style={{ marginTop: '16px' }}>
              <a href="#" className="btn-primary-lg" style={{ fontSize: '14px', padding: '12px 28px' }}>Talk to Our Team</a>
            </div>
          </div>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', marginTop: '24px' }}>
          First load is on us. No credit card required to start.
        </p>
      </section>

      <section className="content-section" style={{ textAlign: 'center' }}>
        <h2 className="section-headline">Your next load should already be moving.</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '15px', maxWidth: '480px', margin: '0 auto 36px', lineHeight: 1.7 }}>
          Post it now. Carrier confirmed in 30 minutes. Your freight, tracked live, delivered on time.
        </p>
        <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <a href="#" className="btn-primary-lg">Post Your First Load — Free</a>
          <a href="#" className="btn-ghost-lg">See How Matching Works &rarr;</a>
        </div>
      </section>
    </>
  )
}
