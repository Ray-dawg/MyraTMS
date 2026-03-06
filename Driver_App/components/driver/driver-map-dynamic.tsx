"use client"

import dynamic from "next/dynamic"

export const DriverMap = dynamic(
  () => import("./driver-map").then((mod) => mod.DriverMap),
  { ssr: false }
)
