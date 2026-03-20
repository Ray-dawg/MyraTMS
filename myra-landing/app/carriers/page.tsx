import { PageHero } from '@/components/page-hero'

export default function CarriersPage() {
  return (
    <>
      <PageHero
        eyebrow="For Carriers"
        title="Stop hunting loads. Let loads find you."
        subtitle="Myra matches you to loads that fit your lane, your equipment, and your schedule — automatically. Move more. Deadhead less. Get paid fast."
      />

      <section className="content-section" style={{ textAlign: 'center' }}>
        <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap', marginBottom: '24px' }}>
          <a href="#" className="btn-primary-lg">Join the Network</a>
          <a href="#" className="btn-ghost-lg">Fleet owner? Talk to us &rarr;</a>
        </div>
      </section>

      <section className="content-section">
        <div className="pain-points">
          <div className="pain-point-row">
            <div className="pain-point-bar" />
            <div className="pain-point-text" style={{ fontSize: '20px', fontStyle: 'italic', lineHeight: 1.6 }}>
              &ldquo;Monday morning shouldn&apos;t start with two hours on a load board.&rdquo;
            </div>
          </div>

          <div className="pain-point-row">
            <div className="pain-point-bar" />
            <div className="pain-point-text" style={{ fontSize: '20px', fontStyle: 'italic', lineHeight: 1.6 }}>
              &ldquo;Deadheading 200 miles for an $800 load isn&apos;t a business. It&apos;s survival.&rdquo;
            </div>
          </div>

          <div className="pain-point-row">
            <div className="pain-point-bar" />
            <div className="pain-point-text" style={{ fontSize: '20px', fontStyle: 'italic', lineHeight: 1.6 }}>
              &ldquo;Net-30 isn&apos;t a payment term. It&apos;s a cash flow crisis.&rdquo;
            </div>
          </div>

          <div className="pain-point-row">
            <div className="pain-point-bar" />
            <div className="pain-point-text" style={{ fontSize: '20px', fontStyle: 'italic', lineHeight: 1.6 }}>
              &ldquo;You run the truck. You shouldn&apos;t also have to run the sales calls.&rdquo;
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
            <div className="step-card-title">Set your lane preferences</div>
            <div className="step-card-desc">
              Tell Myra where you run, what you haul, and your equipment type. Once. We remember it every time.
            </div>
          </div>

          <div className="step-card">
            <div className="step-number">02</div>
            <div className="step-card-title">Loads come to you</div>
            <div className="step-card-desc">
              When a shipper posts a load that matches your profile, Myra surfaces it instantly. No bidding wars. No cold calls.
            </div>
          </div>

          <div className="step-card">
            <div className="step-number">03</div>
            <div className="step-card-title">Confirm and move</div>
            <div className="step-card-desc">
              Review the load, confirm in the app, and go. Documentation handled. BOL generated automatically.
            </div>
          </div>

          <div className="step-card">
            <div className="step-number">04</div>
            <div className="step-card-title">Get paid</div>
            <div className="step-card-desc">
              Payment processed on delivery confirmation. Fast, transparent, no surprises. Percentage of freight value — the same model every time.
            </div>
          </div>
        </div>
      </section>

      <section className="content-section">
        <div className="benefits-grid">
          <div className="benefit-card">
            <div className="benefit-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e8601f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="3 11 22 2 13 21 11 13 3 11" />
              </svg>
            </div>
            <div className="benefit-title">Lane-Matched Loads</div>
            <div className="benefit-desc">
              Myra doesn&apos;t show you every load. It shows you the loads that make sense for your route — reducing empty miles, increasing revenue per mile.
            </div>
          </div>

          <div className="benefit-card">
            <div className="benefit-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e8601f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <div className="benefit-title">Verified Shippers Only</div>
            <div className="benefit-desc">
              Every shipper on Myra is vetted. You&apos;re not chasing payment from a mystery LLC. You&apos;re moving freight for real businesses.
            </div>
          </div>

          <div className="benefit-card">
            <div className="benefit-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e8601f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="1" x2="12" y2="23" />
                <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
              </svg>
            </div>
            <div className="benefit-title">Transparent Rate Structure</div>
            <div className="benefit-desc">
              A percentage of freight value. No hidden broker spread. No bait-and-switch after you confirm.
            </div>
          </div>

          <div className="benefit-card">
            <div className="benefit-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e8601f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </div>
            <div className="benefit-title">Fast Payment</div>
            <div className="benefit-desc">
              Payment initiated on POD confirmation. No net-30. No chasing invoices. You delivered. You get paid.
            </div>
          </div>
        </div>
      </section>

      <section className="content-section alt">
        <div className="section-eyebrow">The Myra Carrier Standard</div>
        <h2 className="section-headline">We verify you once. Shippers trust you forever.</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '15px', maxWidth: '560px', margin: '0 auto 24px', lineHeight: 1.7, textAlign: 'center' }}>
          When you join Myra&apos;s carrier network, we run a full verification:
        </p>
        <div style={{ maxWidth: '480px', margin: '0 auto 32px', textAlign: 'left' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: '15px', lineHeight: 2.2 }}>
            &#10003; FMCSA registration confirmed<br />
            &#10003; Safety rating reviewed (85+ required)<br />
            &#10003; Cargo insurance verified ($2M minimum)<br />
            &#10003; E&amp;O insurance on file<br />
            &#10003; Operating history reviewed<br />
            &#10003; Equipment and capacity confirmed
          </div>
        </div>
        <blockquote style={{ color: 'var(--text-primary)', fontSize: '17px', fontStyle: 'italic', maxWidth: '520px', margin: '0 auto', lineHeight: 1.7, textAlign: 'center', borderLeft: 'none' }}>
          &ldquo;When you&apos;re in the network — you&apos;re the carrier shippers ask for by name.&rdquo;
        </blockquote>
      </section>

      <section className="content-section">
        <div className="section-eyebrow">Simple. Transparent. Fair.</div>
        <h2 className="section-headline">You move the freight. We take a percentage. That&apos;s it.</h2>
        <div style={{ color: 'var(--text-muted)', fontSize: '15px', maxWidth: '520px', margin: '0 auto 32px', lineHeight: 1.8, textAlign: 'center' }}>
          A single percentage of freight value per load.<br />
          No subscription fees for carriers.<br />
          No monthly minimums.<br />
          No hidden charges.<br />
          The more you move, the more you make.<br />
          Myra&apos;s incentive and yours are identical.
        </div>
        <div style={{ textAlign: 'center' }}>
          <a href="#" className="btn-primary-lg">Apply to Join the Network</a>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '16px', lineHeight: 1.6 }}>
            Applications reviewed within 48 hours. Verification completed before your first load.
          </p>
        </div>
      </section>

      <section className="content-section alt" style={{ textAlign: 'center' }}>
        <h2 className="section-headline">Your truck should be full right now.</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '15px', maxWidth: '480px', margin: '0 auto 36px', lineHeight: 1.7 }}>
          Myra has loads that fit your lane today. Join the network. We&apos;ll handle the rest.
        </p>
        <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <a href="/get-started" className="btn-primary-lg">Join the Carrier Network</a>
          <a href="#" className="btn-ghost-lg">Talk to Our Team &rarr;</a>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '16px' }}>
          Free to join &middot; Verified in 48 hours &middot; First load matched automatically
        </p>
      </section>
    </>
  )
}
