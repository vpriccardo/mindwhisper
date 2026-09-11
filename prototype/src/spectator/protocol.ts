/** Protocol v1: normalize, salt, SHA-256 commitment, Base64URL payload. */

export const DIGEST_BYTES = 32;
export const SALT_BYTES = 16;
export const PAYLOAD_BYTES = 48;
export const PAYLOAD_CHARS = 64;

const PAYLOAD_RE = /^[A-Za-z0-9_-]{64}$/;

/** Mirror of build_dictionary.normalize_word. */
export function normalizeWord(word: string): string {
  const decomposed = word.trim().normalize("NFKD");
  // Drop combining marks (Python unicodedata.combining(ch))
  const asciiOnly = Array.from(decomposed)
    .filter((ch) => !/\p{M}/u.test(ch))
    .join("");
  return Array.from(asciiOnly.toUpperCase())
    .filter((ch) => ch >= "A" && ch <= "Z")
    .join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const b64 =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function ensureWebCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof globalThis.crypto.getRandomValues !== "function") {
    throw new Error(
      "Web Crypto is unavailable. Open this page on http://127.0.0.1 or https (secure context).",
    );
  }
  return subtle;
}

/**
 * Create a Protocol v1 seal.
 * @param normalized Already-normalized A–Z surface.
 * @param saltOptional Test-only fixed salt. Production UI must omit this.
 */
export async function createSeal(
  normalized: string,
  saltOptional?: Uint8Array,
): Promise<{ payload: string; digest: Uint8Array; salt: Uint8Array }> {
  if (!normalized) {
    throw new Error("Normalized word is empty.");
  }
  const subtle = ensureWebCrypto();

  let salt: Uint8Array;
  if (saltOptional !== undefined) {
    if (saltOptional.length !== SALT_BYTES) {
      throw new Error(`Salt must be exactly ${SALT_BYTES} bytes.`);
    }
    salt = saltOptional;
  } else {
    salt = new Uint8Array(SALT_BYTES);
    crypto.getRandomValues(salt);
  }

  const wordBytes = new TextEncoder().encode(normalized);
  const hashInput = new Uint8Array(salt.length + wordBytes.length);
  hashInput.set(salt, 0);
  hashInput.set(wordBytes, salt.length);

  const digestBuf = await subtle.digest("SHA-256", hashInput);
  const digest = new Uint8Array(digestBuf);

  const payloadBytes = new Uint8Array(PAYLOAD_BYTES);
  payloadBytes.set(digest, 0);
  payloadBytes.set(salt, DIGEST_BYTES);

  const payload = bytesToBase64Url(payloadBytes);
  if (payload.length !== PAYLOAD_CHARS || !PAYLOAD_RE.test(payload)) {
    throw new Error("Internal error: invalid payload encoding.");
  }

  return { payload, digest, salt };
}

/** Hex encode for tests. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
