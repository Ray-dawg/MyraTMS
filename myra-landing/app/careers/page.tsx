import { PageHero } from '@/components/page-hero'
import careersData from '@/content/careers.json'

export default function CareersPage() {
  const { openPositions, noOpeningsMessage, contactEmail, values } = careersData
  const hasOpenings = openPositions.length > 0

  return (
    <>
      <PageHero
        eyebrow="Careers"
        title="Build the Future of Freight"
        subtitle="Join a team that's reimagining how goods move across North America."
      />

      <section className="content-section">
        <div className="content-inner">
          <div className="section-eyebrow">Culture</div>
          <h2 className="section-headline">What Drives Us</h2>

          <div className="benefits-grid" style={{ maxWidth: '900px' }}>
            {values.map((value) => (
              <div key={value.title} className="benefit-card">
                <div className="benefit-title">{value.title}</div>
                <div className="benefit-desc">{value.description}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="content-section alt" style={{ textAlign: 'center' }}>
        <div className="content-inner">
          <div className="section-eyebrow">Open Positions</div>

          {hasOpenings ? (
            <div style={{ maxWidth: '640px', margin: '0 auto' }}>
              {openPositions.map((job: { title: string; location: string; type: string; description: string }) => (
                <div key={job.title} className="benefit-card" style={{ textAlign: 'left', marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div className="benefit-title" style={{ marginBottom: 0 }}>{job.title}</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span style={{ fontSize: 10, padding: '4px 10px', borderRadius: 6, background: 'var(--primary-dim)', color: 'var(--primary)', fontWeight: 500 }}>{job.type}</span>
                      <span style={{ fontSize: 10, padding: '4px 10px', borderRadius: 6, background: 'rgba(255,255,255,.05)', color: 'var(--text-muted)', fontWeight: 500 }}>{job.location}</span>
                    </div>
                  </div>
                  <div className="benefit-desc">{job.description}</div>
                  <a href={`mailto:${contactEmail}?subject=Application: ${job.title}`} className="btn-primary-lg" style={{ marginTop: 16, display: 'inline-block', fontSize: 12, padding: '10px 20px' }}>
                    Apply Now
                  </a>
                </div>
              ))}
            </div>
          ) : (
            <>
              <h2 className="section-headline">No Open Positions Yet</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '15px', maxWidth: '520px', margin: '0 auto 20px', lineHeight: 1.8 }}>
                {noOpeningsMessage}
              </p>
              <p style={{ color: 'var(--text-muted)', fontSize: '15px', maxWidth: '520px', margin: '0 auto 40px', lineHeight: 1.8 }}>
                Send us your resume and tell us what excites you about the future of freight. We review every application personally.
              </p>
              <a href={`mailto:${contactEmail}`} className="btn-primary-lg">
                Send us your resume at {contactEmail}
              </a>
            </>
          )}
        </div>
      </section>
    </>
  )
}
