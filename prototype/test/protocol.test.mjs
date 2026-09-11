import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSeal,
  hexToBytes,
  normalizeWord,
  toHex,
  PAYLOAD_CHARS,
  PAYLOAD_BYTES,
} from "./.bundle/protocol.mjs";

describe("normalizeWord", () => {
  it("trims, strips accents, uppercases, keeps A-Z", () => {
    assert.equal(normalizeWord(" ombrello "), "OMBRELLO");
    assert.equal(normalizeWord("caffè"), "CAFFE");
    assert.equal(normalizeWord("TV"), "TV");
  });

  it("removes punctuation and whitespace like Python", () => {
    assert.equal(normalizeWord("  caffè! "), "CAFFE");
    assert.equal(normalizeWord("cola-pasta"), "COLAPASTA");
    assert.equal(normalizeWord("hello world"), "HELLOWORLD");
  });

  it("rejects empty normalized input", () => {
    assert.equal(normalizeWord(""), "");
    assert.equal(normalizeWord("   "), "");
    assert.equal(normalizeWord("!!!"), "");
    assert.equal(normalizeWord("123"), "");
  });
});

describe("createSeal", () => {
  const CAFFE_SALT = hexToBytes("000102030405060708090a0b0c0d0e0f");
  const CAFFE_DIGEST =
    "ad2fc692d551bed163b3498ca1bb539b3477be2d5af61b5accd9c09ad3cdda32";
  const CAFFE_PAYLOAD =
    "rS_GktVRvtFjs0mMobtTmzR3vi1a9htazNnAmtPN2jIAAQIDBAUGBwgJCgsMDQ4P";

  it("matches the fixed CAFFE cross-language vector", async () => {
    const { payload, digest, salt } = await createSeal("CAFFE", CAFFE_SALT);
    assert.equal(toHex(digest), CAFFE_DIGEST);
    assert.equal(toHex(salt), "000102030405060708090a0b0c0d0e0f");
    assert.equal(payload, CAFFE_PAYLOAD);
    assert.equal(payload.length, PAYLOAD_CHARS);
  });

  it("always yields 64 Base64URL chars and 48 decoded bytes", async () => {
    const { payload, digest, salt } = await createSeal("OMBRELLO");
    assert.equal(payload.length, PAYLOAD_CHARS);
    assert.match(payload, /^[A-Za-z0-9_-]{64}$/);
    assert.equal(digest.length, 32);
    assert.equal(salt.length, 16);
    assert.equal(digest.length + salt.length, PAYLOAD_BYTES);
  });

  it("produces different payloads for different salts", async () => {
    const a = await createSeal("OMBRELLO");
    const b = await createSeal("OMBRELLO");
    assert.notEqual(a.payload, b.payload);
  });

  it("rejects empty normalized word", async () => {
    await assert.rejects(() => createSeal(""), /empty/i);
  });
});
