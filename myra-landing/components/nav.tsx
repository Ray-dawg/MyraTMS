'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, useEffect, Fragment } from 'react'

export function Nav() {
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = useState(false)
  const [transparent, setTransparent] = useState(pathname === '/')

  useEffect(() => {
    if (pathname !== '/') {
      setTransparent(false)
      return
    }
    const handleScroll = () => {
      setTransparent(window.scrollY < 50)
    }
    handleScroll()
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [pathname])

  // Close menu on route change
  useEffect(() => { setMenuOpen(false) }, [pathname])

  const links = [
    { href: '/platform', label: 'Platform' },
    { href: '/carriers', label: 'Carriers' },
    { href: '/shippers', label: 'Shippers' },
    { href: '/about', label: 'About' },
  ]

  return (
    <nav className={`site-nav${transparent ? ' transparent' : ''}`}>
      <Link href="/" className="nav-logo">MYRA</Link>

      <ul className={`nav-links${menuOpen ? ' open' : ''}`}>
        {links.map((link, i) => (
          <Fragment key={link.href}>
            {i > 0 && <li><span className="nav-sep"></span></li>}
            <li>
              <Link
                href={link.href}
                className={pathname === link.href ? 'nav-link-active' : ''}
              >
                {link.label}
              </Link>
            </li>
          </Fragment>
        ))}
      </ul>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button
          className="nav-hamburger"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Toggle menu"
        >
          {menuOpen ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          )}
        </button>
        <Link href="/get-started" className="nav-cta">Get Started</Link>
      </div>
    </nav>
  )
}
