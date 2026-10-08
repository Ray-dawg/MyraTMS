// Pure helpers that decide HOW a stored document can be previewed.
//
// The `documents` table has no mime/content-type column (see
// scripts/001-create-tables.sql: name, type, blob_url, file_size, ...). `type`
// is the business type (BOL, POD, ...), not a file type, so the file kind has
// to be derived from the file extension of `name`, falling back to the
// extension in the blob URL's path.

export type PreviewKind = "image" | "pdf" | "other" | "none"

export interface PreviewTarget {
  kind: PreviewKind
  /** Safe http(s) URL, or null when kind === "none". */
  url: string | null
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"])

function extensionOf(value: string): string {
  const base = value.split("/").pop() ?? ""
  const dot = base.lastIndexOf(".")
  if (dot < 0 || dot === base.length - 1) return ""
  return base.slice(dot + 1).toLowerCase()
}

function urlPathExtension(url: string): string {
  try {
    return extensionOf(decodeURIComponent(new URL(url).pathname))
  } catch {
    return ""
  }
}

function isSafeHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" || parsed.protocol === "http:"
  } catch {
    return false
  }
}

/**
 * @param doc.name     the document's file name (documents.name)
 * @param doc.blobUrl  the stored URL (documents.blob_url; '' when none)
 */
export function getPreviewTarget(doc: { name?: string | null; blobUrl?: string | null }): PreviewTarget {
  const url = (doc.blobUrl ?? "").trim()
  if (!url || !isSafeHttpUrl(url)) return { kind: "none", url: null }

  const ext = extensionOf((doc.name ?? "").trim()) || urlPathExtension(url)
  if (ext === "pdf") return { kind: "pdf", url }
  if (IMAGE_EXTENSIONS.has(ext)) return { kind: "image", url }
  return { kind: "other", url }
}
