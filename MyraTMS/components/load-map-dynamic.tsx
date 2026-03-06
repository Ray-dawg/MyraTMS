"use client"

import dynamic from "next/dynamic"
import { Skeleton } from "@/components/ui/skeleton"

export const LoadMap = dynamic(
  () => import("@/components/load-map").then((mod) => mod.LoadMap),
  {
    ssr: false,
    loading: () => <Skeleton className="w-full h-[320px] rounded-lg" />,
  }
)
