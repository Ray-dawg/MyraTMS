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
      <body suppressHydrationWarning>
        <Nav />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  )
}
