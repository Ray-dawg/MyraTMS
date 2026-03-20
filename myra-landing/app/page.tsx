import { HeroHome } from '@/components/hero-home'
import { ValuePropStrip } from '@/components/value-prop-strip'
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
      <ValuePropStrip />
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
