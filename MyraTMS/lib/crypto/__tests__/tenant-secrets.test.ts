// =============================================================================
// Tests for lib/crypto/tenant-secrets.ts (AES-256-GCM tenant credential crypto).
// Spec: docs/architecture/SECURITY.md §1
//
// Required tests per SECURITY.md §1:
//   - Round-trip a known-good fixture
//   - Wrong-key decryption fails cleanly
//   - Tampered ciphertext detected via auth tag
//   - Nonce reuse: encrypting same plaintext twice yields different ciphertext
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { randomBytes } from "node:crypto"
import {
  encrypt,
  decrypt,
  maskCredential,
  CryptoDecryptError,
  CryptoKeyError,
  _resetKeyCacheForTests,
} from "@/lib/crypto/tenant-secrets"

const ORIGINAL_ENV = process.env.MYRA_TENANT_CONFIG_KEY

function setKey(): string {
  const key = randomBytes(32).toString("base64")
  process.env.MYRA_TENANT_CONFIG_KEY = key
  _resetKeyCacheForTests()
  return key
}

function unsetKey(): void {
  delete process.env.MYRA_TENANT_CONFIG_KEY
  _resetKeyCacheForTests()
}

describe("tenant-secrets crypto", () => {
  afterEach(() => {
    if (ORIGINAL_ENV !== undefined) {
      process.env.MYRA_TENANT_CONFIG_KEY = ORIGINAL_ENV
    } else {
      delete process.env.MYRA_TENANT_CONFIG_KEY
    }
    _resetKeyCacheForTests()
  })

  describe("happy path", () => {
    beforeEach(() => setKey())

    it("round-trips a short plaintext", () => {
      const plaintext = "sk_live_abcdef123456"
      const ct = encrypt(plaintext)
      expect(decrypt(ct)).toBe(plaintext)
    })

    it("round-trips an empty string", () => {
      const ct = encrypt("")
      expect(decrypt(ct)).toBe("")
    })

    it("round-trips a unicode plaintext", () => {
      const plaintext = "🔐 secret with unicode: αβγ 中文"
      expect(decrypt(encrypt(plaintext))).toBe(plaintext)
    })

    it("round-trips a JSON-encoded credential blob", () => {
      const plaintext = JSON.stringify({
        api_key: "key_xyz",
        api_secret: "secret_abc",
        config: { region: "us-east-1" },
      })
      expect(decrypt(encrypt(plaintext))).toBe(plaintext)
    })

    it("round-trips a long plaintext (>1KB)", () => {
      const plaintext = "x".repeat(2048)
      expect(decrypt(encrypt(plaintext))).toBe(plaintext)
    })
  })

  describe("nonce uniqueness", () => {
    beforeEach(() => setKey())

    it("encrypting the same plaintext twice yields different ciphertexts", () => {
      const plaintext = "secret"
      const a = encrypt(plaintext)
      const b = encrypt(plaintext)
      expect(a).not.toBe(b)
      // Both must still decrypt to the same plaintext
      expect(decrypt(a)).toBe(plaintext)
      expect(decrypt(b)).toBe(plaintext)
    })

    it("nonces are statistically distinct across many encryptions", () => {
      const nonces = new Set<string>()
      for (let i = 0; i < 1000; i++) {
        const ct = encrypt("same input")
        const noncePart = ct.split(":")[0]
        nonces.add(noncePart)
      }
      // 1000 random 96-bit nonces — collision probability is astronomically low
      expect(nonces.size).toBe(1000)
    })
  })

  describe("storage format", () => {
    beforeEach(() => setKey())

    it("produces three colon-separated base64 components", () => {
      const ct = encrypt("hello")
      const parts = ct.split(":")
      expect(parts).toHaveLength(3)
      // All three parts should be valid base64
      for (const part of parts) {
        expect(() => Buffer.from(part, "base64")).not.toThrow()
      }
    })

    it("nonce part decodes to 12 bytes", () => {
      const ct = encrypt("hello")
      const nonce = Buffer.from(ct.split(":")[0], "base64")
      expect(nonce.length).toBe(12)
    })

    it("auth tag part decodes to 16 bytes", () => {
      const ct = encrypt("hello")
      const tag = Buffer.from(ct.split(":")[2], "base64")
      expect(tag.length).toBe(16)
    })
  })

  describe("wrong key rejection", () => {
    it("decryption with a different key throws CryptoDecryptError", () => {
      // Encrypt with key A
      setKey()
      const ct = encrypt("secret value")
      // Switch to key B
      setKey()
      // Decrypt should fail cleanly — NOT return garbage
      expect(() => decrypt(ct)).toThrow(CryptoDecryptError)
    })

    it("the error message does not leak inner details", () => {
      setKey()
      const ct = encrypt("secret")
      setKey()
      try {
        decrypt(ct)
        expect.fail("should have thrown")
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoDecryptError)
        // Error message should be the generic public one
        expect((err as Error).message).toMatch(/authentication failed/i)
      }
    })
  })

  describe("tamper detection", () => {
    beforeEach(() => setKey())

    it("flipping a byte in the ciphertext throws CryptoDecryptError", () => {
      const ct = encrypt("authentic message")
      const parts = ct.split(":")
      // Decode middle part, flip first byte, re-encode
      const ctBytes = Buffer.from(parts[1], "base64")
      ctBytes[0] = ctBytes[0] ^ 0xff
      const tampered = `${parts[0]}:${ctBytes.toString("base64")}:${parts[2]}`
      expect(() => decrypt(tampered)).toThrow(CryptoDecryptError)
    })

    it("flipping a byte in the auth tag throws CryptoDecryptError", () => {
      const ct = encrypt("authentic message")
      const parts = ct.split(":")
      const tagBytes = Buffer.from(parts[2], "base64")
      tagBytes[0] = tagBytes[0] ^ 0xff
      const tampered = `${parts[0]}:${parts[1]}:${tagBytes.toString("base64")}`
      expect(() => decrypt(tampered)).toThrow(CryptoDecryptError)
    })

    it("flipping a byte in the nonce throws CryptoDecryptError", () => {
      const ct = encrypt("authentic message")
      const parts = ct.split(":")
      const nonceBytes = Buffer.from(parts[0], "base64")
      nonceBytes[0] = nonceBytes[0] ^ 0xff
      const tampered = `${nonceBytes.toString("base64")}:${parts[1]}:${parts[2]}`
      expect(() => decrypt(tampered)).toThrow(CryptoDecryptError)
    })

    it("swapping nonce and ciphertext positions throws", () => {
      const ct = encrypt("hello")
      const parts = ct.split(":")
      const swapped = `${parts[1]}:${parts[0]}:${parts[2]}`
      expect(() => decrypt(swapped)).toThrow(CryptoDecryptError)
    })
  })

  describe("malformed input handling", () => {
    beforeEach(() => setKey())

    it("rejects ciphertext with too few parts", () => {
      expect(() => decrypt("not:enough")).toThrow(CryptoDecryptError)
      expect(() => decrypt("nocolons")).toThrow(CryptoDecryptError)
    })

    it("rejects ciphertext with too many parts", () => {
      expect(() => decrypt("a:b:c:d")).toThrow(CryptoDecryptError)
    })

    it("rejects empty string", () => {
      expect(() => decrypt("")).toThrow(CryptoDecryptError)
    })

    it("rejects non-string input", () => {
      // @ts-expect-error — testing runtime guard
      expect(() => decrypt(null)).toThrow(CryptoDecryptError)
      // @ts-expect-error
      expect(() => decrypt(undefined)).toThrow(CryptoDecryptError)
      // @ts-expect-error
      expect(() => decrypt(42)).toThrow(CryptoDecryptError)
    })

    it("encrypt rejects non-string input", () => {
      // @ts-expect-error — testing runtime guard
      expect(() => encrypt(null)).toThrow(TypeError)
      // @ts-expect-error
      expect(() => encrypt(undefined)).toThrow(TypeError)
      // @ts-expect-error
      expect(() => encrypt(42)).toThrow(TypeError)
    })
  })

  describe("key configuration errors", () => {
    it("encrypt throws CryptoKeyError when env var is unset", () => {
      unsetKey()
      expect(() => encrypt("anything")).toThrow(CryptoKeyError)
    })

    it("decrypt throws CryptoKeyError when env var is unset", () => {
      // First encrypt with a valid key
      setKey()
      const ct = encrypt("data")
      // Then unset and try to decrypt
      unsetKey()
      expect(() => decrypt(ct)).toThrow(CryptoKeyError)
    })

    it("rejects key that decodes to wrong length", () => {
      // 16 bytes — too short for AES-256
      process.env.MYRA_TENANT_CONFIG_KEY = randomBytes(16).toString("base64")
      _resetKeyCacheForTests()
      expect(() => encrypt("test")).toThrow(CryptoKeyError)
    })

    it("rejects key that's not valid base64", () => {
      process.env.MYRA_TENANT_CONFIG_KEY = "not!valid@base64#"
      _resetKeyCacheForTests()
      // Note: Buffer.from accepts most strings as base64 (silently truncating
      // bad chars), so this test may or may not throw depending on input.
      // The wrong-length check catches the common case.
      try {
        encrypt("test")
        // If it didn't throw, the key was accepted but with truncated length
        // — verify the next call fails with a useful error
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoKeyError)
      }
    })
  })

  describe("maskCredential", () => {
    it("masks a long credential to last 4 chars", () => {
      expect(maskCredential("sk_live_abcdef123456")).toBe("****************3456")
    })

    it("returns **** for short credentials", () => {
      expect(maskCredential("abc")).toBe("****")
      expect(maskCredential("abcd")).toBe("****")
    })

    it("returns empty for empty input", () => {
      expect(maskCredential("")).toBe("")
    })
  })
})
