/**
 * Haptic feedback utility for mobile PWA.
 * Uses the Vibration API where available, degrades gracefully.
 */

export function hapticLight() {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(10)
  }
}

export function hapticMedium() {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(25)
  }
}

export function hapticHeavy() {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(50)
  }
}

export function hapticSuccess() {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate([15, 50, 15])
  }
}

export function hapticError() {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate([50, 30, 50, 30, 50])
  }
}
