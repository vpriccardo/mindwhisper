# Cursor prompt: add disguised Aztec transports and continuous camera acquisition

Read `QR_SEAL_PROTOTYPE_PLAN.md` first and treat this document as an additive specification. Implement these features in the existing prototype without changing its normalization, salt, SHA-256, byte packing, Base64URL payload, dictionary loading, or recovery API.

The visual reference is `research/optical-seal-concepts.png`. It is concept art only. Its barcode-like marks are not valid and must never be copied as data cells.

## Outcome

Add two new spectator-side visual transports based on real, standards-compliant **Aztec codes**:

1. **Wax seal** — based on the upper-left concept.
2. **Postal mark** — based on the lower-right concept.

Keep the existing ordinary QR and copyable 64-character payload as the baseline/debug transport. All three options encode exactly the same 64-character payload string.

On the performer side, add a user-authorized webcam stream that continuously searches for QR and Aztec symbols. When it detects a syntactically valid payload, it must lock that payload, start dictionary recovery, ignore repeated frames containing the same payload, and remain active until a different valid payload is detected. A new payload replaces the previous locked result and starts a new recovery.

Use “recover” or “dictionary match” in code and UI rather than “decrypt”; this process is not decryption.

## Critical scope decision

Both artistic options must contain a genuine standard Aztec symbol. Do not implement a custom circular/radial decoder in this iteration.

The postal design may look circular because of artwork surrounding the code, but its machine-readable core remains an undistorted Aztec matrix with an intact central bullseye, data cells, error correction, and clear margin. No decorative cancellation line may cross the protected code area.

## Dependencies

Bundle all dependencies locally through the existing frontend build. Do not use a CDN.

Suggested libraries:

- Aztec generation: `bwip-js` using its `azteccode` encoder, rendered to SVG or canvas.
- Continuous QR/Aztec recognition: `@zxing/browser` and its multi-format or Aztec reader, with the core formats restricted to `BarcodeFormat.QR_CODE` and `BarcodeFormat.AZTEC`.

Pin exact versions in `package-lock.json` and add their licenses and upstream URLs to `prototype/THIRD_PARTY_NOTICES.md`.

If the installed versions expose different APIs, adapt to their documented APIs rather than inventing wrappers around private internals. Before styling anything, prove an unstyled Aztec round trip: generate the fixed payload, render it, decode it from an image/canvas, and assert byte-for-byte text equality.

Do not rely exclusively on the browser's native `BarcodeDetector` API because support is inconsistent. It may be used as an optional fast path only when `BarcodeDetector.getSupportedFormats()` explicitly reports both required formats. ZXing must remain the supported fallback.

## Preserve transport separation

Refactor spectator code, if necessary, into three independent stages:

```text
normalize word
    -> create 64-character commitment payload
    -> render selected visual transport
```

The payload creator must know nothing about QR, Aztec, wax, postmarks, or the performer. Each renderer receives only the completed 64-character payload.

Add a transport selector with:

```text
Standard QR
Wax seal
Postal mark
```

Changing the visual transport after sealing must re-render the existing payload without changing its salt or payload string. Starting a new seal must create a new salt as specified in the original plan.

The exact 64-character payload must remain displayed and copyable under every transport during prototype testing.

## Functional Aztec rendering invariant

Treat the Aztec matrix as protected data geometry:

- generate it deterministically with a standards-compliant encoder;
- use a high error-correction setting supported by the encoder;
- preserve every module's position and dimensions;
- use square modules with no rounded corners inside the data matrix;
- preserve the central bullseye exactly;
- preserve a generous, uniform clear margin around the matrix;
- do not rotate, warp, blur, texture, emboss, shadow, mask, crop, or partially cover the matrix itself;
- do not place translucent decoration over it;
- do not encode the payload in a URL—the Aztec text is exactly the raw 64-character Base64URL string.

Artistic styling must occur around the protected matrix or through two flat module/background colors with strong luminance separation. Decorative CSS must not alter the SVG/canvas pixels used by the decoder.

The symbol should occupy at least `320 x 320` CSS pixels on a normal desktop display and scale responsively to use as much safe space as possible on a phone. It must remain perfectly square.

## Spectator design A: Wax seal

Reproduce the character of the upper-left reference without reproducing its invalid cells:

- ivory closed-envelope background;
- large irregular burgundy wax disc centered over the flap;
- realistic wax edge, subtle highlights, paper shadow, and restrained texture outside the code;
- functional Aztec matrix centered inside the wax;
- dark burgundy modules on a substantially lighter matte-red inner medallion;
- a plain circular or octagonal decorative border outside the Aztec clear margin;
- no gloss, specular highlight, texture, or fake embossing over the machine-readable matrix.

The wax can look dimensional at its perimeter. The encoded center must remain optically flat and high contrast. Reliability is more important than making the code itself appear physically embossed.

## Spectator design B: Postal mark

Reproduce the character of the lower-right reference while protecting the real symbol:

- warm-white envelope or paper background;
- muted red, perforated postage-stamp area;
- functional Aztec matrix centered on the stamp in dark burgundy over pale desaturated red;
- circular postal cancellation rings and a small asymmetric arrow/date-like ornament surrounding the protected Aztec margin;
- distressed ink texture only in the surrounding artwork;
- cancellation lines must stop before the protected matrix and resume on the opposite side, giving the visual impression that they pass behind it;
- no portrait, letters, numbers, country name, price, URL, or readable text.

The surrounding rings provide theatrical camouflage, not machine-readable data. The standard Aztec core is the only encoded element.

## Performer camera UI

Add a camera-acquisition panel to the performer page containing:

- **Start camera** button;
- **Stop camera** button;
- camera-device selector when multiple inputs exist;
- live `<video>` preview;
- scan state indicator;
- last recognized format (`QR_CODE` or `AZTEC`);
- locked payload field;
- acquisition timestamp;
- recovery status and existing timing diagnostics;
- a collapsible debug area for attempt counts and ignored-invalid-code counts.

Camera permission must be requested only after the performer presses **Start camera**. Prefer constraints similar to:

```javascript
{
  audio: false,
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 1280 },
    height: { ideal: 720 }
  }
}
```

On desktop, use the selected webcam. On mobile, prefer the rear camera. Handle permission denial, missing devices, an ended stream, camera-in-use errors, and unsupported insecure origins with clear messages.

Camera acquisition works on HTTPS or localhost/`127.0.0.1`. Document that accessing the performer page through a plain LAN IP may prevent camera access.

Set an appropriate performer response header such as:

```text
Permissions-Policy: camera=(self)
```

Do not request microphone permission.

## Continuous recognition state machine

Implement explicit states rather than scattered booleans:

```text
IDLE
REQUESTING_CAMERA
SCANNING
PAYLOAD_LOCKED
RECOVERING
RECOVERED
RECOVERY_ERROR
CAMERA_ERROR
```

The camera remains active in `PAYLOAD_LOCKED`, `RECOVERING`, `RECOVERED`, and `RECOVERY_ERROR` unless the performer presses **Stop camera**.

Recognition should run continuously but be throttled to a configurable interval near 100 ms rather than decoding every rendered video frame. Do not allow overlapping decode attempts.

For every recognized optical symbol:

1. Read its textual contents.
2. Trim surrounding whitespace only.
3. Validate exactly 64 case-sensitive characters against `^[A-Za-z0-9_-]{64}$`.
4. Base64URL-decode it and confirm exactly 48 bytes.
5. Ignore anything that fails validation. Do not show intrusive errors for ordinary objects or unrelated barcodes in the camera view; increment a debug counter only.
6. If the payload equals the current locked payload, treat it as another frame of the same symbol and do not restart recovery.
7. If it differs from the locked payload, lock it immediately and begin a new call to `POST /api/recover`.

A successful standards-based QR/Aztec decode plus the strict payload validation is sufficient to lock on the first valid frame. Keep an optional development setting that requires two equal detections within 750 ms, but default it to one for quick-glimpse testing.

The visible result must remain locked even after the symbol leaves the camera frame. Absence of a symbol must never clear the result.

## New-payload and concurrency behavior

The application must continue searching after a lock.

Track a monotonically increasing recovery generation number. If a different valid payload is detected while a recovery request is in flight:

- make the new payload the locked payload immediately;
- increment the generation number;
- abort the old request with `AbortController` when practical;
- start recovery for the new payload;
- ignore any stale response whose generation number is no longer current.

Repeated frames of the currently locked payload may update a `lastSeenAt` diagnostic but must not change the acquisition timestamp, flash the UI, or call the recovery API again.

Provide a **Clear locked result** control for rehearsal. Clearing the result must not instantly relock a code that has remained continuously in view. Require either:

- the previous code to be absent for at least 500 ms; or
- a different valid payload to appear.

## Recovery result behavior

On a new locked payload:

1. Immediately show `Payload locked` and its optical format.
2. Show `Recovering…` while the existing API searches the dictionary.
3. On one match, show the matched surface, canonical word, alias/canonical type, and timing diagnostics.
4. On a valid payload with no dictionary match, keep the payload locked and show `No dictionary match`; continue camera scanning.
5. On an ambiguous match, show every result as already specified by the recovery API.
6. On API/network failure, keep the payload locked and show the error; continue camera scanning so a different code can replace it.

Do not treat a successful camera read as a successful word recovery. Report acquisition and dictionary recovery as separate stages and timings.

## Performance requirements

The first implementation should target:

- first valid lock within 500 ms when a clear symbol occupies roughly 300 captured pixels or more;
- continuous scan near 8–10 attempts per second without overlapping work;
- no duplicate API recovery requests for a stationary symbol;
- no false lock from recognized ordinary QR codes containing URLs or arbitrary text;
- immediate replacement when a different valid payload enters view;
- camera cleanup on page unload and when **Stop camera** is pressed by stopping every `MediaStreamTrack`.

Do not hide performance failures. Add development diagnostics for average decode-attempt duration, attempts since start, valid detections, invalid recognized symbols, and last successful acquisition time.

## Automated tests

Add tests for:

- standard QR, wax Aztec, and postal Aztec all contain the identical payload text;
- fixed cross-language payload renders to a real Aztec symbol and decodes back to exactly the original 64 characters;
- switching visual transport does not regenerate the payload or salt;
- both Aztec styles preserve a decodable machine-readable layer before decorative composition;
- strict scanner payload validation rejects URLs, ordinary QR text, incorrect case mutation, bad alphabet, wrong length, and wrong decoded byte length;
- the first valid payload locks and triggers exactly one recovery;
- repeated equal detections do not retrigger recovery;
- a different valid payload replaces the lock and triggers one new recovery;
- stale recovery responses cannot overwrite a newer result;
- no-match and API-error states retain the locked payload;
- stopping the camera stops all stream tracks;
- the original protocol and engine test suites still pass.

Keep camera hardware tests out of the normal automated suite. Mock recognized-symbol events and `MediaStreamTrack` objects for state-machine tests.

## Manual camera test matrix

Add this checklist to the prototype README and record results for all three transports:

1. Display the spectator page full-screen on a phone at normal brightness.
2. Start the performer webcam on a laptop.
3. Bring the symbol into view for less than one second and remove it.
4. Confirm the payload remains locked and recovery completes.
5. Leave the same symbol stationary for ten seconds; confirm there was exactly one API call.
6. Present a new seal; confirm it replaces the previous result.
7. Present an ordinary URL QR code; confirm it is ignored.
8. Repeat at approximately 15° and 30° horizontal tilt.
9. Repeat with moderate glare and screen brightness at 50%.
10. Repeat with the symbol occupying approximately 500, 300, 200, and 150 captured pixels.
11. Record acquisition time, failures, and false locks for standard QR, wax Aztec, and postal Aztec separately.

Do not claim the artistic designs are reliable until this matrix has been run. Standard QR is the baseline; the two disguised Aztec transports succeed only if their measured acquisition remains acceptable.

## Completion criteria

This addendum is complete when:

- the spectator can generate one payload and switch among all three visual transports without changing it;
- the wax and postal options contain real Aztec codes, not AI-generated approximations;
- the performer can start a webcam and continuously recognize both QR and Aztec formats;
- the first valid 64-character/48-byte payload locks and invokes recovery;
- repeated frames never cause repeated recoveries;
- a different valid payload replaces the current result without restarting the camera;
- automated round-trip and scanner state-machine tests pass;
- all existing tests from `QR_SEAL_PROTOTYPE_PLAN.md` continue to pass.

