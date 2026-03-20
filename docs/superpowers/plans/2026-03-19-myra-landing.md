# Myra Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `myra-landing-v6.html` into a multi-page Next.js micro-site with 8 pages, shared nav/footer, mobile menu, and deploy-ready on Vercel.

**Architecture:** Next.js 16 App Router with a shared `layout.tsx` providing nav + footer. Home page is a pixel-perfect port of v6.html broken into client components for interactivity (hero, stats, map). Sub-pages use a reusable `PageHero` component and consistent section patterns. Static export for Vercel deployment.

**Tech Stack:** Next.js 16, React 19, TypeScript, CSS (global stylesheet extracted from v6), Mapbox GL JS, pnpm

**Source reference:** `myra-landing-v6.html` at repo root — the monolithic file being decomposed.

---

## File Structure

```
myra-landing/
├── app/
│   ├── layout.tsx              ← root layout: fonts, metadata, nav, footer
│   ├── globals.css             ← all CSS extracted from v6.html
│   ├── page.tsx                ← home page orchestrator
│   ├── platform/page.tsx       ← product overview
│   ├── carriers/page.tsx       ← carrier recruitment
│   ├── shippers/page.tsx       ← shipper solutions
│   ├── about/page.tsx          ← company story
│   ├── privacy/page.tsx        ← privacy policy
│   ├── terms/page.tsx          ← terms of service
│   └── careers/page.tsx        ← careers
├── components/
│   ├── nav.tsx                 ← shared nav with mobile hamburger
│   ├── footer.tsx              ← shared footer
│   ├── hero-home.tsx           ← home hero with headlights + horn (client)
│   ├── page-hero.tsx           ← sub-page hero (server)
│   ├── stats-bar.tsx           ← animated counter strip (client)
│   ├── problem-section.tsx     ← "BROKEN." section (client, scroll anim)
│   ├── how-it-works.tsx        ← 3-step section (client, scroll anim)
│   ├── trusted-by.tsx          ← logo ticker (client, animation)
│   ├── ipad-showcase.tsx       ← iPad frame + tracker app (client, mapbox)
│   ├── features-section.tsx    ← feature cards + SVG network (server)
│   ├── security-band.tsx       ← compliance badges (server)
│   ├── final-cta.tsx           ← bottom CTA section (server)
│   └── section-wrapper.tsx     ← reusable section container for sub-pages
├── public/
│   └── sounds/
│       └── truck-horn.mp3      ← real horn sound
├── next.config.ts
├── package.json
├── tsconfig.json
└── vercel.json
```

---

### Task 1: Scaffold Next.js Project

**Files:**
- Create: `myra-landing/package.json`
- Create: `myra-landing/next.config.ts`
- Create: `myra-landing/tsconfig.json`
- Create: `myra-landing/.gitignore`
- Copy: `Truck-horn-sound.mp3` → `myra-landing/public/sounds/truck-horn.mp3`

- [ ] **Step 1: Create the Next.js project**

```bash
cd "C:/Users/patri/OneDrive/Desktop/M1"
npx create-next-app@latest myra-landing --ts --app --tailwind=false --eslint --src-dir=false --import-alias="@/*" --use-pnpm
```

- [ ] **Step 2: Copy the horn sound file**

```bash
mkdir -p myra-landing/public/sounds
cp "C:/Users/patri/OneDrive/Desktop/Truck-horn-sound.mp3" myra-landing/public/sounds/truck-horn.mp3
```

- [ ] **Step 3: Configure next.config.ts for static export**

In `myra-landing/next.config.ts`:
```ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
}

export default nextConfig
```

- [ ] **Step 4: Verify the project builds**

```bash
cd myra-landing && pnpm run build
```
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add myra-landing/
git commit -m "feat(landing): scaffold Next.js project with static export config"
```

---

### Task 2: Extract Global CSS from v6.html

**Files:**
- Create: `myra-landing/app/globals.css`

Extract ALL CSS from `myra-landing-v6.html` into `globals.css`. This includes:
- CSS custom properties (`:root` block)
- Reset & base styles
- All section styles (hero, stats, problem, HIW, trusted, showcase/tracker, features, security, final CTA, footer)
- All responsive media queries
- All keyframe animations
- Utility classes

The CSS should be copied verbatim from v6 — do NOT convert to Tailwind or CSS modules. The design is locked.

- [ ] **Step 1: Create globals.css with all v6 CSS**

Copy all CSS from the `<style>` blocks in v6.html (there are 2 style blocks — lines 10-703 and lines 1599-2210) into `app/globals.css`. Add Google Fonts import at top. Remove any default Next.js CSS.

- [ ] **Step 2: Add font imports at top of globals.css**

```css
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Barlow:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
```

- [ ] **Step 3: Verify no duplicate/conflicting selectors between the two style blocks**

- [ ] **Step 4: Commit**

```bash
git add myra-landing/app/globals.css
git commit -m "feat(landing): extract all v6 CSS into globals.css"
```

---

### Task 3: Shared Layout — Nav + Footer

**Files:**
- Create: `myra-landing/app/layout.tsx`
- Create: `myra-landing/components/nav.tsx`
- Create: `myra-landing/components/footer.tsx`

- [ ] **Step 1: Create Nav component**

`components/nav.tsx` — client component ("use client") for mobile menu toggle.

Must include:
- Logo: "MYRA" linking to `/`
- Desktop links: Platform (`/platform`), Carriers (`/carriers`), Shippers (`/shippers`), About (`/about`) with separator dots between them (class `nav-sep`)
- CTA button: "Get Started" (links to `/#final-cta` to scroll to CTA on home, or `/` from sub-pages)
- Mobile hamburger: hidden on desktop, toggles a slide-down menu on mobile
- Use existing v6 CSS classes: `hero-nav`, `nav-logo`, `nav-links`, `nav-sep`, `nav-cta`
- **Important:** The nav in v6 is positioned inside the hero with `position:absolute`. For the shared layout, extract it to a fixed/sticky position that works on ALL pages, not just the hero. Add new CSS class `site-nav` that inherits the v6 look but works as a standalone fixed nav. On the home page, the nav should still appear over the hero with transparency.

Mobile hamburger CSS to add in globals.css:
```css
.nav-hamburger {
  display: none;
  background: none;
  border: none;
  cursor: pointer;
  padding: 8px;
  color: rgba(255,255,255,.65);
}
.nav-hamburger svg { width: 20px; height: 20px; }
@media (max-width: 680px) {
  .nav-hamburger { display: flex; }
  .nav-links { display: none; }
  .nav-links.open {
    display: flex;
    flex-direction: column;
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background: rgba(10,12,11,.97);
    backdrop-filter: blur(20px);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    gap: 0;
  }
  .nav-links.open li { padding: 12px 0; }
  .nav-links.open .nav-sep { display: none; }
}
```

- [ ] **Step 2: Create Footer component**

`components/footer.tsx` — server component.

Port the footer HTML from v6 (lines 2433-2497). Update links:
- **Resources column:** Platform → `/platform`, Carrier Portal → `#`, Shipper Dashboard → `#`, API Docs → `#`, Help Center → `#`
- **Company column:** About → `/about`, Careers → `/careers`, Press → `#`, Privacy Policy → `/privacy`, Terms of Service → `/terms`
- **Social buttons:** All href="#" (placeholder)
- Update copyright year to 2025-2026

- [ ] **Step 3: Create root layout.tsx**

`app/layout.tsx`:
```tsx
import type { Metadata } from 'next'
import { Nav } from '@/components/nav'
import { Footer } from '@/components/footer'
import './globals.css'

export const metadata: Metadata = {
  title: 'MYRA — Intelligent Freight Brokerage',
  description: 'AI-driven logistics. Intelligent routes. Absolute control.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  )
}
```

- [ ] **Step 4: Verify dev server starts with no errors**

```bash
cd myra-landing && pnpm run dev
```

- [ ] **Step 5: Commit**

```bash
git add myra-landing/app/layout.tsx myra-landing/components/nav.tsx myra-landing/components/footer.tsx
git commit -m "feat(landing): add shared layout with nav, mobile menu, and footer"
```

---

### Task 4: Home Page — Hero Section

**Files:**
- Create: `myra-landing/components/hero-home.tsx`
- Modify: `myra-landing/app/page.tsx`

- [ ] **Step 1: Create HeroHome client component**

`components/hero-home.tsx` — "use client" directive required.

Port the hero HTML from v6 (lines 710-756) and ALL hero JavaScript (lines 1375-1438).

Key changes:
- Replace Web Audio `playHorn()` function with MP3 playback:
```ts
function playHorn() {
  const audio = new Audio('/sounds/truck-horn.mp3')
  audio.volume = 0.7
  audio.play().catch(() => {}) // ignore autoplay restrictions
}
```
- Remove the entire `getAudio()`, old `playHorn()` Web Audio synth code
- Keep all other interactions: `turnLightsOn()`, `turnLightsOff()`, `doHonk()`, `fireRipples()`, `flashScreen()`, `showToast()`, `showDots()`, `updateHint()`
- Convert to React: use `useRef` for DOM elements, `useEffect` for event listeners
- Remove the `nav` from inside the hero (it's now in the layout). But keep the hero's CSS class structure so styles work.
- **Important:** The hero-nav in v6 sits inside `.hero` with absolute positioning. Since nav is now in layout, ensure the hero still has correct full-viewport-height rendering without the nav inside it. The layout nav should overlay the hero with `position:fixed; z-index:100`.

- [ ] **Step 2: Wire hero into home page**

`app/page.tsx`:
```tsx
import { HeroHome } from '@/components/hero-home'

export default function HomePage() {
  return (
    <>
      <HeroHome />
      {/* More sections added in subsequent tasks */}
    </>
  )
}
```

- [ ] **Step 3: Verify hero renders with headlights and horn**

Start dev server, click hero once (lights on), double-click (horn plays MP3).

- [ ] **Step 4: Commit**

```bash
git add myra-landing/components/hero-home.tsx myra-landing/app/page.tsx
git commit -m "feat(landing): port hero section with MP3 horn sound"
```

---

### Task 5: Home Page — Stats Bar + Problem Section

**Files:**
- Create: `myra-landing/components/stats-bar.tsx`
- Create: `myra-landing/components/problem-section.tsx`
- Modify: `myra-landing/app/page.tsx`

- [ ] **Step 1: Create StatsBar client component**

Port stats bar HTML (lines 762-785) and stats count-up JS (lines 2546-2578). Use `useEffect` + `useRef` for IntersectionObserver.

- [ ] **Step 2: Create ProblemSection client component**

Port problem section HTML (lines 790-837) and scroll-reveal JS (lines 2583-2598). Use `useEffect` + `useRef` for IntersectionObserver.

- [ ] **Step 3: Add to home page**

```tsx
import { HeroHome } from '@/components/hero-home'
import { StatsBar } from '@/components/stats-bar'
import { ProblemSection } from '@/components/problem-section'

export default function HomePage() {
  return (
    <>
      <HeroHome />
      <StatsBar />
      <ProblemSection />
    </>
  )
}
```

- [ ] **Step 4: Verify counters animate and problem rows reveal on scroll**

- [ ] **Step 5: Commit**

```bash
git add myra-landing/components/stats-bar.tsx myra-landing/components/problem-section.tsx myra-landing/app/page.tsx
git commit -m "feat(landing): add stats bar counter and problem section"
```

---

### Task 6: Home Page — How It Works + Trusted By

**Files:**
- Create: `myra-landing/components/how-it-works.tsx`
- Create: `myra-landing/components/trusted-by.tsx`
- Modify: `myra-landing/app/page.tsx`

- [ ] **Step 1: Create HowItWorks client component**

Port HIW HTML (lines 842-903) and JS animation (lines 2603-2628). Includes ghost numbers, node circles with connector line, step content, CTA buttons.

- [ ] **Step 2: Create TrustedBy client component**

Port trusted section HTML (lines 908-924) and ticker JS (lines 1444-1469). Includes the dual-row ticker with logo pills.

- [ ] **Step 3: Add to home page**

- [ ] **Step 4: Verify step animation and logo ticker work**

- [ ] **Step 5: Commit**

```bash
git add myra-landing/components/how-it-works.tsx myra-landing/components/trusted-by.tsx myra-landing/app/page.tsx
git commit -m "feat(landing): add how-it-works and trusted-by sections"
```

---

### Task 7: Home Page — iPad Showcase with Mapbox

**Files:**
- Create: `myra-landing/components/ipad-showcase.tsx`
- Modify: `myra-landing/app/page.tsx`

This is the most complex component — it contains:
1. The showcase section header
2. iPad frame with scroll-tilt animation (lines 2508-2540)
3. Full tracker app UI inside the iPad (lines 946-1362)
4. Mapbox GL map initialization (lines 1474-1598)
5. Refresh button interaction (lines 1591-1597)

- [ ] **Step 1: Create IpadShowcase client component**

"use client" — contains Mapbox, IntersectionObserver, scroll handler.

Key implementation notes:
- Load Mapbox GL JS via `next/script` or dynamic import
- Mapbox access token: `pk.eyJ1IjoicmF5ODgxNiIsImEiOiJjbThlbnUyOWYwM2Z0MmtxMWxpbDl4aTR0In0.by1iUYheNxA294wLpJUyXw`
- Port the full tracker HTML structure inside the iPad frame
- Port scroll-tilt animation with `requestAnimationFrame`
- Port map initialization with route, markers, arc calculation
- The `perspective` wrapper for 3D tilt needs to be preserved

- [ ] **Step 2: Install mapbox-gl**

```bash
cd myra-landing && pnpm add mapbox-gl
```

Also add the Mapbox CSS import in globals.css or component:
```css
@import 'mapbox-gl/dist/mapbox-gl.css';
```

- [ ] **Step 3: Add to home page**

- [ ] **Step 4: Verify iPad renders with map, tilt animation works on scroll**

- [ ] **Step 5: Commit**

```bash
git add myra-landing/components/ipad-showcase.tsx myra-landing/app/page.tsx myra-landing/package.json myra-landing/pnpm-lock.yaml
git commit -m "feat(landing): add iPad showcase with live Mapbox tracker"
```

---

### Task 8: Home Page — Features, Security, Final CTA

**Files:**
- Create: `myra-landing/components/features-section.tsx`
- Create: `myra-landing/components/security-band.tsx`
- Create: `myra-landing/components/final-cta.tsx`
- Modify: `myra-landing/app/page.tsx`

- [ ] **Step 1: Create FeaturesSection component**

Port features HTML (lines 2216-2375) including:
- Top header grid
- SVG network visualization with animated packet
- 4 feature cards (AI Dispatch, Visibility, Rate Intelligence, Carrier Network)

- [ ] **Step 2: Create SecurityBand component**

Port security band HTML (lines 2384-2417). 6 compliance items.

- [ ] **Step 3: Create FinalCta component**

Port final CTA HTML (lines 2422-2431). Update "Start Shipping Free" CTA — can link to `#` for now. Add `id="final-cta"` so nav "Get Started" button scrolls here.

- [ ] **Step 4: Complete the home page with all sections**

```tsx
import { HeroHome } from '@/components/hero-home'
import { StatsBar } from '@/components/stats-bar'
import { ProblemSection } from '@/components/problem-section'
import { HowItWorks } from '@/components/how-it-works'
import { TrustedBy } from '@/components/trusted-by'
import { IpadShowcase } from '@/components/ipad-showcase'
import { FeaturesSection } from '@/components/features-section'
import { SecurityBand } from '@/components/security-band'
import { FinalCta } from '@/components/final-cta'

export default function HomePage() {
  return (
    <>
      <HeroHome />
      <StatsBar />
      <ProblemSection />
      <HowItWorks />
      <TrustedBy />
      <IpadShowcase />
      <FeaturesSection />
      <SecurityBand />
      <FinalCta />
    </>
  )
}
```

- [ ] **Step 5: Visual verification — compare to myra-landing-v6.html side by side**

- [ ] **Step 6: Commit**

```bash
git add myra-landing/components/features-section.tsx myra-landing/components/security-band.tsx myra-landing/components/final-cta.tsx myra-landing/app/page.tsx
git commit -m "feat(landing): complete home page with features, security, and CTA"
```

---

### Task 9: Sub-Page Hero Component

**Files:**
- Create: `myra-landing/components/page-hero.tsx`

- [ ] **Step 1: Create PageHero component**

Reusable sub-page hero — smaller than home hero. Consistent dark bg with subtle radial glow.

```tsx
interface PageHeroProps {
  eyebrow: string
  title: string
  subtitle: string
}
```

Styling: similar to `.final-cta` section aesthetic but as a page hero — centered text, eyebrow label, large Barlow Condensed title, muted subtitle. ~40vh height. Subtle orange radial gradient background.

Add CSS for `.page-hero` in globals.css:
```css
.page-hero {
  background: var(--bg);
  padding: 160px 24px 80px; /* extra top for fixed nav */
  position: relative;
  overflow: hidden;
  text-align: center;
}
.page-hero::before {
  content: '';
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  width: 700px; height: 400px;
  background: radial-gradient(ellipse at center, rgba(232,96,31,.04) 0%, transparent 65%);
  pointer-events: none;
}
```

- [ ] **Step 2: Commit**

```bash
git add myra-landing/components/page-hero.tsx myra-landing/app/globals.css
git commit -m "feat(landing): add reusable PageHero component for sub-pages"
```

---

### Task 10: Platform Page

**Files:**
- Create: `myra-landing/app/platform/page.tsx`

- [ ] **Step 1: Create platform page**

Structure:
1. `<PageHero eyebrow="Platform" title="The Operating System for Modern Freight" subtitle="..." />`
2. Feature deep-dive section — 6 feature blocks (expand on the 4 from home + Document Vault + Integrations). Use alternating left/right layout or stacked cards with icon + title + description.
3. `<SecurityBand />` (reuse from home)
4. `<FinalCta />` (reuse from home)

All copy is placeholder — clearly written but user will provide final version.

Add CSS for sub-page content sections (`.content-section`, `.feature-deep-dive`, etc.) in globals.css.

- [ ] **Step 2: Verify page renders at /platform**

- [ ] **Step 3: Commit**

```bash
git add myra-landing/app/platform/page.tsx myra-landing/app/globals.css
git commit -m "feat(landing): add platform product overview page"
```

---

### Task 11: Carriers Page

**Files:**
- Create: `myra-landing/app/carriers/page.tsx`

- [ ] **Step 1: Create carriers page**

Structure:
1. `<PageHero eyebrow="Carriers" title="Drive with Myra" subtitle="Fewer empty miles. Instant load matching. Get paid faster." />`
2. Pain points section — carrier-specific problems (deadhead, slow payments, paperwork)
3. Benefits grid — 4-6 cards: instant matching, driver mobile app, quick pay, less paperwork, lane optimization, verified loads
4. How it works for carriers — 3 steps: Sign up → Get matched → Haul & get paid
5. CTA: "Apply to Join the Network" (placeholder `#`)

All copy is placeholder.

- [ ] **Step 2: Verify page renders at /carriers**

- [ ] **Step 3: Commit**

```bash
git add myra-landing/app/carriers/page.tsx
git commit -m "feat(landing): add carriers recruitment page"
```

---

### Task 12: Shippers Page

**Files:**
- Create: `myra-landing/app/shippers/page.tsx`

- [ ] **Step 1: Create shippers page**

Structure:
1. `<PageHero eyebrow="Shippers" title="Ship with Confidence" subtitle="Full visibility. Verified carriers. Competitive rates." />`
2. Pain points section — shipper-specific problems (no visibility, unreliable carriers, overpaying)
3. Benefits grid — 4-6 cards: real-time tracking, 98% on-time, AI-powered rates, compliance handled, live POD, dedicated support
4. Live tracking callout — reference the tracking page / iPad demo
5. CTA: "Get a Quote" or "Start Shipping" (placeholder `#`)

All copy is placeholder.

- [ ] **Step 2: Verify page renders at /shippers**

- [ ] **Step 3: Commit**

```bash
git add myra-landing/app/shippers/page.tsx
git commit -m "feat(landing): add shippers solutions page"
```

---

### Task 13: About Page

**Files:**
- Create: `myra-landing/app/about/page.tsx`

- [ ] **Step 1: Create about page**

Structure:
1. `<PageHero eyebrow="About" title="Reimagining Freight from the Ground Up" subtitle="..." />`
2. Mission statement section
3. The problem we saw — brief narrative
4. What we're building — vision section
5. Values / principles — 3-4 core values in cards
6. Team section — placeholder cards ("Coming soon" or generic)
7. CTA: "Join Us" linking to `/careers`

All copy is placeholder.

- [ ] **Step 2: Verify page renders at /about**

- [ ] **Step 3: Commit**

```bash
git add myra-landing/app/about/page.tsx
git commit -m "feat(landing): add about page"
```

---

### Task 14: Legal & Careers Pages

**Files:**
- Create: `myra-landing/app/privacy/page.tsx`
- Create: `myra-landing/app/terms/page.tsx`
- Create: `myra-landing/app/careers/page.tsx`

- [ ] **Step 1: Create privacy policy page**

`<PageHero>` + standard privacy policy sections (Data Collection, Usage, Third Parties, User Rights, Contact). Placeholder legal text. Add CSS for `.legal-content` — max-width prose with proper heading/paragraph spacing.

- [ ] **Step 2: Create terms of service page**

Same pattern. Placeholder TOS content.

- [ ] **Step 3: Create careers page**

`<PageHero eyebrow="Careers" title="Build the Future of Freight" />` + culture section + "No open positions yet, but we'd love to hear from you" + email CTA link.

- [ ] **Step 4: Verify all 3 pages render**

- [ ] **Step 5: Commit**

```bash
git add myra-landing/app/privacy/page.tsx myra-landing/app/terms/page.tsx myra-landing/app/careers/page.tsx myra-landing/app/globals.css
git commit -m "feat(landing): add privacy, terms, and careers pages"
```

---

### Task 15: Polish & Integration Testing

**Files:**
- Modify: `myra-landing/app/globals.css` (any fixes)
- Modify: `myra-landing/components/nav.tsx` (active state)

- [ ] **Step 1: Add active nav link styling**

Highlight the current page in the nav. Use `usePathname()` from `next/navigation` to detect active route. Add CSS class `.nav-link-active` with `color: var(--primary)`.

- [ ] **Step 2: Verify all 8 pages render correctly**

Navigate through every page. Check:
- Nav appears and works on all pages
- Footer links point to correct internal routes
- Mobile hamburger opens/closes
- Home page: all animations, interactions, Mapbox map
- Sub-pages: consistent styling, proper hero sizing

- [ ] **Step 3: Run production build**

```bash
cd myra-landing && pnpm run build
```

Expected: Build succeeds with static export. All 8 pages in `out/` directory.

- [ ] **Step 4: Test production build locally**

```bash
npx serve out
```

Verify all pages work in the static build.

- [ ] **Step 5: Commit**

```bash
git add -A myra-landing/
git commit -m "feat(landing): polish nav active states, verify all pages"
```

---

### Task 16: Vercel Deployment Setup

**Files:**
- Create: `myra-landing/vercel.json`

- [ ] **Step 1: Create vercel.json**

```json
{
  "framework": "nextjs",
  "buildCommand": "pnpm run build",
  "outputDirectory": "out"
}
```

- [ ] **Step 2: Commit final state**

```bash
git add myra-landing/
git commit -m "feat(landing): add Vercel deployment config — ready to ship"
```

- [ ] **Step 3: Deploy** (when user is ready)

```bash
cd myra-landing && vercel
```

---

## Execution Notes

- **Priority order:** Tasks 1-8 are critical path (home page must be pixel-perfect). Tasks 9-14 can be parallelized. Tasks 15-16 are final polish.
- **CSS strategy:** One big `globals.css` file extracted from v6. No CSS modules, no Tailwind. This preserves the exact look.
- **Client vs server:** Only components with interactivity (animations, event handlers, IntersectionObserver) need "use client". Static content stays server components.
- **Mapbox token:** Hardcoded in v6 — keep as-is for now. Move to env var later.
- **Copy is placeholder:** Every sub-page uses clear placeholder text. User will provide final copy separately.
