"use client"

import dynamic from "next/dynamic"

const GlobalMap = dynamic(() => import("@/components/global-load-map"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center" style={{ height: "calc(100vh - 64px)" }}>
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
    </div>
  ),
})

export default function MapPage() {
  return <GlobalMap />
}
