import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createHiddenToken,
  tokenToBits,
  bitsToToken,
  tokenToHex,
  hexToToken,
  HENV_BIT_COUNT,
  HENV_PROTOCOL_ID,
} from "./.bundle/hiddenEnvelopeProtocol.mjs";
import { normalizeWord } from "./.bundle/protocol.mjs";

describe("HENV1 protocol", () => {
  it("uses shared normalization", () => {
    assert.equal(normalizeWord("lettò"), "LETTO");
  });

  it("matches LETTO fixed-salt known vector", async () => {
    const { token, salt8, digest6 } = await createHiddenToken("LETTO", 0x2a);
    assert.equal(salt8, 0x2a);
    assert.equal(tokenToHex(token), "2a60a5363d6eb3");
    assert.equal(Buffer.from(digest6).toString("hex"), "60a5363d6eb3");
    assert.equal(HENV_PROTOCOL_ID, "HENV1");
  });

  it("bit order is MSB-first within each byte (56 bits)", async () => {
    const { token } = await createHiddenToken("LETTO", 0x2a);
    const bits = tokenToBits(token);
    assert.equal(bits.length, HENV_BIT_COUNT);
    assert.equal(
      Array.from(bits).join(""),
      "00101010011000001010010100110110001111010110111010110011",
    );
    assert.deepEqual(Array.from(bitsToToken(bits)), Array.from(token));
  });

  it("hex roundtrip", async () => {
    const { token } = await createHiddenToken("CAFFE", 7);
    const hex = tokenToHex(token);
    assert.equal(hex.length, 14);
    assert.deepEqual(Array.from(hexToToken(hex)), Array.from(token));
  });
});
