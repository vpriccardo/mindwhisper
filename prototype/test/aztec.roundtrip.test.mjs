import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";
import {
  AztecCodeReader,
  RGBLuminanceSource,
  BinaryBitmap,
  HybridBinarizer,
} from "@zxing/library";
import bwipjs from "bwip-js";
import { aztecRenderOptions } from "./.bundle/aztecCore.mjs";
import { createSeal, hexToBytes } from "./.bundle/protocol.mjs";

const CAFFE_PAYLOAD =
  "rS_GktVRvtFjs0mMobtTmzR3vi1a9htazNnAmtPN2jIAAQIDBAUGBwgJCgsMDQ4P";

function toLum(rgba, width, height) {
  const lum = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i++) lum[i] = rgba[i * 4];
  return lum;
}

function decodeAztecPng(pngBuf) {
  const png = PNG.sync.read(pngBuf);
  const lum = toLum(png.data, png.width, png.height);
  const reader = new AztecCodeReader();
  return reader
    .decode(
      new BinaryBitmap(
        new HybridBinarizer(new RGBLuminanceSource(lum, png.width, png.height)),
      ),
    )
    .getText();
}

describe("Aztec optical round-trip", () => {
  it("renders fixed CAFFE payload and decodes byte-for-byte", async () => {
    const opts = aztecRenderOptions(CAFFE_PAYLOAD, {
      barcolor: "000000",
      backgroundcolor: "FFFFFF",
    });
    const pngBuf = await bwipjs.toBuffer(opts);
    const decoded = decodeAztecPng(pngBuf);
    assert.equal(decoded, CAFFE_PAYLOAD);
  });

  it("wax and postal flat colors remain decodable", async () => {
    for (const colors of [
      { barcolor: "2A0C12", backgroundcolor: "6A2030" },
      { barcolor: "3A1018", backgroundcolor: "7A2838" },
    ]) {
      const pngBuf = await bwipjs.toBuffer(
        aztecRenderOptions(CAFFE_PAYLOAD, colors, 6, 6),
      );
      assert.equal(decodeAztecPng(pngBuf), CAFFE_PAYLOAD);
    }
  });

  it("fresh seal payload round-trips through Aztec", async () => {
    const salt = hexToBytes("101112131415161718191a1b1c1d1e1f");
    const { payload } = await createSeal("OMBRELLO", salt);
    const pngBuf = await bwipjs.toBuffer(aztecRenderOptions(payload));
    assert.equal(decodeAztecPng(pngBuf), payload);
  });
});
