import { describe, it, expect } from "vitest"
import {
  tenantBlobKey,
  tenantBlobPrefix,
  tenantBlobKindPrefix,
  parseTenantBlobKey,
} from "@/lib/blob/tenant-paths"

describe("tenantBlobKey — happy path", () => {
  it("builds tenants/{id}/{kind}/{filename}", () => {
    expect(tenantBlobKey(7, "documents", "BOL-LD-001.pdf")).toBe(
      "tenants/7/documents/BOL-LD-001.pdf",
    )
    expect(tenantBlobKey(2, "pods", "POD-LD-099.jpg")).toBe(
      "tenants/2/pods/POD-LD-099.jpg",
    )
    expect(tenantBlobKey(42, "branding", "logo.png")).toBe(
      "tenants/42/branding/logo.png",
    )
  })

  it("sanitizes path traversal in filenames", () => {
    // Slashes → "_", then ".." (>=2 dots) → "_". So `../../etc/passwd`
    // becomes ".._.._etc_passwd" → "____etc_passwd".
    expect(tenantBlobKey(2, "documents", "../../etc/passwd")).toBe(
      "tenants/2/documents/____etc_passwd",
    )
  })

  it("flattens forward slashes in filenames", () => {
    expect(tenantBlobKey(2, "documents", "subdir/file.pdf")).toBe(
      "tenants/2/documents/subdir_file.pdf",
    )
  })

  it("flattens backslashes in filenames (Windows uploads)", () => {
    expect(tenantBlobKey(2, "documents", "C:\\Users\\foo\\file.pdf")).toBe(
      "tenants/2/documents/C:_Users_foo_file.pdf",
    )
  })
})

describe("tenantBlobKey — input validation", () => {
  it("rejects non-positive tenantId", () => {
    expect(() => tenantBlobKey(0, "documents", "f.pdf")).toThrow(/positive integer/)
    expect(() => tenantBlobKey(-1, "documents", "f.pdf")).toThrow(/positive integer/)
  })

  it("rejects non-integer tenantId", () => {
    expect(() => tenantBlobKey(2.5, "documents", "f.pdf")).toThrow(/positive integer/)
    expect(() => tenantBlobKey(NaN, "documents", "f.pdf")).toThrow(/positive integer/)
  })

  it("rejects unknown kind", () => {
    // @ts-expect-error — testing runtime guard against bad kind
    expect(() => tenantBlobKey(2, "secrets", "f.pdf")).toThrow(/unknown kind/)
  })

  it("rejects empty filename after sanitization", () => {
    expect(() => tenantBlobKey(2, "documents", "/")).toThrow(/empty after sanitization/)
    expect(() => tenantBlobKey(2, "documents", "")).toThrow(/empty/)
  })
})

describe("tenantBlobPrefix / tenantBlobKindPrefix", () => {
  it("returns trailing-slash prefix scoped to tenant", () => {
    expect(tenantBlobPrefix(7)).toBe("tenants/7/")
  })

  it("returns kind-scoped prefix", () => {
    expect(tenantBlobKindPrefix(7, "exports")).toBe("tenants/7/exports/")
  })

  it("rejects invalid tenantId", () => {
    expect(() => tenantBlobPrefix(0)).toThrow(/positive integer/)
    expect(() => tenantBlobKindPrefix(0, "documents")).toThrow(/positive integer/)
  })
})

describe("parseTenantBlobKey", () => {
  it("round-trips a key built by tenantBlobKey", () => {
    const key = tenantBlobKey(13, "documents", "report.pdf")
    expect(parseTenantBlobKey(key)).toEqual({
      tenantId: 13,
      kind: "documents",
      filename: "report.pdf",
    })
  })

  it("returns null for legacy flat keys", () => {
    expect(parseTenantBlobKey("documents/legacy-file.pdf")).toBeNull()
    expect(parseTenantBlobKey("myra-tms/load/LD-001/foo.pdf")).toBeNull()
  })

  it("returns null for malformed tenant prefix", () => {
    expect(parseTenantBlobKey("tenants/abc/documents/x.pdf")).toBeNull()
    expect(parseTenantBlobKey("tenants/0/documents/x.pdf")).toBeNull()
  })

  it("returns null for unknown kind", () => {
    expect(parseTenantBlobKey("tenants/7/secrets/x.pdf")).toBeNull()
  })

  it("preserves nested filenames (the sanitizer flattens slashes anyway)", () => {
    // Built keys never have slashes in the filename portion, but parser
    // tolerates them in case of legacy migration tooling.
    expect(parseTenantBlobKey("tenants/7/documents/sub/dir/file.pdf")).toEqual({
      tenantId: 7,
      kind: "documents",
      filename: "sub/dir/file.pdf",
    })
  })
})
