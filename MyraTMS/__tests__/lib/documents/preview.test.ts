import { describe, it, expect } from "vitest"
import { getPreviewTarget } from "@/lib/documents/preview"

const URL_PDF = "https://abc.public.blob.vercel-storage.com/tenants/2/documents/load-LD-1-rate-con.pdf"

describe("getPreviewTarget", () => {
  it("returns none for an empty / missing / whitespace URL", () => {
    expect(getPreviewTarget({ name: "a.pdf", blobUrl: "" })).toEqual({ kind: "none", url: null })
    expect(getPreviewTarget({ name: "a.pdf", blobUrl: "   " })).toEqual({ kind: "none", url: null })
    expect(getPreviewTarget({ name: "a.pdf" })).toEqual({ kind: "none", url: null })
    expect(getPreviewTarget({ name: "a.pdf", blobUrl: null })).toEqual({ kind: "none", url: null })
  })

  it("refuses non-http(s) URLs (javascript:, data:, relative)", () => {
    expect(getPreviewTarget({ name: "a.pdf", blobUrl: "javascript:alert(1)" }).kind).toBe("none")
    expect(getPreviewTarget({ name: "a.png", blobUrl: "data:image/png;base64,AAAA" }).kind).toBe("none")
    expect(getPreviewTarget({ name: "a.pdf", blobUrl: "/files/a.pdf" }).kind).toBe("none")
  })

  it("classifies PDFs by name, case-insensitively", () => {
    expect(getPreviewTarget({ name: "BOL-LD4833.pdf", blobUrl: URL_PDF })).toEqual({ kind: "pdf", url: URL_PDF })
    expect(getPreviewTarget({ name: "SCAN.PDF", blobUrl: URL_PDF }).kind).toBe("pdf")
  })

  it("classifies images by name", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp"]) {
      expect(getPreviewTarget({ name: `pod.${ext}`, blobUrl: `https://x.test/pod.${ext}` }).kind).toBe("image")
    }
  })

  it("falls back to the URL path extension when the name has none", () => {
    expect(getPreviewTarget({ name: "Rate Confirmation", blobUrl: URL_PDF }).kind).toBe("pdf")
    expect(getPreviewTarget({ name: "", blobUrl: "https://x.test/a/b/pod.JPG?token=1#frag" }).kind).toBe("image")
  })

  it("prefers the name extension over the URL extension", () => {
    expect(getPreviewTarget({ name: "doc.pdf", blobUrl: "https://x.test/blob-123.bin" }).kind).toBe("pdf")
  })

  it("treats spreadsheets / csv / unknown types as 'other' but keeps the URL for the open-in-new-tab link", () => {
    expect(getPreviewTarget({ name: "rates.xlsx", blobUrl: "https://x.test/rates.xlsx" })).toEqual({
      kind: "other",
      url: "https://x.test/rates.xlsx",
    })
    expect(getPreviewTarget({ name: "data.csv", blobUrl: "https://x.test/data.csv" }).kind).toBe("other")
    expect(getPreviewTarget({ name: "noext", blobUrl: "https://x.test/blob" }).kind).toBe("other")
  })

  it("does not treat a trailing dot as an extension", () => {
    expect(getPreviewTarget({ name: "weird.", blobUrl: "https://x.test/blob" }).kind).toBe("other")
  })
})
