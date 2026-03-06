"use client"

import useSWR, { mutate } from "swr"

const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (res.status === 401) {
    // Not authenticated - redirect to login
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.href = "/login"
    }
    throw new Error("Unauthorized")
  }
  if (!res.ok) throw new Error(`API Error: ${res.status}`)
  return res.json()
}

// Global SWR defaults to reduce unnecessary refetches
const swrDefaults = {
  dedupingInterval: 5000,
  revalidateOnFocus: false,
}

// --- Loads ---
export function useLoads(params?: { status?: string; search?: string }) {
  const query = new URLSearchParams()
  if (params?.status && params.status !== "all") query.set("status", params.status)
  if (params?.search) query.set("search", params.search)
  const qs = query.toString()
  return useSWR(`/api/loads${qs ? `?${qs}` : ""}`, fetcher, swrDefaults)
}

export function useLoad(id: string | null) {
  return useSWR(id ? `/api/loads/${id}` : null, fetcher, swrDefaults)
}

export async function createLoad(data: Record<string, unknown>) {
  const res = await fetch("/api/loads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
  if (!res.ok) throw new Error("Failed to create load")
  mutate((key: string) => typeof key === "string" && key.startsWith("/api/loads"), undefined, { revalidate: true })
  return res.json()
}

export async function updateLoad(id: string, data: Record<string, unknown>) {
  const res = await fetch(`/api/loads/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
  if (!res.ok) throw new Error("Failed to update load")
  mutate((key: string) => typeof key === "string" && key.startsWith("/api/loads"), undefined, { revalidate: true })
  return res.json()
}

// --- Shippers ---
export function useShippers(params?: { search?: string }) {
  const query = new URLSearchParams()
  if (params?.search) query.set("search", params.search)
  const qs = query.toString()
  return useSWR(`/api/shippers${qs ? `?${qs}` : ""}`, fetcher, swrDefaults)
}

export function useShipper(id: string | null) {
  return useSWR(id ? `/api/shippers/${id}` : null, fetcher, swrDefaults)
}

export async function createShipper(data: Record<string, unknown>) {
  const res = await fetch("/api/shippers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
  if (!res.ok) throw new Error("Failed to create shipper")
  mutate((key: string) => typeof key === "string" && key.startsWith("/api/shippers"), undefined, { revalidate: true })
  return res.json()
}

// --- Carriers ---
export function useCarriers(params?: { search?: string }) {
  const query = new URLSearchParams()
  if (params?.search) query.set("search", params.search)
  const qs = query.toString()
  return useSWR(`/api/carriers${qs ? `?${qs}` : ""}`, fetcher, swrDefaults)
}

export function useCarrier(id: string | null) {
  return useSWR(id ? `/api/carriers/${id}` : null, fetcher, swrDefaults)
}

export async function createCarrier(data: Record<string, unknown>) {
  const res = await fetch("/api/carriers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
  if (!res.ok) throw new Error("Failed to create carrier")
  mutate((key: string) => typeof key === "string" && key.startsWith("/api/carriers"), undefined, { revalidate: true })
  return res.json()
}

// --- Invoices ---
export function useInvoices(params?: { status?: string; loadId?: string }) {
  const query = new URLSearchParams()
  if (params?.status && params.status !== "all") query.set("status", params.status)
  if (params?.loadId) query.set("loadId", params.loadId)
  const qs = query.toString()
  return useSWR(`/api/invoices${qs ? `?${qs}` : ""}`, fetcher, swrDefaults)
}

// --- Documents ---
export function useDocuments(params?: { search?: string; relatedTo?: string; relatedType?: string }) {
  const query = new URLSearchParams()
  if (params?.search) query.set("search", params.search)
  if (params?.relatedTo) query.set("relatedTo", params.relatedTo)
  if (params?.relatedType) query.set("relatedType", params.relatedType)
  const qs = query.toString()
  return useSWR(`/api/documents${qs ? `?${qs}` : ""}`, fetcher, swrDefaults)
}

export async function uploadDocument(formData: FormData) {
  const res = await fetch("/api/documents/upload", { method: "POST", body: formData })
  if (!res.ok) throw new Error("Upload failed")
  mutate((key: string) => typeof key === "string" && key.startsWith("/api/documents"), undefined, { revalidate: true })
  return res.json()
}

export async function deleteDocument(id: string) {
  const res = await fetch(`/api/documents/${id}`, { method: "DELETE" })
  if (!res.ok) throw new Error("Delete failed")
  mutate((key: string) => typeof key === "string" && key.startsWith("/api/documents"), undefined, { revalidate: true })
  return res.json()
}

// --- Notifications ---
export function useNotifications(params?: { unread_only?: boolean; limit?: number }) {
  const query = new URLSearchParams()
  if (params?.unread_only) query.set("unread_only", "true")
  if (params?.limit) query.set("limit", String(params.limit))
  const qs = query.toString()
  return useSWR(`/api/notifications${qs ? `?${qs}` : ""}`, fetcher, { ...swrDefaults, refreshInterval: 30000 })
}

export async function markNotificationRead(id: string) {
  const res = await fetch(`/api/notifications/${id}/read`, { method: "PATCH" })
  if (!res.ok) throw new Error("Failed to mark notification read")
  mutate((key: string) => typeof key === "string" && key.startsWith("/api/notifications"), undefined, { revalidate: true })
  return res.json()
}

export async function markAllNotificationsRead() {
  const res = await fetch("/api/notifications/read-all", { method: "PATCH" })
  if (!res.ok) throw new Error("Failed to mark all notifications read")
  mutate((key: string) => typeof key === "string" && key.startsWith("/api/notifications"), undefined, { revalidate: true })
  return res.json()
}

// --- Finance Summary ---
export function useFinanceSummary() {
  return useSWR("/api/finance/summary", fetcher, swrDefaults)
}

// --- Activity Notes ---
export function useNotes(entityType: string, entityId: string | null) {
  return useSWR(entityId ? `/api/notes?entityType=${entityType}&entityId=${entityId}` : null, fetcher, swrDefaults)
}

export async function createNote(data: Record<string, unknown>) {
  const res = await fetch("/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
  if (!res.ok) throw new Error("Failed to create note")
  mutate((key: string) => typeof key === "string" && key.startsWith("/api/notes"), undefined, { revalidate: true })
  return res.json()
}

// --- Workflows ---
export function useWorkflows() {
  return useSWR("/api/workflows", fetcher, swrDefaults)
}

export function useWorkflow(id: string | null) {
  return useSWR(id ? `/api/workflows/${id}` : null, fetcher, swrDefaults)
}

export async function createWorkflow(data: Record<string, unknown>) {
  const res = await fetch("/api/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
  if (!res.ok) throw new Error("Failed to create workflow")
  mutate((key: string) => typeof key === "string" && key.startsWith("/api/workflows"), undefined, { revalidate: true })
  return res.json()
}

export async function updateWorkflow(id: string, data: Record<string, unknown>) {
  const res = await fetch(`/api/workflows/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
  if (!res.ok) throw new Error("Failed to update workflow")
  mutate((key: string) => typeof key === "string" && key.startsWith("/api/workflows"), undefined, { revalidate: true })
  return res.json()
}

export async function deleteWorkflow(id: string) {
  const res = await fetch(`/api/workflows/${id}`, { method: "DELETE" })
  if (!res.ok) throw new Error("Failed to delete workflow")
  mutate((key: string) => typeof key === "string" && key.startsWith("/api/workflows"), undefined, { revalidate: true })
  return res.json()
}

// --- Check Calls ---
export function useCheckCalls(loadId?: string) {
  const query = new URLSearchParams()
  if (loadId) query.set("loadId", loadId)
  const qs = query.toString()
  return useSWR(`/api/tracking/checkcall${qs ? `?${qs}` : ""}`, fetcher, swrDefaults)
}

export async function createCheckCall(data: Record<string, unknown>) {
  const res = await fetch("/api/tracking/checkcall", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
  if (!res.ok) throw new Error("Failed to create check-call")
  mutate((key: string) => typeof key === "string" && key.startsWith("/api/tracking"), undefined, { revalidate: true })
  return res.json()
}

// --- Tracking Positions ---
export function useTrackingPositions() {
  return useSWR("/api/tracking/positions", fetcher, { ...swrDefaults, refreshInterval: 30000 })
}

// --- Drivers ---
export function useDrivers(carrierId?: string) {
  const query = new URLSearchParams()
  if (carrierId) query.set("carrierId", carrierId)
  const qs = query.toString()
  return useSWR(`/api/drivers${qs ? `?${qs}` : ""}`, fetcher, swrDefaults)
}

// --- Compliance Alerts ---
export function useComplianceAlerts(carrierId?: string) {
  const query = new URLSearchParams()
  if (carrierId) query.set("carrierId", carrierId)
  const qs = query.toString()
  return useSWR(`/api/compliance/alerts${qs ? `?${qs}` : ""}`, fetcher, swrDefaults)
}

// --- AI Risk Analysis ---
export async function analyzeRisk() {
  const res = await fetch("/api/ai/analyze-risk", { method: "POST" })
  if (!res.ok) throw new Error("Failed to analyze risk")
  return res.json()
}

// --- Quotes ---
export function useQuotes(params?: { status?: string; search?: string; confidenceLabel?: string }) {
  const query = new URLSearchParams()
  if (params?.status && params.status !== "all") query.set("status", params.status)
  if (params?.search) query.set("search", params.search)
  if (params?.confidenceLabel) query.set("confidenceLabel", params.confidenceLabel)
  const qs = query.toString()
  return useSWR(`/api/quotes${qs ? `?${qs}` : ""}`, fetcher, swrDefaults)
}

export function useQuote(id: string | null) {
  return useSWR(id ? `/api/quotes/${id}` : null, fetcher, swrDefaults)
}

export async function createQuote(data: Record<string, unknown>) {
  const res = await fetch("/api/quotes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
  if (!res.ok) throw new Error("Failed to create quote")
  mutate((key: string) => typeof key === "string" && key.startsWith("/api/quotes"), undefined, { revalidate: true })
  return res.json()
}

export async function updateQuote(id: string, data: Record<string, unknown>) {
  const res = await fetch(`/api/quotes/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
  if (!res.ok) throw new Error("Failed to update quote")
  mutate((key: string) => typeof key === "string" && key.startsWith("/api/quotes"), undefined, { revalidate: true })
  return res.json()
}

export async function bookQuote(id: string) {
  const res = await fetch(`/api/quotes/${id}/book`, { method: "POST" })
  if (!res.ok) throw new Error("Failed to book quote")
  mutate((key: string) => typeof key === "string" && (key.startsWith("/api/quotes") || key.startsWith("/api/loads")), undefined, { revalidate: true })
  return res.json()
}

// --- Integrations ---
export function useIntegrations() {
  return useSWR("/api/integrations", fetcher, swrDefaults)
}

// --- Rate Cache ---
export function useRateCache(params?: { search?: string; equipmentType?: string }) {
  const query = new URLSearchParams()
  if (params?.search) query.set("search", params.search)
  if (params?.equipmentType) query.set("equipmentType", params.equipmentType)
  const qs = query.toString()
  return useSWR(`/api/rates${qs ? `?${qs}` : ""}`, fetcher, swrDefaults)
}

// --- Fuel Index ---
export function useFuelIndex() {
  return useSWR("/api/fuel-index", fetcher, swrDefaults)
}

// --- Quote Analytics ---
export function useQuoteAnalytics() {
  return useSWR("/api/quotes/analytics", fetcher, { ...swrDefaults, dedupingInterval: 30000 })
}
