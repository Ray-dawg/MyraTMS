# Myra Landing Page — Design Spec

## Goal
Convert the monolithic `myra-landing-v6.html` into a Next.js micro-site with 8 pages, shared layout, mobile nav, and real MP3 horn sound. Deploy as standalone static site on Vercel.

## Pages
1. `/` — Home (pixel-perfect port of v6.html)
2. `/platform` — Product overview for decision-makers
3. `/carriers` — Carrier recruitment page
4. `/shippers` — Shipper solutions page
5. `/about` — Company story and mission
6. `/privacy` — Privacy policy
7. `/terms` — Terms of service
8. `/careers` — Careers page

## Design System (from v6)
- Dark theme: `--bg: #0a0c0b`, `--surface: #111412`, `--card: #161a18`
- Primary: `#e8601f` (orange)
- Fonts: Barlow (body), Barlow Condensed (headlines), JetBrains Mono (code)
- Borders: `rgba(255,255,255,.07)` and `.12`
- Section pattern: eyebrow → headline → body → CTA

## Key Changes from v6
- Web Audio horn → MP3 (`Truck-horn-sound.mp3`)
- "Log In" nav CTA → "Get Started" (no external login)
- Mobile hamburger menu added
- All external links placeholder (`#`)
- All copy placeholder (user will provide final copy)

## Tech
- Next.js 16, App Router, static export
- pnpm
- No Shadcn (raw CSS to match v6 exactly)
- Mapbox GL JS for tracker map
