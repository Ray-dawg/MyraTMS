interface PageHeroProps {
  eyebrow: string
  title: string
  subtitle: string
}

export function PageHero({ eyebrow, title, subtitle }: PageHeroProps) {
  return (
    <section className="page-hero">
      <div className="page-hero-eyebrow">{eyebrow}</div>
      <h1 className="page-hero-title">{title}</h1>
      <p className="page-hero-subtitle">{subtitle}</p>
    </section>
  )
}
