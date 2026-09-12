/**
 * PENV1 parametric still-life: protocol, layout, digital raster loopback.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INDEX_BITS,
  PAYLOAD_BITS,
} from "./.bundle/penvConstants.mjs";
import {
  crc8Index,
  fromGray,
  packPayload,
  toGray,
  unpackPayload,
} from "./.bundle/penvProtocol.mjs";
import {
  geometryToLevels,
  levelsToGeometry,
  levelsToPayload,
  payloadToGeometry,
  payloadToLevels,
} from "./.bundle/penvLayout.mjs";
import {
  PARAMETRIC_WORD_COUNT,
  entryAtIndex,
  indexForSurface,
} from "./.bundle/penvDictionary.mjs";
import { rasterizeGeometry } from "./.bundle/penvRaster.mjs";
import { decodeParametricFrame } from "./.bundle/penvDecode.mjs";

describe("PENV1 protocol", () => {
  it("channel payload is 20 bits and Gray is invertible", () => {
    assert.equal(PAYLOAD_BITS, 20);
    assert.equal(INDEX_BITS, 11);
    for (let n = 0; n < 16; n++) {
      assert.equal(fromGray(toGray(n)), n);
    }
  });

  it("CRC detects single-bit index errors", () => {
    const packed = packPayload(42);
    const ok = unpackPayload(packed);
    assert.equal(ok.ok, true);
    const flipped = packed ^ 1;
    const bad = unpackPayload(flipped);
    assert.equal(bad.ok, false);
    assert.equal(crc8Index(42), unpackPayload(packed).ok ? unpackPayload(packed).crc : -1);
  });

  it("pack/unpack roundtrip for many indices", () => {
    for (const i of [0, 1, 7, 42, 255, 1023, 1222, 2047]) {
      const p = packPayload(i);
      const u = unpackPayload(p);
      assert.equal(u.ok, true);
      if (u.ok) assert.equal(u.index, i);
    }
  });
});

describe("PENV1 dictionary", () => {
  it("indexes LETTO and stays under 2048 concepts", () => {
    assert.ok(PARAMETRIC_WORD_COUNT > 800);
    assert.ok(PARAMETRIC_WORD_COUNT < 2048);
    const idx = indexForSurface("LETTO");
    assert.ok(idx !== null);
    const e = entryAtIndex(idx);
    assert.equal(e?.canonicalWord, "LETTO");
  });

  it("aliases share the canonical index", () => {
    const a = indexForSurface("TV");
    const b = indexForSurface("TELEVISORE");
    if (a === null || b === null) return;
    assert.equal(a, b);
    assert.equal(entryAtIndex(a)?.canonicalWord, "TELEVISORE");
  });
});

describe("PENV1 layout + digital raster loopback", () => {
  it("levels survive geometry quantization at bin centres", () => {
    const payload = packPayload(indexForSurface("LETTO") ?? 0);
    const levels = payloadToLevels(payload);
    const geom = levelsToGeometry(levels);
    const back = geometryToLevels(geom);
    assert.deepEqual(back, levels);
    assert.equal(levelsToPayload(back), payload);
  });

  it("raster of LETTO decodes to LETTO", () => {
    const idx = indexForSurface("LETTO");
    assert.ok(idx !== null);
    const payload = packPayload(idx);
    const geom = payloadToGeometry(payload);
    const buf = rasterizeGeometry(geom);
    const result = decodeParametricFrame(buf.rgba, buf.width, buf.height);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    if (result.ok) {
      assert.equal(result.entry.canonicalWord, "LETTO");
      assert.equal(result.index, idx);
    }
  });

  it("raster loopback for a sample of household words", () => {
    const words = ["LETTO", "FORCHETTA", "TAZZA", "CUSCINO", "LAMPADA", "COLAPASTA"];
    const failed = [];
    for (const w of words) {
      const idx = indexForSurface(w);
      if (idx === null) continue;
      const payload = packPayload(idx);
      const buf = rasterizeGeometry(payloadToGeometry(payload));
      const result = decodeParametricFrame(buf.rgba, buf.width, buf.height);
      if (!result.ok || result.index !== idx) {
        failed.push(`${w}: ${result.ok ? result.index : result.reason}`);
      }
    }
    assert.equal(failed.length, 0, failed.join("; "));
  });

  it("survives small-in-frame + mild white-balance (camera-like)", () => {
    const idx = indexForSurface("LETTO");
    assert.ok(idx !== null);
    const full = rasterizeGeometry(payloadToGeometry(packPayload(idx)));
    const dw = 640;
    const dh = 427;
    const scale = 0.42;
    const rgba = new Uint8ClampedArray(dw * dh * 4);
    for (let i = 0; i < dw * dh; i++) {
      const o = i * 4;
      rgba[o] = 28;
      rgba[o + 1] = 30;
      rgba[o + 2] = 34;
      rgba[o + 3] = 255;
    }
    const tw = Math.round(full.width * scale);
    const th = Math.round(full.height * scale);
    const ox = Math.round((dw - tw) / 2);
    const oy = Math.round((dh - th) / 2);
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const sx = Math.min(full.width - 1, Math.floor((x * full.width) / tw));
        const sy = Math.min(full.height - 1, Math.floor((y * full.height) / th));
        const si = (sy * full.width + sx) * 4;
        const di = ((oy + y) * dw + ox + x) * 4;
        rgba[di] = Math.min(255, (full.rgba[si] * 1.08 + 8) | 0);
        rgba[di + 1] = Math.min(255, (full.rgba[si + 1] * 1.05 + 6) | 0);
        rgba[di + 2] = Math.min(255, (full.rgba[si + 2] * 0.95 + 4) | 0);
        rgba[di + 3] = 255;
      }
    }
    const result = decodeParametricFrame(rgba, dw, dh);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    if (result.ok) assert.equal(result.index, idx);
  });
});
