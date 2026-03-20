import type { Metadata } from 'next'
import { PageHero } from '@/components/page-hero'

export const metadata: Metadata = {
  title: 'API Documentation — MYRA',
  description: 'Integrate with Myra\'s freight intelligence platform. REST API with real-time tracking, load management, and carrier matching.',
}

const endpoints = [
  {
    name: 'Loads',
    description: 'Create, update, list, and track loads through their full lifecycle — from booking to delivery and invoicing.',
    example: 'GET /api/loads',
    methods: ['GET', 'POST', 'PATCH'],
  },
  {
    name: 'Carriers',
    description: 'Search the carrier network, verify FMCSA compliance, view equipment and lane history, and manage carrier profiles.',
    example: 'GET /api/carriers',
    methods: ['GET', 'POST', 'PATCH'],
  },
  {
    name: 'Shippers',
    description: 'Manage shipper accounts, preferences, default facilities, and shipper-specific rate agreements.',
    example: 'GET /api/shippers/[id]',
    methods: ['GET', 'POST', 'PATCH'],
  },
  {
    name: 'Tracking',
    description: 'Real-time GPS positions, ETA calculations, SSE live streams, and proactive exception detection for in-transit loads.',
    example: 'POST /api/loads/[id]/location',
    methods: ['GET', 'POST'],
  },
  {
    name: 'Invoices',
    description: 'Generate, manage, and track invoices. Includes aging reports, payment status updates, and automated alert scheduling.',
    example: 'GET /api/invoices',
    methods: ['GET', 'POST', 'PATCH'],
  },
  {
    name: 'Documents',
    description: 'Upload and download BOLs, PODs, rate confirmations, and carrier packets. Supports Vercel Blob storage.',
    example: 'POST /api/loads/[id]/pod',
    methods: ['GET', 'POST'],
  },
  {
    name: 'Matching',
    description: 'AI-powered carrier matching engine. Scores carriers on lane familiarity, proximity, rate, reliability, and relationship.',
    example: 'POST /api/loads/[id]/match',
    methods: ['POST'],
  },
  {
    name: 'Quotes',
    description: 'Rate estimation using AI models, market data, and historical lane pricing. Create, update, and convert quotes to loads.',
    example: 'GET /api/quotes',
    methods: ['GET', 'POST', 'PATCH'],
  },
]

const methodColors: Record<string, string> = {
  GET: '#10b981',
  POST: '#3b82f6',
  PATCH: '#f59e0b',
  DELETE: '#ef4444',
}

export default function ApiDocsPage() {
  return (
    <>
      <style>{`
        .api-overview-grid {
          display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px;
          margin-top: 40px;
        }
        @media (max-width: 700px) { .api-overview-grid { grid-template-columns: 1fr; } }
        .api-overview-item {
          background: var(--card); border: 1px solid var(--border);
          border-radius: 12px; padding: 20px;
        }
        .api-overview-label {
          font-size: 11px; font-weight: 500; letter-spacing: .15em;
          text-transform: uppercase; color: var(--primary); margin-bottom: 8px;
        }
        .api-overview-value {
          font-size: 13px; font-weight: 300; color: var(--text-muted); line-height: 1.6;
        }
        .api-code {
          font-family: 'JetBrains Mono', monospace; font-size: 12px;
          background: rgba(255,255,255,.04); border: 1px solid var(--border);
          border-radius: 6px; padding: 2px 8px; color: var(--text);
          white-space: nowrap;
        }
        .api-auth-block {
          background: var(--card); border: 1px solid var(--border);
          border-radius: 14px; padding: 28px 24px; margin-top: 32px;
        }
        .api-auth-header {
          font-family: 'JetBrains Mono', monospace; font-size: 12px;
          color: var(--text-muted); margin-bottom: 12px;
        }
        .api-auth-code {
          font-family: 'JetBrains Mono', monospace; font-size: 13px;
          background: rgba(0,0,0,.3); border: 1px solid var(--border);
          border-radius: 8px; padding: 16px 20px; color: #e8e8e8;
          overflow-x: auto; line-height: 1.7;
        }
        .api-auth-comment { color: var(--text-faint); }
        .api-auth-key { color: #10b981; }
        .api-auth-string { color: #f59e0b; }
        .api-endpoint-card {
          background: var(--card); border: 1px solid var(--border);
          border-radius: 14px; padding: 24px 20px;
          transition: border-color .25s, background .25s;
          position: relative; overflow: hidden;
        }
        .api-endpoint-card::before {
          content: '';
          position: absolute; top: 0; left: 0; right: 0; height: 1px;
          background: linear-gradient(to right, transparent, rgba(232,96,31,.4), transparent);
          opacity: 0; transition: opacity .3s;
        }
        .api-endpoint-card:hover {
          border-color: rgba(232,96,31,.2);
          background: rgba(255,255,255,.025);
        }
        .api-endpoint-card:hover::before { opacity: 1; }
        .api-endpoint-name {
          font-size: 16px; font-weight: 600; color: var(--text);
          margin-bottom: 8px;
        }
        .api-endpoint-desc {
          font-size: 12px; font-weight: 300; color: var(--text-muted);
          line-height: 1.6; margin-bottom: 14px;
        }
        .api-endpoint-example {
          font-family: 'JetBrains Mono', monospace; font-size: 11px;
          background: rgba(0,0,0,.25); border: 1px solid var(--border);
          border-radius: 6px; padding: 8px 12px; color: var(--text);
          margin-bottom: 12px; display: inline-block;
        }
        .api-methods {
          display: flex; gap: 6px; flex-wrap: wrap;
        }
        .api-method-badge {
          font-family: 'JetBrains Mono', monospace; font-size: 10px;
          font-weight: 600; letter-spacing: .05em;
          padding: 3px 8px; border-radius: 4px;
          background: rgba(255,255,255,.05);
        }
        .api-coming-soon {
          background: var(--card); border: 1px solid var(--border);
          border-radius: 14px; padding: 32px 24px; text-align: center;
          margin-top: 48px;
        }
        .api-coming-soon-title {
          font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 8px;
        }
        .api-coming-soon-desc {
          font-size: 13px; font-weight: 300; color: var(--text-muted); line-height: 1.6;
          max-width: 480px; margin: 0 auto;
        }
      `}</style>

      <PageHero
        eyebrow="Developers"
        title="API Documentation"
        subtitle="Integrate with Myra's freight intelligence platform. REST API with real-time tracking, load management, and carrier matching."
      />

      {/* Overview */}
      <section className="content-section">
        <div className="content-inner">
          <div className="section-eyebrow">Overview</div>
          <h2 className="section-headline">Built for Integration</h2>
          <p className="section-subtitle">
            The Myra API is a RESTful JSON API secured with JWT authentication.
            Access load management, carrier matching, real-time tracking, and more
            from any platform.
          </p>

          <div className="api-overview-grid">
            <div className="api-overview-item">
              <div className="api-overview-label">Protocol</div>
              <div className="api-overview-value">
                REST over HTTPS. All responses return JSON. Standard HTTP status codes for errors.
              </div>
            </div>
            <div className="api-overview-item">
              <div className="api-overview-label">Base URL</div>
              <div className="api-overview-value">
                <span className="api-code">https://app.myra-ai.com/api</span>
              </div>
            </div>
            <div className="api-overview-item">
              <div className="api-overview-label">Rate Limits</div>
              <div className="api-overview-value">
                1,000 requests per minute per API key. Cached via Upstash Redis for performance.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Authentication */}
      <section className="content-section alt">
        <div className="content-inner">
          <div className="section-eyebrow">Authentication</div>
          <h2 className="section-headline">Bearer Token Auth</h2>
          <p className="section-subtitle">
            Authenticate by including a JWT token in the Authorization header of every request.
            Tokens are issued via the login endpoint and expire after 24 hours.
          </p>

          <div className="api-auth-block">
            <div className="api-auth-header">Example Request</div>
            <pre className="api-auth-code">
<span className="api-auth-comment"># Authenticate to receive a JWT token</span>{'\n'}
<span className="api-auth-key">POST</span> /api/auth/login{'\n'}
Content-Type: application/json{'\n'}
{'\n'}
{'{'}{'\n'}
{'  '}<span className="api-auth-string">&quot;email&quot;</span>: <span className="api-auth-string">&quot;user@example.com&quot;</span>,{'\n'}
{'  '}<span className="api-auth-string">&quot;password&quot;</span>: <span className="api-auth-string">&quot;your-password&quot;</span>{'\n'}
{'}'}{'\n'}
{'\n'}
<span className="api-auth-comment"># Use the token in subsequent requests</span>{'\n'}
<span className="api-auth-key">GET</span> /api/loads{'\n'}
Authorization: Bearer <span className="api-auth-string">&lt;your-jwt-token&gt;</span>
            </pre>
          </div>
        </div>
      </section>

      {/* Endpoints */}
      <section className="content-section">
        <div className="content-inner">
          <div className="section-eyebrow">Endpoints</div>
          <h2 className="section-headline">API Reference</h2>
          <p className="section-subtitle">
            Core endpoint groups for managing your freight operations programmatically.
          </p>

          <div className="benefits-grid">
            {endpoints.map((ep) => (
              <div className="api-endpoint-card" key={ep.name}>
                <div className="api-endpoint-name">{ep.name}</div>
                <div className="api-endpoint-desc">{ep.description}</div>
                <div className="api-endpoint-example">{ep.example}</div>
                <div className="api-methods">
                  {ep.methods.map((m) => (
                    <span
                      key={m}
                      className="api-method-badge"
                      style={{ color: methodColors[m] || 'var(--text)' }}
                    >
                      {m}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Coming Soon */}
          <div className="api-coming-soon">
            <div className="api-coming-soon-title">Interactive Documentation Coming Soon</div>
            <div className="api-coming-soon-desc">
              Full interactive API documentation with request/response examples,
              sandbox testing, and webhook configuration is in development.
              Contact us for early API access.
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="content-section alt">
        <div className="content-inner" style={{ textAlign: 'center' }}>
          <div className="section-eyebrow">Get Started</div>
          <h2 className="section-headline">Ready to Integrate?</h2>
          <p className="section-subtitle" style={{ margin: '0 auto 40px' }}>
            Request API access and our engineering team will provision your
            credentials and walk you through the integration process.
          </p>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
            <a href="#" className="btn-primary-lg">Request API Access</a>
            <a href="mailto:developers@myra-ai.com" className="btn-ghost-lg">Contact Engineering</a>
          </div>
        </div>
      </section>
    </>
  )
}
