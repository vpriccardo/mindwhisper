# Cursor prompt — surgical repair of the current Hidden Envelope prototype

Copy the following prompt into Cursor Agent mode from the repository root:

---

You are repairing the existing Hidden Envelope implementation in:

`/Users/riccardo/projects/intuizione/prototype`

Do not redesign the product, replace the carrier, rewrite the protocol, or remove the existing QR/Aztec/manual-paste paths. Make a focused repair of the current implementation. The current symptoms are:

- envelope detection is slow or never completes;
- reading never reaches a successful decode;
- the performer UI gives too little information to distinguish detection, alignment, extraction, and dictionary failures.

Do not declare success based on the perfect digital round-trip tests. The target is a measurable improvement in the real camera path.

## Preserve these parts

Keep unchanged unless a compatibility fix is necessary:

- Protocol v1 in `src/spectator/protocol.ts` and `protocol.py`;
- HENV1 token format (`salt8 || SHA256(salt8 || normalizedWord)[0:6]`);
- current dictionary source and generated dictionary metadata;
- Standard QR, Wax seal, Postal mark, manual paste, generation IDs, and duplicate suppression;
- the exact carrier asset, mask, and basis checksums;
- the current normal spectator appearance: a plain realistic envelope with no visible code.

The current generated manifest has `alpha=1.75` and `alphaProvisional=true`. Do not silently change it while repairing the pipeline. A stronger signal may be used only through the explicit development-only signal override described below.

## First create a failure report

Before editing, inspect and run the current implementation. Record:

1. `npm test` result, noting that the existing synthetic harness may be very slow;
2. current manifest alpha and lock thresholds;
3. whether OpenCV actually loads inside the worker;
4. the current time spent in capture, alignment, extraction, matching, and total frame processing.

Do not hide errors with empty catches. Every previously swallowed error in the Hidden Envelope worker must be surfaced through a debug diagnostic and, for initialization failures, through the visible camera error area.

## Repair 1: camera capture and back-pressure

Modify `src/performer/watermark/hiddenScanner.ts`.

The current code calls `createImageBitmap(options.video)` at full camera resolution every 70 ms. Replace this with a single reusable capture canvas whose long edge is at most 640 pixels (preserve the video aspect ratio). Draw the video into that canvas and create an `ImageBitmap` from the reduced canvas.

Implement strict back-pressure:

- at most one capture may be in progress;
- at most one bitmap may be in the worker;
- do not create frames while the previous frame has not produced a worker result;
- release every bitmap on all success, failure, stop, and generation-change paths;
- count skipped frames separately from worker-dropped frames.

Keep the target analysis rate at 10–12 fps initially. Do not try to compensate for a slow worker by creating more asynchronous promises.

Add worker result acknowledgements if needed so the main thread knows when it may submit the next bitmap. The main thread must not queue an unbounded stream of `ImageBitmap` objects.

Add debug fields:

- source video width/height;
- worker bitmap width/height;
- capture time;
- frames submitted, skipped, and dropped;
- current in-flight count.

## Repair 2: OpenCV loading must be explicit

Modify `src/performer/watermark/hiddenEnvelopeWorker.ts` and `templateAlign.ts`.

`loadCv()` currently catches all errors and returns null. This can silently switch the live pipeline to the very slow JavaScript NCC fallback. Change it as follows:

- load the local bundled OpenCV asset only;
- await its `then`/runtime initialization if it is promise-like;
- verify that `cv.Mat`, `cv.ORB`, `cv.findHomography`, `cv.warpPerspective`, and `cv.findTransformECC` exist;
- if any check fails, send `ready: false` with a precise error such as `OpenCV unavailable: missing cv.warpPerspective`;
- never start Hidden Envelope scanning without a verified OpenCV runtime.

The pure-JavaScript `alignIdentityOrNcc()` path may remain for isolated unit tests, but it must never be used by the live camera path. In live mode, return a fast failure reason `opencv_unavailable`, not a brute-force scan.

## Repair 3: do not run ORB on every frame

Modify `templateAlign.ts` and the worker state.

Create two explicit alignment states:

### Searching

- run ORB/template detection at most once every 350–500 ms;
- use the already downscaled 640-pixel frame;
- precompute reference grayscale/keypoints/descriptors once during worker initialization;
- use no more than 500 ORB features while searching;
- reject using cheap checks before homography: enough keypoints, match count, projected area, convexity, and inlier ratio;
- record the exact rejection reason.

### Tracking

After one valid homography exists:

- do not rerun full ORB on every frame;
- track the previous carrier region with `cv.findTransformECC` on a small luminance image or Lucas–Kanade optical flow;
- run the expensive ORB search only when tracking fails or the tracked quality falls below threshold;
- cap tracking iterations and return quickly on failure;
- reset to Searching after 300–400 ms without a valid track.

Do not process a new frame with both full ORB and full ECC. The worker must have one bounded alignment path per frame.

## Repair 4: use the actual projective homography

This is mandatory.

The current code estimates a homography with OpenCV, inverts it, converts it to four corner points, and then calls a custom bilinear quad warp. A bilinear interpolation of four corners is not a perspective homography and introduces sub-pixel geometric errors that destroy a weak watermark.

Change the alignment result to retain the actual transform. Either:

1. adjust the estimated OpenCV homography from the 640-pixel search coordinates back to full captured-frame coordinates and call `cv.warpPerspective` directly; or
2. construct a `cv.getPerspectiveTransform()` from the full-frame quadrilateral to the canonical carrier rectangle and call `cv.warpPerspective`.

The output must be exactly `768 × 512`. Use linear interpolation for the first pass and a documented border mode. Produce a valid-pixel mask from the projected carrier polygon; never let black border pixels participate in watermark correlation.

After projective warping, perform a bounded luminance-only ECC refinement against the clean carrier. Keep this refinement separate from chroma extraction. Do not use the watermark chroma to align itself.

Add a unit test with a known keystone transform proving that the repaired path produces substantially lower clean-reference alignment error than the old bilinear warp. Keep the old bilinear function only for test comparison or remove it if nothing else uses it.

## Repair 5: make signal failure observable

Modify `extractSoftBits.ts`, `dictionaryMatcher.ts`, the worker types, and debug UI.

For every accepted frame report:

- valid carrier coverage;
- affine chroma scale/bias;
- residual chroma RMS;
- per-bit soft values and average absolute soft value;
- best candidate score;
- second candidate score;
- score margin;
- top salt hypothesis and its margin over the next salt;
- estimated hard bit errors;
- time spent in extraction and matching.

Do not call the value `confidence` if it is only an uncalibrated score. Label it `soft score` until calibration is performed.

Increase the retained salt hypotheses from 8 to 32 temporarily. Benchmark the matcher; if it exceeds 20 ms p95, precompute candidate codeword signs in a compact typed-array table rather than returning to only eight salts. The true salt must not be discarded because one or two of its first eight bits were damaged by the camera.

When there is no valid candidate, return an explicit `no_dictionary_candidate` result. When the best and second candidate are too close, return `ambiguous_candidate`; never force a word.

## Repair 6: fix the evidence accumulator semantics

Review `frameAccumulator.ts`.

The accumulator currently sums weighted soft scores but does not normalize them. This is acceptable only if every threshold is explicitly calibrated against the number and quality of frames. Make the behavior explicit:

- either normalize accumulated soft values by total weight and calibrate thresholds in the normalized domain;
- or keep sums but expose total weight and calibrate absolute score/margin thresholds using the same frame count range.

Use the first option unless it materially harms decoding. Keep the near-identical-frame de-weighting, but report the effective independent-frame count. Do not let ten nearly identical frames masquerade as ten independent observations.

Add tests for:

- one good frame;
- three independent good frames;
- ten nearly identical frames;
- a sequence where the winner changes;
- track loss resetting evidence.

## Repair 7: development-only signal ladder

Do not change the normal hidden-envelope rendering silently.

Add a spectator-only development query parameter:

`?debug=1&henvSignal=strong`

When present, multiply the manifest alpha by a clearly labelled development factor (start with `3.0`) and show a warning in the debug panel: `STRONG SIGNAL — not an invisibility test`.

The normal mode uses the manifest alpha unchanged. The performer debug panel must show the detected signal mode if it can be inferred from the page/test setup.

Use this ladder diagnostically:

- if strong mode cannot be detected and decoded, the failure is still in capture/alignment/extraction/matching;
- if strong mode works but normal mode does not, the current invisible watermark is below the physical camera noise floor;
- do not call normal mode reliable merely because strong mode works.

The strong mode must never be enabled by default and must not be described as production-safe.

## Repair 8: improve presentation and acquisition feedback

Keep the envelope visually plain. Do not add a visible finder pattern.

On the performer preview, add a performer-only status line:

- `Searching for envelope`
- `Envelope located — hold briefly`
- `Reading hidden signal`
- `Signal too weak — move closer or improve light`
- `Locked`

In `?debug=1`, draw the detected carrier quadrilateral and show a minimum-size warning when the projected envelope height is below 240 camera pixels. Do not pretend that a 150-pixel envelope can meet the same reliability target.

The normal spectator page should use the largest image area available while preserving aspect ratio. Do not change the image pixels with CSS filters, sharpening, blur, interpolation tricks, or animation.

## Tests that must be added before completion

Add a real pixel-domain test, not only a soft-score test:

1. encode a known word;
2. resize the encoded carrier down to a small display size;
3. resize it back up with interpolation;
4. apply brightness, contrast, chroma shift, blur, noise, rotation, and a perspective transform;
5. run the repaired projective rectification and extractor;
6. perform dictionary matching and lock-policy evaluation.

Use fixed seeds and record correct lock, no-lock, and wrong-lock counts. The existing 1,000-trial soft-bit test must not be presented as camera validation.

Add performance tests or debug logs proving:

- capture bitmap long edge ≤640;
- no more than one in-flight frame;
- search ORB is not called on every frame;
- tracking is used between searches;
- live alignment does not call JavaScript NCC;
- worker frame processing has bounded duration;
- all OpenCV Mats and ImageBitmaps are released.

Run:

```sh
cd /Users/riccardo/projects/intuizione/prototype
npm run build
npm test
```

If a test is too slow to complete, fix the test harness or split it into a bounded calibration command. Do not leave a test that runs indefinitely.

## Completion report requirements

At the end, report:

1. files changed;
2. whether OpenCV loaded in the worker;
3. median/p95 capture, alignment, extraction, matching, and total frame times;
4. searching versus tracking frame counts;
5. strong-signal pixel-domain results;
6. normal-signal pixel-domain results;
7. correct locks, no-locks, and wrong locks;
8. whether any failures remain specifically in detection, alignment, extraction, or dictionary matching.

Do not say “fixed” unless the measurements support it. If strong mode succeeds but normal mode does not, state plainly that the hidden signal is below the physical camera noise floor and leave normal mode marked experimental.

---

