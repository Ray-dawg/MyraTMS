import type { Metadata } from 'next'
import { PageHero } from '@/components/page-hero'

export const metadata: Metadata = {
  title: 'Help Center — MYRA',
  description: 'Find answers, get support, and learn how to get the most out of Myra.',
}

const categories = [
  {
    title: 'Getting Started',
    description: 'Set up your account, post your first load, onboard carriers, and learn the basics of the Myra platform.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
      </svg>
    ),
  },
  {
    title: 'For Shippers',
    description: 'Managing loads, tracking shipments in real time, reviewing invoices, and working with your dedicated broker team.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
        <rect x="1" y="3" width="15" height="13"/>
        <polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/>
        <circle cx="5.5" cy="18.5" r="2.5"/>
        <circle cx="18.5" cy="18.5" r="2.5"/>
      </svg>
    ),
  },
  {
    title: 'For Carriers',
    description: 'Join the Myra carrier network, use the driver mobile app, submit PODs, manage check calls, and get paid faster.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
    ),
  },
  {
    title: 'Tracking & Visibility',
    description: 'Understanding the live tracking page, GPS position updates, ETA calculations, and proactive exception alerts.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
        <circle cx="12" cy="10" r="3"/>
        <path d="M12 21.7C17.3 17 20 13 20 10a8 8 0 1 0-16 0c0 3 2.7 6.9 8 11.7z"/>
      </svg>
    ),
  },
  {
    title: 'Billing & Payments',
    description: 'Invoice generation and management, payment terms, rate confirmations, dispute resolution, and financial reporting.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
        <line x1="12" y1="1" x2="12" y2="23"/>
        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
      </svg>
    ),
  },
  {
    title: 'Account & Security',
    description: 'Password reset, user roles and permissions, FMCSA compliance verification, and keeping your account secure.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
    ),
  },
]

export default function HelpPage() {
  return (
    <>
      <style>{`
        .help-search { max-width: 560px; margin: 0 auto 64px; position: relative; }
        .help-search-icon {
          position: absolute; left: 16px; top: 50%; transform: translateY(-50%);
          color: var(--text-faint); pointer-events: none;
        }
        .help-search-input {
          width: 100%; padding: 16px 20px 16px 44px;
          background: var(--card); border: 1px solid var(--border);
          border-radius: 12px; color: var(--text);
          font-family: 'Barlow', sans-serif; font-size: 14px;
          outline: none; transition: border-color .2s;
        }
        .help-search-input:focus { border-color: rgba(232,96,31,.4); }
        .help-search-input::placeholder { color: var(--text-faint); }
        .help-category-link {
          display: inline-flex; align-items: center; gap: 4px;
          font-size: 12px; font-weight: 500; color: var(--primary);
          margin-top: 14px; text-decoration: none; transition: gap .2s;
        }
        .help-category-link:hover { gap: 8px; }
        .help-contact-grid {
          display: grid; grid-template-columns: 1fr 1fr; gap: 20px;
          max-width: 520px; margin: 0 auto;
        }
        @media (max-width: 540px) { .help-contact-grid { grid-template-columns: 1fr; } }
        .help-contact-card {
          background: var(--card); border: 1px solid var(--border);
          border-radius: 14px; padding: 24px 20px; text-align: center;
        }
        .help-contact-label {
          font-size: 11px; font-weight: 500; letter-spacing: .15em;
          text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px;
        }
        .help-contact-value {
          font-size: 15px; font-weight: 600; color: var(--text);
        }
        .help-contact-value a {
          color: var(--text); text-decoration: none; transition: color .2s;
        }
        .help-contact-value a:hover { color: var(--primary); }
      `}</style>

      <PageHero
        eyebrow="Support"
        title="Help Center"
        subtitle="Find answers, get support, and learn how to get the most out of Myra."
      />

      {/* Search */}
      <section className="content-section">
        <div className="content-inner">
          <div className="help-search">
            <svg className="help-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              type="text"
              className="help-search-input"
              placeholder="Search for articles, guides, and FAQs..."
              readOnly
            />
          </div>

          {/* Category Grid */}
          <div className="benefits-grid">
            {categories.map((cat) => (
              <div className="benefit-card" key={cat.title}>
                <div className="benefit-icon">{cat.icon}</div>
                <div className="benefit-title">{cat.title}</div>
                <div className="benefit-desc">{cat.description}</div>
                <a href="#" className="help-category-link">
                  Browse articles
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                    <line x1="5" y1="12" x2="19" y2="12"/>
                    <polyline points="12 5 19 12 12 19"/>
                  </svg>
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Contact Support */}
      <section className="content-section alt">
        <div className="content-inner" style={{ textAlign: 'center' }}>
          <div className="section-eyebrow">Still need help?</div>
          <h2 className="section-headline">Can&apos;t find what you need?</h2>
          <p className="section-subtitle" style={{ margin: '0 auto 48px' }}>
            Our support team is available Monday through Friday, 7 AM to 7 PM CST.
            Reach out and we&apos;ll get back to you within one business hour.
          </p>

          <div className="help-contact-grid">
            <div className="help-contact-card">
              <div className="help-contact-label">Email</div>
              <div className="help-contact-value">
                <a href="mailto:support@myra-ai.com">support@myra-ai.com</a>
              </div>
            </div>
            <div className="help-contact-card">
              <div className="help-contact-label">Phone</div>
              <div className="help-contact-value">
                <a href="tel:1-800-697-2247">1-800-MYRA-AI</a>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}
