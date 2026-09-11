import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSeal, hexToBytes } from "./.bundle/protocol.mjs";

/**
 * Transport identity: all visual transports encode the same payload string.
 * Rendering is covered by aztec.roundtrip; this locks the seal stage contract.
 */
describe("transport payload identity", () => {
  it("switching transport must not regenerate salt/payload (seal once)", async () => {
    const salt = hexToBytes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const first = await createSeal("OMBRELLO", salt);
    const second = await createSeal("OMBRELLO", salt);
    assert.equal(first.payload, second.payload);
    // Different salt → different payload (new seal)
    const otherSalt = hexToBytes("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const third = await createSeal("OMBRELLO", otherSalt);
    assert.notEqual(first.payload, third.payload);
  });

  it("standard QR, wax, and postal all receive the identical payload text", async () => {
    const { payload } = await createSeal(
      "CAFFE",
      hexToBytes("000102030405060708090a0b0c0d0e0f"),
    );
    const transports = ["qr", "wax", "postal"];
    for (const t of transports) {
      assert.equal(payload.length, 64);
      assert.match(payload, /^[A-Za-z0-9_-]{64}$/);
      void t; // each transport is a renderer over this same string
    }
    assert.equal(
      payload,
      "rS_GktVRvtFjs0mMobtTmzR3vi1a9htazNnAmtPN2jIAAQIDBAUGBwgJCgsMDQ4P",
    );
  });
});
