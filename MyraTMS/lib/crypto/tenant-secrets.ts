// =============================================================================
// AES-256-GCM encryption for tenant credentials at rest.
//
// Spec: docs/architecture/SECURITY.md §1
// Storage format: base64({nonce}:{ciphertext}:{auth_tag})
// Key source:     MYRA_TENANT_CONFIG_KEY env var (32-byte base64-encoded)
//
// Public API:
//   encrypt(plaintext)   → ciphertext string
//   decrypt(ciphertext)  → plaintext string OR throws CryptoDecryptError
//
// Used by: lib/db/tenant-context.ts (encrypted tenant_config rows).
// =============================================================================

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto"

const ALGORITHM = "aes-256-gcm" as const
const KEY_LENGTH_BYTES = 32 // 256 bits
const NONCE_LENGTH_BYTES = 12 // 96 bits, GCM standard
const AUTH_TAG_LENGTH_BYTES = 16 // 128 bits, GCM default

const ENV_VAR = "MYRA_TENANT_CONFIG_KEY"

/**
 * Thrown by decrypt() when the ciphertext is malformed, tampered with, or
 * decryption fails for any reason. Never expose the inner error to callers.
 */
export class CryptoDecryptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CryptoDecryptError"
  }
}

/**
 * Thrown by both encrypt() and decrypt() when the master key is missing
 * or malformed. Distinct from CryptoDecryptError because it indicates a
 * configuration problem, not a tampering attempt.
 */
export class CryptoKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CryptoKeyError"
  }
}

let cachedKey: Buffer | null = null

function loadKey(): Buffer {
  if (cachedKey) return cachedKey
  const raw = process.env[ENV_VAR]
  if (!raw) {
    throw new CryptoKeyError(`${ENV_VAR} env var is not set`)
  }
  let decoded: Buffer
  try {
    decoded = Buffer.from(raw, "base64")
  } catch {
    throw new CryptoKeyError(`${ENV_VAR} is not valid base64`)
  }
  if (decoded.length !== KEY_LENGTH_BYTES) {
    throw new CryptoKeyError(
      `${ENV_VAR} must decode to ${KEY_LENGTH_BYTES} bytes; got ${decoded.length}`,
    )
  }
  cachedKey = decoded
  return cachedKey
}

/**
 * Test-only: clear the cached key so a different env var value takes effect.
 * Don't call from production code.
 */
export function _resetKeyCacheForTests(): void {
  cachedKey = null
}

/**
 * Encrypt a UTF-8 plaintext string with AES-256-GCM.
 * Returns: base64(nonce):base64(ciphertext):base64(authTag) — three colons
 * delimit the three components, all base64-encoded. The whole string is
 * what gets stored in tenant_config.value.
 */
export function encrypt(plaintext: string): string {
  if (typeof plaintext !== "string") {
    throw new TypeError("encrypt: plaintext must be a string")
  }
  const key = loadKey()
  const nonce = randomBytes(NONCE_LENGTH_BYTES)
  const cipher: CipherGCM = createCipheriv(ALGORITHM, key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${nonce.toString("base64")}:${ciphertext.toString("base64")}:${authTag.toString("base64")}`
}

/**
 * Decrypt a ciphertext produced by encrypt().
 * Throws CryptoDecryptError on tamper, wrong key, or malformed input.
 */
export function decrypt(ciphertext: string): string {
  if (typeof ciphertext !== "string") {
    throw new CryptoDecryptError("decrypt: ciphertext must be a string")
  }
  const parts = ciphertext.split(":")
  if (parts.length !== 3) {
    throw new CryptoDecryptError(
      `decrypt: malformed ciphertext (expected 3 colon-separated parts, got ${parts.length})`,
    )
  }
  const [nonceB64, ctB64, tagB64] = parts
  let nonce: Buffer
  let ct: Buffer
  let tag: Buffer
  try {
    nonce = Buffer.from(nonceB64, "base64")
    ct = Buffer.from(ctB64, "base64")
    tag = Buffer.from(tagB64, "base64")
  } catch {
    throw new CryptoDecryptError("decrypt: base64 decode failed")
  }
  if (nonce.length !== NONCE_LENGTH_BYTES) {
    throw new CryptoDecryptError(
      `decrypt: nonce length ${nonce.length}, expected ${NONCE_LENGTH_BYTES}`,
    )
  }
  if (tag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new CryptoDecryptError(
      `decrypt: auth tag length ${tag.length}, expected ${AUTH_TAG_LENGTH_BYTES}`,
    )
  }
  const key = loadKey()
  const decipher: DecipherGCM = createDecipheriv(ALGORITHM, key, nonce)
  decipher.setAuthTag(tag)
  try {
    const plaintext = Buffer.concat([decipher.update(ct), decipher.final()])
    return plaintext.toString("utf8")
  } catch {
    // Don't leak the inner error — it can reveal whether the auth tag failed
    // vs. some other internal issue. Both are caller-facing "decryption failed."
    throw new CryptoDecryptError("decrypt: authentication failed (tampered or wrong key)")
  }
}

/**
 * Convenience: mask a plaintext credential to its last 4 chars for display.
 * Used by admin UI to confirm a credential exists without showing the value.
 */
export function maskCredential(plaintext: string): string {
  if (!plaintext) return ""
  if (plaintext.length <= 4) return "****"
  return `${"*".repeat(plaintext.length - 4)}${plaintext.slice(-4)}`
}
