import { describe, it, expect } from "vitest"
// @ts-expect-error -- internal Next build helper, no type declarations shipped
import { getMiddlewareMatchers } from "next/dist/build/analysis/get-page-static-info.js"
import { config } from "@/middleware"

// ---------------------------------------------------------------------------
// Regression test for the 2026-10-08 middleware bypass.
//
// The matcher in middleware.ts is a path-to-regexp source string, and Next
// compiles it WITHOUT complaining about a malformed pattern. The old value
// compiled to a regex with a literal ")" in it plus a negative lookahead that
// rejected every path, so middleware never ran -- and because middleware is
// the only thing that overwrites the x-myra-tenant-* headers, an anonymous
// request could forge them. There is no build error and no runtime warning for
// this, so the only way to catch it is to compile the real exported matcher
// and assert that real routes match.
// ---------------------------------------------------------------------------

function compile(): RegExp[] {
  const matchers = getMiddlewareMatchers(config.matcher, {}) as Array<{ regexp: string }>
  return matchers.map((m) => new RegExp(m.regexp))
}

function matches(pathname: string): boolean {
  return compile().some((re) => re.test(pathname))
}

// Paths middleware MUST see, or auth/CORS/tenant resolution silently vanish.
const MUST_MATCH = [
  "/",
  "/login",
  "/loads",
  "/loads/LD-ABC123",
  "/shippers",
  "/admin/tenants",
  "/api/loads",
  "/api/loads/LD-ABC123",
  "/api/shippers",
  "/api/admin/tenants",
  "/api/auth/me",
  "/api/health",
  "/api/tracking/sometoken",
]

// Dotless stand-ins for the rating token. Kept because they are the shape a
// reader expects, but see REAL_SHAPED_TOKENS_SKIPPED below -- the real tokens
// never look like this.
const MUST_MATCH_DOTLESS_RATE = ["/rate/sometoken", "/api/rate/sometoken"]

// Static assets middleware should skip, to avoid an Edge invocation per file.
const MUST_SKIP = [
  "/_next/static/chunks/main.js",
  "/_next/image",
  "/favicon.ico",
  "/logo.png",
  "/manifest.json",
  "/sw.js",
]

describe("middleware matcher", () => {
  it("compiles to at least one usable regex", () => {
    const res = compile()
    expect(res.length).toBeGreaterThan(0)
  })

  it("does not emit a literal escaped paren (the original bug artifact)", () => {
    // The old pattern compiled to a regex containing ")\\)", i.e. it demanded a
    // literal ")" at the end of the path. Build the needle from a char code so
    // no string-escape layer can quietly change what we are searching for.
    const needle = ")" + String.fromCharCode(92) + ")"
    for (const re of compile()) {
      expect(re.source.includes(needle)).toBe(false)
    }
  })

  it.each([...MUST_MATCH, ...MUST_MATCH_DOTLESS_RATE])("runs middleware for %s", (p) => {
    expect(matches(p)).toBe(true)
  })

  it.each(MUST_SKIP)("skips middleware for %s", (p) => {
    expect(matches(p)).toBe(false)
  })

  it("matches every app route in one go (guards against a match-nothing pattern)", () => {
    const matched = MUST_MATCH.filter(matches)
    expect(matched).toEqual(MUST_MATCH)
  })

  // -------------------------------------------------------------------------
  // Known and ACCEPTED matcher gap, recorded so nobody reads
  // MUST_MATCH_DOTLESS_RATE as proof that rating URLs reach middleware.
  //
  // The matcher excludes any path containing a dot (to skip file requests),
  // but a real rating token is `base64url(payload) + "." + hmac`
  // (lib/rating-token.ts:19) -- it ALWAYS contains a dot. So every real
  // /rate/<token> and /api/rate/<token> request SKIPS middleware entirely.
  //
  // Why that is acceptable today:
  //   1. No auth is lost. Both "/rate/" and "/api/rate/" are in
  //      middleware.ts PUBLIC_PATHS, so middleware would have waved them
  //      through anyway; the credential is the HMAC inside the token, checked
  //      by verifyRatingToken() in the handler.
  //   2. No CORS header is lost. The only caller is same-origin
  //      (app/rate/[token]/rating-form.tsx:29 fetches a relative
  //      `/api/rate/${token}`), so no Access-Control-* response header is
  //      needed.
  //   3. No tenant header is lost. Public paths never get x-myra-tenant-*
  //      injected; /api/rate resolves tenant from the token.
  // If any of those three stops being true -- e.g. the rating page moves to a
  // different origin, or the token format drops the dot -- this gap becomes
  // real and the matcher must grow an explicit allowance.
  // -------------------------------------------------------------------------
  const REAL_SHAPED_TOKENS_SKIPPED = [
    // base64url payload "." base64url hmac, per generateRatingToken()
    "/rate/TEQtQUJDMTIzfFNIUC0xfDE3OTk5OTk5OTk.9xQk7bVnZ2pLm4sT0aWcYhR8dJqO1fE3uIgN5zXvBkA",
    "/api/rate/TEQtQUJDMTIzfFNIUC0xfDE3OTk5OTk5OTk.9xQk7bVnZ2pLm4sT0aWcYhR8dJqO1fE3uIgN5zXvBkA",
  ]

  it.each(REAL_SHAPED_TOKENS_SKIPPED)(
    "skips middleware for %s (dotted token; accepted -- see comment above)",
    (p) => {
      expect(matches(p)).toBe(false)
    },
  )

  it("the dotless stand-ins DO match, which is why they are not evidence", () => {
    // Same routes, dot removed: these match. Asserting both halves keeps the
    // dot -- not the route -- identified as the cause of the skip.
    expect(matches("/rate/TEQtQUJDMTIzfFNIUC0x")).toBe(true)
    expect(matches("/api/rate/TEQtQUJDMTIzfFNIUC0x")).toBe(true)
  })
})
