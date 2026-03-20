import { createClient } from '@sanity/client'

export const sanityClient = createClient({
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || 'ct2q4s9k',
  dataset: process.env.NEXT_PUBLIC_SANITY_DATASET || 'production',
  apiVersion: '2024-01-01',
  useCdn: true,
  token: process.env.SANITY_API_TOKEN,
})

// Helper to fetch with fallback to JSON config
export async function fetchSanity<T>(query: string, fallback: T): Promise<T> {
  try {
    const result = await sanityClient.fetch(query)
    if (result && (Array.isArray(result) ? result.length > 0 : true)) {
      return result as T
    }
    return fallback
  } catch {
    // Sanity not configured or no data yet — use JSON fallback
    return fallback
  }
}
