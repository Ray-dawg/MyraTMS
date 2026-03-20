"use client"

import { useRef, useCallback, useEffect, useState } from "react"

function playHorn() {
  const audio = new Audio("/sounds/truck-horn.mp3")
  audio.volume = 0.7
  audio.play().catch(() => {})
}

export function HeroHome() {
  const heroRef = useRef<HTMLDivElement>(null)
  const toastRef = useRef<HTMLDivElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)
  const flashRef = useRef<HTMLDivElement>(null)
  const d1Ref = useRef<HTMLDivElement>(null)
  const d2Ref = useRef<HTMLDivElement>(null)
  const r1Ref = useRef<HTMLDivElement>(null)
  const r2Ref = useRef<HTMLDivElement>(null)
  const r3Ref = useRef<HTMLDivElement>(null)

  const lightsOnRef = useRef(false)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clickBufRef = useRef(0)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const updateHint = useCallback(() => {
    if (!hintRef.current) return
    hintRef.current.textContent = lightsOnRef.current
      ? "Click to turn off \u00b7 Double-click to honk"
      : "Click to turn on lights"
  }, [])

  const showToast = useCallback((msg: string, ms = 1700) => {
    const toast = toastRef.current
    if (!toast) return
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toast.textContent = msg
    toast.classList.add("show")
    toastTimerRef.current = setTimeout(() => toast.classList.remove("show"), ms)
  }, [])

  const showDots = useCallback((n: number) => {
    d1Ref.current?.classList.toggle("active", n >= 1)
    d2Ref.current?.classList.toggle("active", n >= 2)
  }, [])

  const fireRipples = useCallback(() => {
    const ripples = [r1Ref.current, r2Ref.current, r3Ref.current]
    ripples.forEach((r, i) => {
      if (!r) return
      r.classList.remove("fire")
      void r.offsetWidth
      setTimeout(() => r.classList.add("fire"), i * 130)
    })
  }, [])

  const flashScreen = useCallback(() => {
    const flash = flashRef.current
    if (!flash) return
    flash.classList.add("active")
    setTimeout(() => flash.classList.remove("active"), 100)
  }, [])

  const turnLightsOn = useCallback(() => {
    const hero = heroRef.current
    if (!hero) return
    lightsOnRef.current = true
    hero.classList.remove("lights-off-anim")
    hero.classList.add("lights-on")
    showToast("\u26a1 Lights on")
    updateHint()
  }, [showToast, updateHint])

  const turnLightsOff = useCallback(() => {
    const hero = heroRef.current
    if (!hero) return
    lightsOnRef.current = false
    hero.classList.add("lights-off-anim")
    setTimeout(() => {
      hero.classList.remove("lights-on")
      setTimeout(() => hero.classList.remove("lights-off-anim"), 450)
    }, 20)
    showToast("Lights off")
    updateHint()
  }, [showToast, updateHint])

  const doHonk = useCallback(() => {
    playHorn()
    fireRipples()
    flashScreen()
    showToast("\ud83d\udcef Honk honk!", 1400)
  }, [fireRipples, flashScreen, showToast])

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest("nav")) return

      clickBufRef.current++
      showDots(clickBufRef.current)

      if (clickBufRef.current === 1) {
        pendingTimerRef.current = setTimeout(() => {
          clickBufRef.current = 0
          showDots(0)
          lightsOnRef.current ? turnLightsOff() : turnLightsOn()
        }, 280)
      } else if (clickBufRef.current === 2) {
        if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
        clickBufRef.current = 0
        showDots(0)
        if (!lightsOnRef.current) {
          turnLightsOn()
          setTimeout(() => doHonk(), 200)
        } else {
          doHonk()
        }
      }
    },
    [showDots, turnLightsOn, turnLightsOff, doHonk]
  )

  useEffect(() => {
    updateHint()
  }, [updateHint])

  return (
    <div className="hero" id="hero" ref={heroRef} onClick={handleClick}>
      <div className="bg-layer bg-dark"></div>
      <div className="bg-layer bg-lights"></div>
      <div className="headlight-beam"></div>
      <div className="headlight-flare"></div>
      <div className="hero-overlay"></div>
      <div className="hero-flash" id="heroFlash" ref={flashRef}></div>

      <div className="hero-toast" id="heroToast" ref={toastRef}></div>

      <div className="hero-copy">
        <h1 className="hero-h1">Your load is moving<br />in 30 minutes.</h1>
      </div>

      <div className="trailer-brand">
        <div className="trailer-brand-name">MYRA</div>
        <div className="trailer-brand-sub">Intelligent Brokerage</div>
      </div>

      <div
        className="ripple"
        id="r1"
        ref={r1Ref}
        style={{ width: 160, height: 160, left: "21%", top: "65%" }}
      ></div>
      <div
        className="ripple"
        id="r2"
        ref={r2Ref}
        style={{ width: 260, height: 260, left: "21%", top: "65%" }}
      ></div>
      <div
        className="ripple"
        id="r3"
        ref={r3Ref}
        style={{ width: 380, height: 380, left: "21%", top: "65%" }}
      ></div>

      <div className="click-hint">
        <div className="click-hint-text" id="hintText" ref={hintRef}>
          Click to turn on lights
        </div>
        <div className="click-hint-line"></div>
      </div>

      <div className="state-dots">
        <div className="dot" id="d1" ref={d1Ref}></div>
        <div className="dot" id="d2" ref={d2Ref}></div>
      </div>
    </div>
  )
}
