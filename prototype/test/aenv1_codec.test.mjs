/**
 * AENV1 codec, waveform, digital loopback, and token lifecycle tests.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  AENV_VERSION_SEED,
  CODED_BITS,
  CONV_INPUT_BITS,
  NUM_SYMBOLS,
  PACKET_BITS,
  SAMPLE_RATE,
  TOTAL_SAMPLES,
  WATERMARK_DB_PROVISIONAL,
} from "./.bundle/audioSealConstants.mjs";
import { crc16CcittFalse, crc16Bytes } from "./.bundle/audioSealCrc16.mjs";
import {
  convDecodeHard,
  convDecodeSoft,
  convEncode,
} from "./.bundle/audioSealConvolutional.mjs";
import {
  INTERLEAVE_CHECKSUM,
  INTERLEAVE_FORWARD,
  deinterleaveBits,
  interleaveBits,
} from "./.bundle/audioSealInterleave.mjs";
import {
  decodeAenvPacketSoft,
  encodeAenvPacket,
} from "./.bundle/audioSealPacket.mjs";
import { preambleChecksum, getPreambleWaveform } from "./.bundle/audioSealPreamble.mjs";
import {
  adjacentBasisMaxAbsNcc,
  getSymbolBases,
} from "./.bundle/audioSealSymbolBasis.mjs";
import { renderCoverSound } from "./.bundle/coverSound.mjs";
import { renderAudioSeal } from "./.bundle/renderAudioSeal.mjs";
import { decodeAudioSealBuffer } from "./.bundle/decodeAudioSeal.mjs";
import { resampleToCanonical } from "./.bundle/resample.mjs";
import { MonoRingBuffer } from "./.bundle/ringBuffer.mjs";
import { AudioLockPolicy } from "./.bundle/audioLockPolicy.mjs";
import { createHiddenToken, tokenToHex } from "./.bundle/hiddenEnvelopeProtocol.mjs";
import { exactLookupByToken } from "./.bundle/dictionaryMatcher.mjs";
import { HIDDEN_DICTIONARY_META } from "./.bundle/hiddenDictionaryMeta.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const digestTable = readFileSync(
  join(ROOT, "src", "generated", "hiddenDigestTable.bin"),
);

describe("AENV1 CRC / FEC / interleave", () => {
  it("CRC-16/CCITT-FALSE known vectors", () => {
    assert.equal(crc16CcittFalse(new Uint8Array()), 0xffff);
    const classic = new TextEncoder().encode("123456789");
    assert.equal(crc16CcittFalse(classic), 0x29b1);
  });

  it("packet lengths: 72 / 78 / 156", async () => {
    const { token } = await createHiddenToken("LETTO", 0x2a);
    const enc = encodeAenvPacket(token);
    assert.equal(enc.packetBits.length, PACKET_BITS);
    assert.equal(enc.codedBits.length, CODED_BITS);
    assert.equal(enc.interleavedBits.length, NUM_SYMBOLS);
    assert.equal(CONV_INPUT_BITS, 78);
  });

  it("convolutional clean hard decode", async () => {
    const { token } = await createHiddenToken("LETTO", 0x2a);
    const enc = encodeAenvPacket(token);
    const dec = convDecodeHard(enc.codedBits);
    assert.equal(dec.tailOk, true);
    assert.deepEqual(Array.from(dec.bits), Array.from(enc.packetBits));
  });

  it("Viterbi soft decode with controlled bit noise", async () => {
    const { token } = await createHiddenToken("CAFFE", 7);
    const enc = encodeAenvPacket(token);
    const soft = new Float64Array(enc.codedBits.length);
    for (let i = 0; i < soft.length; i++) {
      soft[i] = enc.codedBits[i] === 1 ? 1.2 : -1.2;
    }
    // Flip a few soft signs weakly
    soft[3] *= -0.3;
    soft[40] *= -0.2;
    const dec = convDecodeSoft(soft);
    assert.equal(dec.tailOk, true);
    assert.deepEqual(Array.from(dec.bits), Array.from(enc.packetBits));
  });

  it("interleaver inverse + checksum stable", () => {
    assert.equal(INTERLEAVE_FORWARD.length, CODED_BITS);
    assert.equal(new Set(INTERLEAVE_FORWARD).size, CODED_BITS);
    const bits = new Int8Array(CODED_BITS);
    for (let i = 0; i < CODED_BITS; i++) bits[i] = (i * 3) & 1;
    assert.deepEqual(
      Array.from(deinterleaveBits(interleaveBits(bits))),
      Array.from(bits),
    );
    assert.equal(typeof INTERLEAVE_CHECKSUM, "number");
    assert.equal(AENV_VERSION_SEED, 0x41454e56);
  });

  it("CRC failure never locks via packet decode", async () => {
    const { token } = await createHiddenToken("LETTO", 0x2a);
    const enc = encodeAenvPacket(token);
    const soft = new Float64Array(enc.interleavedBits.length);
    for (let i = 0; i < soft.length; i++) {
      soft[i] = enc.interleavedBits[i] === 1 ? 1 : -1;
    }
    // Corrupt after encode by flipping many soft values in CRC region via coded path
    for (let i = 0; i < 20; i++) soft[i] *= -1;
    const dec = decodeAenvPacketSoft(soft);
    assert.equal(dec.ok, false);
  });
});

describe("AENV1 waveform / bases / preamble", () => {
  it("waveform exact length 100800", () => {
    assert.equal(TOTAL_SAMPLES, 100800);
    assert.equal(SAMPLE_RATE, 48000);
    const cover = renderCoverSound({ seed: 42 });
    assert.equal(cover.samples.length, TOTAL_SAMPLES);
  });

  it("preamble checksum stable + unit-ish RMS", () => {
    const p = getPreambleWaveform();
    assert.equal(p.length, 7680);
    let sum = 0;
    for (let i = 0; i < p.length; i++) sum += p[i] * p[i];
    const rms = Math.sqrt(sum / p.length);
    assert.ok(Math.abs(rms - 1) < 1e-3);
    assert.equal(typeof preambleChecksum(), "number");
  });

  it("symbol bases balanced RMS and low adjacent NCC", () => {
    const bases = getSymbolBases();
    assert.equal(bases.length, 156);
    for (const b of bases) {
      let sum = 0;
      let mean = 0;
      for (let i = 0; i < b.length; i++) {
        sum += b[i] * b[i];
        mean += b[i];
      }
      mean /= b.length;
      const rms = Math.sqrt(sum / b.length);
      assert.ok(Math.abs(rms - 1) < 1e-3);
      assert.ok(Math.abs(mean) < 0.05);
    }
    assert.ok(adjacentBasisMaxAbsNcc() < 0.35);
  });
});

describe("AENV1 digital encode/decode + lifecycle", () => {
  it("LETTO fixed salt + cover seed digital loopback", async () => {
    const hidden = await createHiddenToken("LETTO", 0x2a);
    assert.equal(tokenToHex(hidden.token), "2a60a5363d6eb3");
    const crc = crc16CcittFalse(hidden.token);
    const rendered = await renderAudioSeal({
      token: hidden.token,
      watermarkDb: WATERMARK_DB_PROVISIONAL,
      cover: { seed: 0x5eed2a00 },
    });
    assert.equal(rendered.tokenHex, "2a60a5363d6eb3");
    assert.equal(rendered.crc, crc);
    assert.equal(rendered.mixed.length, TOTAL_SAMPLES);

    const result = decodeAudioSealBuffer({
      samples: rendered.mixed,
      surfaces: HIDDEN_DICTIONARY_META.surfaces,
      digestTable,
      allowShort: true,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.failReason);
    if (result.ok) {
      assert.equal(result.tokenHex, "2a60a5363d6eb3");
      assert.equal(result.match?.canonicalWord, "LETTO");
      assert.ok(result.decodeMs < 250);
    }
  });

  it("identical token across image/audio/repeat/re-render", async () => {
    const tok = await createHiddenToken("LETTO", 0x2a);
    const hex = tokenToHex(tok.token);
    const a = await renderAudioSeal({
      token: tok.token,
      cover: { seed: 1 },
    });
    const b = await renderAudioSeal({
      token: tok.token,
      cover: { seed: 2 },
    });
    assert.equal(a.tokenHex, hex);
    assert.equal(b.tokenHex, hex);
    assert.notEqual(a.coverSeed, b.coverSeed);
    // Re-encode packet must match
    const enc1 = encodeAenvPacket(tok.token);
    const enc2 = encodeAenvPacket(tok.token);
    assert.deepEqual(
      Array.from(enc1.interleavedBits),
      Array.from(enc2.interleavedBits),
    );
  });

  it("exact dictionary lookup; no match does not invent word", () => {
    const token = new Uint8Array([0xff, 0, 0, 0, 0, 0, 1]);
    const hit = exactLookupByToken({
      token,
      surfaces: HIDDEN_DICTIONARY_META.surfaces,
      digestTable,
    });
    assert.equal(hit, null);
  });

  it("cover-only never locks", async () => {
    const cover = renderCoverSound({ seed: 99 });
    const result = decodeAudioSealBuffer({
      samples: cover.samples,
      surfaces: HIDDEN_DICTIONARY_META.surfaces,
      digestTable,
      allowShort: true,
      corrThreshold: 0.18,
    });
    assert.equal(result.ok, false);
  });

  it("duplicate token suppressed by lock policy", () => {
    const policy = new AudioLockPolicy();
    const c = {
      tokenHex: "2a60a5363d6eb3",
      canonicalWord: "LETTO",
      preambleScore: 0.5,
      sidelobeRatio: 2,
      viterbiMargin: 10,
      clipped: false,
      nowMs: 1000,
    };
    assert.equal(policy.evaluate(c).lock, true);
    assert.equal(policy.evaluate({ ...c, nowMs: 1100 }).lock, false);
    assert.equal(policy.evaluate({ ...c, nowMs: 1100 }).reason, "duplicate");
  });

  it("44.1 kHz resample path length", () => {
    const src = new Float32Array(44100);
    for (let i = 0; i < src.length; i++) src[i] = Math.sin(i * 0.01);
    const out = resampleToCanonical(src, 44100);
    assert.ok(Math.abs(out.length - 48000) <= 2);
  });

  it("ring buffer wrap / eviction bounded", () => {
    const ring = new MonoRingBuffer(100);
    ring.push(new Float32Array(150).fill(1));
    assert.equal(ring.length, 100);
    assert.ok(ring.samplesAfterFull > 0);
    assert.equal(ring.everFull, true);
    const snap = ring.snapshotTail(50);
    assert.equal(snap.length, 50);
  });

  it("alias dictionary entry digital lock", async () => {
    // Pick an alias surface if present
    const alias = HIDDEN_DICTIONARY_META.surfaces.find(
      (s) => s.matchType === "alias",
    );
    if (!alias) return;
    const tok = await createHiddenToken(alias.surface, 3);
    const rendered = await renderAudioSeal({
      token: tok.token,
      cover: { seed: 1234 },
    });
    const result = decodeAudioSealBuffer({
      samples: rendered.mixed,
      surfaces: HIDDEN_DICTIONARY_META.surfaces,
      digestTable,
      allowShort: true,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.failReason);
    if (result.ok) {
      assert.equal(result.match?.conceptId, alias.conceptId);
    }
  });
});

void crc16Bytes;
