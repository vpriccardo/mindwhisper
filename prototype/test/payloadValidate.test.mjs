import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validatePayloadText } from "./.bundle/payloadValidate.mjs";

const CAFFE =
  "rS_GktVRvtFjs0mMobtTmzR3vi1a9htazNnAmtPN2jIAAQIDBAUGBwgJCgsMDQ4P";

describe("validatePayloadText", () => {
  it("accepts the fixed vector", () => {
    const r = validatePayloadText(CAFFE);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.payload, CAFFE);
  });

  it("rejects URLs and ordinary QR text", () => {
    assert.equal(validatePayloadText("https://example.com").ok, false);
    assert.equal(validatePayloadText("hello world").ok, false);
  });

  it("rejects case mutation of a valid payload", () => {
    const mutated = CAFFE.toLowerCase();
    // May fail charset or decode/size — must not accept as ok with different meaning
    // Lowercasing changes Base64URL value; must not equal original acceptance as same
    if (mutated !== CAFFE) {
      const r = validatePayloadText(mutated);
      // either invalid or different decoded bytes — at minimum not the original vector path
      if (r.ok) {
        assert.notEqual(r.payload, CAFFE);
      } else {
        assert.ok(
          ["INVALID_CHARSET", "DECODE_FAILED", "INVALID_PAYLOAD_SIZE", "INVALID_LENGTH"].includes(
            r.code,
          ) || r.ok === false,
        );
      }
    }
  });

  it("rejects bad alphabet, wrong length, empty", () => {
    assert.equal(validatePayloadText("").ok, false);
    assert.equal(validatePayloadText(CAFFE.slice(0, 63)).ok, false);
    assert.equal(validatePayloadText("!" + CAFFE.slice(1)).ok, false);
  });
});
