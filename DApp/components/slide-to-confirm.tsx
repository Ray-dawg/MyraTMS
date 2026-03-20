'use client'

import { useState, useRef, useCallback } from 'react'
import { ChevronRight, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { hapticLight, hapticHeavy, hapticSuccess } from '@/lib/haptics'

interface SlideToConfirmProps {
  label: string
  onConfirm: () => void
  disabled?: boolean
  className?: string
}

export function SlideToConfirm({ label, onConfirm, disabled, className }: SlideToConfirmProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const startXRef = useRef(0)
  const trackWidthRef = useRef(0)

  const threshold = 0.75 // 75% of track = confirmed

  const handleStart = useCallback((clientX: number) => {
    if (disabled || confirmed) return
    hapticLight()
    const track = trackRef.current
    if (!track) return
    trackWidthRef.current = track.offsetWidth - 52 // subtract thumb width
    startXRef.current = clientX
    setDragging(true)
  }, [disabled, confirmed])

  const handleMove = useCallback((clientX: number) => {
    if (!dragging) return
    const delta = clientX - startXRef.current
    const clamped = Math.max(0, Math.min(delta, trackWidthRef.current))
    setDragX(clamped)

    // Haptic at threshold
    const progress = clamped / trackWidthRef.current
    if (progress >= threshold && dragX / trackWidthRef.current < threshold) {
      hapticHeavy()
    }
  }, [dragging, dragX, threshold])

  const handleEnd = useCallback(() => {
    if (!dragging) return
    setDragging(false)
    const progress = dragX / trackWidthRef.current

    if (progress >= threshold) {
      hapticSuccess()
      setConfirmed(true)
      setDragX(trackWidthRef.current)
      setTimeout(() => {
        onConfirm()
        // Reset after callback
        setTimeout(() => {
          setConfirmed(false)
          setDragX(0)
        }, 600)
      }, 300)
    } else {
      // Snap back
      setDragX(0)
    }
  }, [dragging, dragX, threshold, onConfirm])

  const progress = trackWidthRef.current > 0 ? dragX / trackWidthRef.current : 0

  return (
    <div
      ref={trackRef}
      className={cn(
        'relative h-14 overflow-hidden rounded-xl transition-colors',
        confirmed ? 'bg-success' : 'bg-secondary',
        disabled && 'opacity-50',
        className
      )}
      onTouchStart={(e) => handleStart(e.touches[0].clientX)}
      onTouchMove={(e) => handleMove(e.touches[0].clientX)}
      onTouchEnd={handleEnd}
      onMouseDown={(e) => handleStart(e.clientX)}
      onMouseMove={(e) => handleMove(e.clientX)}
      onMouseUp={handleEnd}
      onMouseLeave={() => { if (dragging) handleEnd() }}
    >
      {/* Progress fill */}
      <div
        className={cn(
          'absolute inset-y-0 left-0 transition-colors',
          confirmed ? 'bg-success' : 'bg-primary/20'
        )}
        style={{ width: `${dragX + 52}px` }}
      />

      {/* Label */}
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        style={{ opacity: 1 - progress * 1.5 }}
      >
        <span className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
          {label}
          <ChevronRight className="size-4 animate-pulse" />
        </span>
      </div>

      {/* Confirmed label */}
      {confirmed && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none animate-in zoom-in duration-300">
          <span className="text-sm font-bold text-success-foreground flex items-center gap-2">
            <CheckCircle2 className="size-5" />
            Confirmed!
          </span>
        </div>
      )}

      {/* Thumb */}
      <div
        className={cn(
          'absolute top-1 left-1 flex size-12 items-center justify-center rounded-[10px] shadow-lg transition-colors select-none',
          confirmed ? 'bg-success-foreground text-success' : 'bg-primary text-primary-foreground',
          dragging && 'scale-105'
        )}
        style={{
          transform: `translateX(${dragX}px) ${dragging ? 'scale(1.05)' : 'scale(1)'}`,
          transition: dragging ? 'none' : 'transform 0.3s ease-out, background-color 0.3s',
        }}
      >
        {confirmed ? (
          <CheckCircle2 className="size-6" />
        ) : (
          <ChevronRight className="size-6" />
        )}
      </div>
    </div>
  )
}
