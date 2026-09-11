# Third-party notices (QR Seal prototype)

This directory bundles third-party software for the local prototype only.

## qrcode

| | |
|---|---|
| Package | `qrcode` |
| Version | 1.5.4 (see `package-lock.json` for the exact resolved version) |
| License | MIT |
| Upstream | https://github.com/soldair/node-qrcode |
| Used by | Spectator page — Standard QR transport from the 64-character payload |

```
The MIT License (MIT)

Copyright (c) 2012 Ryan Day

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## bwip-js

| | |
|---|---|
| Package | `bwip-js` |
| Version | 4.11.4 (see `package-lock.json`) |
| License | MIT |
| Upstream | https://github.com/metafloor/bwip-js |
| Used by | Spectator page — Aztec (`azteccode`) generation for Wax seal and Postal mark transports |

Bundled into the spectator static JS; no CDN. Based on BWIPP (Barcode Writer in Pure PostScript).

## @zxing/browser and @zxing/library

| | |
|---|---|
| Packages | `@zxing/browser`, `@zxing/library` |
| Versions | see `package-lock.json` (browser 0.2.x / library 0.23.x) |
| License | MIT |
| Upstream | https://github.com/zxing-js/browser · https://github.com/zxing-js/library |
| Used by | Performer page — continuous QR_CODE and AZTEC recognition from the webcam |

## pngjs (dev / tests only)

| | |
|---|---|
| Package | `pngjs` |
| License | MIT |
| Upstream | https://github.com/lukeapage/pngjs |
| Used by | Node tests that decode bwip-js PNG output with ZXing |

## esbuild / TypeScript (build-time only)

| Package | License | Upstream |
|---|---|---|
| `esbuild` | MIT | https://github.com/evanw/esbuild |
| `typescript` | Apache-2.0 | https://github.com/microsoft/TypeScript |
| `@types/qrcode` | MIT | DefinitelyTyped |

These are development/build dependencies and are not required at runtime by the served spectator or performer pages.

## OpenCV.js (`@techstark/opencv-js`)

| | |
|---|---|
| Package | `@techstark/opencv-js` |
| Version | 4.10.0-release.1 (see `package-lock.json`) |
| License | Apache-2.0 (OpenCV) |
| Upstream | https://github.com/opencv/opencv / https://github.com/techstark/opencv-js |
| Used by | Performer Hidden-envelope worker — ORB matching, homography, warping |

OpenCV.js/WASM is copied into `dist/performer/assets/opencv/` at build time and
loaded only inside the Web Worker (not from a CDN). Browser-delivered code is
inspectable; the watermark basis key is an implementation detail, not a
cryptographic secret.

## pngjs (build/test)

| Package | License | Upstream |
|---|---|---|
| `pngjs` | MIT | https://github.com/lukeapage/pngjs |

Used at build/test time for carrier preparation and digital round-trip tests.

