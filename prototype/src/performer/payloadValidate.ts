/** Strict Protocol v1 payload validation for paste and optical paths. */

export const PAYLOAD_CHARS = 64;
export const PAYLOAD_BYTES = 48;
export const PAYLOAD_RE = /^[A-Za-z0-9_-]{64}$/;

export type PayloadValidationOk = { ok: true; payload: string };
export type PayloadValidationErr = {
  ok: false;
  code:
    | "EMPTY_INPUT"
    | "INVALID_LENGTH"
    | "INVALID_CHARSET"
    | "DECODE_FAILED"
    | "INVALID_PAYLOAD_SIZE";
  message: string;
};
export type PayloadValidation = PayloadValidationOk | PayloadValidationErr;

function b64UrlDecode(text: string): Uint8Array | null {
  const pad = "=".repeat((4 - (text.length % 4)) % 4);
  const b64 = (text + pad).replace(/-/g, "+").replace(/_/g, "/");
  try {
    if (typeof atob === "function") {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return Uint8Array.from(Buffer.from(b64, "base64"));
  } catch {
    return null;
  }
}

/**
 * Validate optical/pasted payload text.
 * Trims surrounding whitespace only; case-sensitive otherwise.
 */
export function validatePayloadText(text: string | null | undefined): PayloadValidation {
  if (text == null || !String(text).trim()) {
    return { ok: false, code: "EMPTY_INPUT", message: "Payload is required." };
  }
  const stripped = String(text).trim();
  if (stripped.length !== PAYLOAD_CHARS) {
    return {
      ok: false,
      code: "INVALID_LENGTH",
      message: `Payload must be exactly ${PAYLOAD_CHARS} characters.`,
    };
  }
  if (!PAYLOAD_RE.test(stripped)) {
    return {
      ok: false,
      code: "INVALID_CHARSET",
      message: "Payload must match Base64URL alphabet without padding.",
    };
  }
  const raw = b64UrlDecode(stripped);
  if (!raw) {
    return { ok: false, code: "DECODE_FAILED", message: "Base64URL decoding failed." };
  }
  if (raw.length !== PAYLOAD_BYTES) {
    return {
      ok: false,
      code: "INVALID_PAYLOAD_SIZE",
      message: `Decoded payload must be exactly ${PAYLOAD_BYTES} bytes.`,
    };
  }
  return { ok: true, payload: stripped };
}
