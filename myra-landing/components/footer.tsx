import Link from 'next/link'
import Image from 'next/image'
import siteConfig from '@/content/site-config.json'

const socialIcons: Record<string, React.ReactNode> = {
  linkedin: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
    </svg>
  ),
  twitter: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
    </svg>
  ),
  github: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
    </svg>
  ),
  youtube: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
    </svg>
  ),
}

function isInternal(href: string) {
  return href.startsWith('/')
}

export function Footer() {
  const { company, socialLinks, footerLinks } = siteConfig
  const activeSocials = Object.entries(socialLinks).filter(([, url]) => url !== '')

  return (
    <footer className="site-footer">
      <div className="footer-glow"></div>
      <div className="footer-main">
        <div className="footer-brand-col">
          <div className="footer-logo">
            <Image src="/myra-mascot.png" alt="Myra mascot" width={36} height={36} style={{ borderRadius: 9 }} />
            <span className="footer-logo-name">MYRA.</span>
          </div>
          <p className="footer-tagline">{company.tagline}</p>
          {activeSocials.length > 0 && (
            <div className="footer-social">
              {activeSocials.map(([platform, url]) => (
                <a key={platform} href={url} className="footer-social-btn" aria-label={platform} target="_blank" rel="noopener noreferrer">
                  {socialIcons[platform]}
                </a>
              ))}
            </div>
          )}
        </div>

        <div>
          <h4 className="footer-col-title">Resources</h4>
          <ul className="footer-links">
            {footerLinks.resources.map((link) => (
              <li key={link.label}>
                {isInternal(link.href) ? (
                  <Link href={link.href} className="footer-link">{link.label}</Link>
                ) : (
                  <a href={link.href} className="footer-link">{link.label}</a>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h4 className="footer-col-title">Company</h4>
          <ul className="footer-links">
            {footerLinks.company.map((link) => (
              <li key={link.label}>
                {isInternal(link.href) ? (
                  <Link href={link.href} className="footer-link">{link.label}</Link>
                ) : (
                  <a href={link.href} className="footer-link">{link.label}</a>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="footer-bottom">
        <p className="footer-legal">
          MYRA is a registered trademark of {company.legalName} All rights reserved. Freight brokerage services provided under MC and DOT authority.
        </p>
        <p className="footer-copy">&copy; {company.copyrightYear} {company.legalName}</p>
      </div>
    </footer>
  )
}
