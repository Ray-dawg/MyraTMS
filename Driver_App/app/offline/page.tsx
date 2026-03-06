'use client'

import { WifiOff, RefreshCw } from 'lucide-react'

export default function OfflinePage() {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'linear-gradient(160deg, #060e1a, #091828, #0a1c2e)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 28px',
        fontFamily: "-apple-system, 'SF Pro Display', BlinkMacSystemFont, 'Inter', sans-serif",
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 72,
          height: 72,
          borderRadius: 22,
          background: 'rgba(248,113,113,0.12)',
          border: '1px solid rgba(248,113,113,0.25)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 24,
        }}
      >
        <WifiOff size={32} color="#f87171" />
      </div>
      <h1
        style={{
          color: '#f1f5f9',
          fontSize: 22,
          fontWeight: 800,
          margin: '0 0 8px',
          letterSpacing: '-0.02em',
        }}
      >
        You&apos;re Offline
      </h1>
      <p
        style={{
          color: '#64748b',
          fontSize: 14,
          lineHeight: 1.6,
          margin: '0 0 32px',
          maxWidth: 280,
        }}
      >
        Check your internet connection and try again. Your data will sync when you&apos;re back online.
      </p>
      <button
        onClick={() => window.location.reload()}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '14px 28px',
          borderRadius: 16,
          background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
          border: 'none',
          color: '#fff',
          fontSize: 14,
          fontWeight: 700,
          cursor: 'pointer',
          boxShadow: '0 6px 24px rgba(59,130,246,0.3)',
        }}
      >
        <RefreshCw size={16} />
        Try Again
      </button>
    </div>
  )
}
