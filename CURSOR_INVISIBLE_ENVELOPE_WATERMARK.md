# Cursor implementation prompt — hidden envelope optical transport

Copy everything below this line into Cursor Agent mode at the repository root.

---

You are modifying the existing repository at:

`/Users/riccardo/projects/intuizione`

Implement a new experimental optical transport for the existing mentalism prototype. The spectator must see a normal, realistic closed envelope. There must be no visible QR, Aztec matrix, finder marks, square cells, rings that encode data, or barcode-like geometry. The performer page must recognize the envelope from a brief camera glimpse, recover a short hidden optical token by combining several frames, resolve it against the existing dictionary, and lock the result.

This is an implementation task, not a design exercise. Inspect the current code first, then make the changes, run all tests, add the new tests described below, build the app, and report measured results and any acceptance gates that do not pass.

## First: understand and preserve the current application

Read these files before editing:

- `prototype/src/spectator/spectator.ts`
- `prototype/src/spectator/protocol.ts`
- `prototype/src/spectator/transports/*`
- `prototype/src/performer/scanner.ts`
- `prototype/src/performer/acquisition.ts`
- `prototype/src/performer/performer.ts`
- `prototype/protocol.py`
- `prototype/server.py`
- `prototype/esbuild.config.mjs`
- `prototype/package.json`
- the existing tests under `prototype/test` and `prototype/test_protocol.py`
- the existing dictionary loaders and `data/italian_words.csv`

Do not replace or regress the existing Protocol v1, manual-paste recovery, Standard QR, Wax seal, Postal mark, camera selection, duplicate suppression, stale-request generation checks, or diagnostics. Keep those as baseline/debug transports.

Add a fourth spectator transport called **Hidden envelope** and a corresponding performer scanning mode. Make Hidden envelope the default selected transport, but keep the old transports available under an explicitly labelled **Diagnostics / visible codes** section.

## Non-negotiable honesty rule

Do not claim “absolutely invisible” or “works in every condition” in code, UI, README, or your completion message. Those absolutes are physically impossible to prove across all eyes, displays, cameras, light, distance, motion, compression, and viewing angles.

Instead, implement measurable gates for:

1. operational invisibility at normal viewing size;
2. reliable acquisition inside a declared camera envelope;
3. no false locks.

If the implementation fails a gate, report that failure. Do not make the watermark stronger until it is visible and then call the task finished. The central engineering trade-off is invisibility versus camera robustness, and the calibration tooling must expose it.

## Do not build another disguised barcode

The following approaches are forbidden for Hidden envelope:

- QR, Aztec, Data Matrix, AprilTag, ArUco, or any standards-based 2-D symbol;
- a small code pasted into the wax seal;
- CSS grids, dot rings, square modules, or binary tiles;
- PNG metadata, EXIF, steganographic LSB-only storage, DOM attributes, alt text, hidden text, URLs, network callbacks, or timing channels;
- a visible low-contrast barcode that becomes obvious after simple contrast enhancement;
- animation for v1 of this transport.

The whole photographic envelope is the carrier. The hidden signal must be a weak, distributed, texture-adaptive chroma watermark. The performer must align a photographed frame to the known clean carrier and use matched filtering plus multi-frame evidence accumulation. A simple photograph/screenshot must contain the signal; no network connection may be required for encoding or decoding after the pages have loaded.

## Carrier asset

Use this existing clean envelope image as the initial known carrier:

`/Users/riccardo/.codex/generated_images/01a0885f-1366-7132-bc87-617afdddc629/exec-5bb138bd-537e-4b74-b04c-e571e9beec94.png`

Copy the exact original PNG into:

`prototype/src/assets/envelope/envelope-base-v1.png`

Do not recompress it. The exact same bytes must be used by the spectator encoder, the performer reference decoder, and tests. Update the build so it is copied to both relevant `dist` trees with a content hash recorded in a generated manifest. At runtime, verify the decoded asset pixels against the expected dimensions and a SHA-256 content hash before enabling Hidden envelope. A missing or changed asset must produce an explicit error, not silently continue.

Treat this asset as replaceable: all dimensions, masks, reference descriptors, and generated indexes must be versioned by `carrierId = "envelope-v1"`, not scattered as magic values.

## Hidden optical protocol v1

The current salted 48-byte Protocol v1 remains unchanged for QR/Aztec/manual-paste modes. It is too large for a very weak photographic watermark, so Hidden envelope uses a separate compact token.

Implement this exact compact protocol in a shared module and mirror it in Python tests:

1. Normalize the word with the existing normalization function. Do not introduce a second normalization implementation.
2. Generate exactly one random byte with `crypto.getRandomValues`; call it `salt8`.
3. Compute `SHA-256(byte(salt8) || UTF8(normalizedWord))`.
4. Take the first 6 digest bytes.
5. The optical codeword is exactly 7 bytes: `salt8 || digest[0:6]`.
6. Bit order is byte order left-to-right, most-significant bit first within each byte, for exactly 56 bits.
7. Use protocol ID `HENV1` in internal types and diagnostics. Do not put an extra version bit into the 56-bit codeword; the selected carrier manifest supplies the version.

This compact token is a dictionary fingerprint, not encryption and not a general-purpose secret. Add that precise statement to technical documentation. The one-byte salt gives 256 visual variants for the same word. Six digest bytes give a 48-bit comparison for the known salt.

At build/test time, enumerate every canonical word and alias in the current dictionary for all 256 salt values. Fail the build if two different candidate surfaces produce the same six-byte digest for the same salt. At runtime, never choose arbitrarily: zero matches means no match; more than one means ambiguous; exactly one is recoverable.

## Shared watermark basis

Create one shared deterministic basis implementation used by both encoder and decoder. Put protocol/basis constants in one versioned module. Do not duplicate constants.

Canonical geometry:

- carrier aspect ratio: preserve the source image exactly;
- canonical processing size: `768 × 512` pixels;
- watermark grid: `96 × 64` cells;
- bits: 56;
- only the central 92% of the carrier is eligible; keep a 4% guard band on every side;
- generate a texture/admissibility mask from the clean carrier, version it, and use exactly the same mask during encode and decode.

Basis generation:

- implement a small deterministic 32-bit integer PRNG/hash whose output is identical in browser, worker, Node tests, and Python reference tests;
- seed it from `carrierId`, a versioned basis key constant, `bitIndex`, `cellX`, and `cellY`;
- produce a balanced `-1/+1` field for each bit over the `96 × 64` grid;
- force each field to zero mean over eligible cells;
- reject and regenerate a field if its absolute normalized cross-correlation with any previous field exceeds `0.08`;
- persist a generated basis checksum in the carrier manifest and verify it in tests;
- never use `Math.random()`.

Texture/admissibility mask:

- derive it only from the clean carrier;
- exclude the guard band, clipped highlights, near-black pixels, and very smooth regions that would reveal added noise;
- use local luminance variance and gradient magnitude to weight suitable natural paper/wax/background texture;
- weights are continuous from `0` to `1`, not a binary cut-out;
- require at least 35% effective weighted coverage of the canonical image or fail carrier preparation;
- store the generated mask as a binary build asset so encoding and decoding cannot diverge.

The basis key is an implementation detail, not a cryptographic secret. Minification may slow casual inspection, but browser-delivered code is ultimately inspectable. Do not describe source minification as security.

## Spectator-side embedding

Add files with clear separation of concerns, for example:

- `prototype/src/shared/hiddenEnvelopeProtocol.ts`
- `prototype/src/shared/watermarkBasis.ts`
- `prototype/src/spectator/transports/hiddenEnvelope.ts`
- `prototype/src/spectator/watermark/embed.ts`
- `prototype/src/generated/envelopeManifest.ts`

The encoder runs entirely in the browser after the asset is loaded. It must not call the server and must not store the word, normalized word, salt, compact token, or generated image in localStorage, sessionStorage, IndexedDB, cookies, URL parameters, service-worker caches, or DOM attributes. Keep sensitive session values only in module memory, consistent with the current spectator code.

Embedding algorithm:

1. Decode the exact clean carrier to a canvas without browser CSS filters.
2. Generate the 56 codeword signs: bit `1 => +1`, bit `0 => -1`.
3. For each grid cell, sum the 56 signed basis values and divide by `sqrt(56)`.
4. Multiply by the continuous texture mask.
5. Remove the weighted mean and normalize the composite field to unit weighted RMS.
6. Clamp only pathological composite peaks to `±3 RMS`; report the clipped percentage in debug diagnostics.
7. Upsample the `96 × 64` composite field to the native carrier dimensions with bicubic interpolation.
8. Convert each source pixel from sRGB to a documented Y/Cb/Cr representation.
9. Preserve Y. Apply equal and opposite chroma modulation: `Cb += alpha * field`, `Cr -= alpha * field`.
10. Convert back to sRGB, clamp, and render the resulting bitmap. Do not layer a translucent texture using CSS; the pixels of the displayed image are the carrier.

`alpha` must come from the versioned carrier manifest. It must not be silently chosen per word. Add a development-only calibration command that sweeps candidate alpha values and selects the smallest value that passes robustness gates while remaining inside all perceptual gates. A production build uses only the committed calibrated value.

The spectator UI must show the final image at the largest size that fits the viewport while preserving aspect ratio. It must look like an ordinary closed envelope. No debug text, bounding box, payload, hash, salt, “encoded” label, or confidence may be visible in normal mode. Preserve the existing copy/paste payload only in a collapsible diagnostics section; for Hidden envelope it may show the seven-byte token as 14 hex characters for local testing, but it must be hidden by default.

Add a dev-only view enabled by `?debug=1` that shows:

- clean carrier;
- encoded carrier;
- an amplified `20×` chroma difference image;
- alpha, PSNR, SSIM, Delta E statistics, clipped-pixel count, salt, token, and encode time.

Never enable that view in normal mode.

## Objective perceptual gates

Implement image comparison in the calibration/test harness. A codeword/carrier pair passes the automated invisibility gate only if all are true:

- PSNR over RGB is at least `42 dB`;
- SSIM is at least `0.995`;
- mean CIEDE2000 Delta E is at most `0.50`;
- 99th-percentile CIEDE2000 Delta E is at most `1.50`;
- no individual non-clipped pixel exceeds Delta E `3.0`;
- no regular grid, square, finder, or ring is visible in the normal image or its ordinary grayscale version at 100% zoom.

Automated metrics are proxies, not proof of invisibility. Add a short `prototype/docs/PERCEPTUAL_TEST.md` specifying a randomized, double-blind A/B test at normal phone viewing size. Hidden envelope must not be labelled production-ready until at least 20 participants perform no better than chance within the test’s confidence interval. Record this as a manual release gate, not a unit test.

## Performer architecture

Do not bolt the watermark decoder into the existing synchronous ZXing loop. Add a separate pipeline running off the main UI thread.

Suggested files:

- `prototype/src/performer/watermark/hiddenEnvelopeWorker.ts`
- `prototype/src/performer/watermark/templateAlign.ts`
- `prototype/src/performer/watermark/radiometricNormalize.ts`
- `prototype/src/performer/watermark/extractSoftBits.ts`
- `prototype/src/performer/watermark/frameAccumulator.ts`
- `prototype/src/performer/watermark/dictionaryMatcher.ts`
- `prototype/src/performer/watermark/types.ts`

Use OpenCV.js/WASM for feature extraction, matching, homography, and warping. Load it once inside a Web Worker. Do not run OpenCV or pixel loops on the UI thread. Use `requestVideoFrameCallback` when available and a throttled `requestAnimationFrame` fallback otherwise. Allow only one worker job in flight; drop stale frames rather than queueing them.

Camera request:

- prefer the environment camera;
- request `1920 × 1080`, 30 fps, continuous autofocus where available;
- retain the current mild-constraint retry and clear permission errors;
- do not require the user to zoom;
- do not automatically turn on the torch;
- never record audio;
- never upload, persist, or log camera frames.

## Fast template detection and precise alignment

At worker startup:

1. Load and verify the clean carrier and manifest.
2. Compute reference grayscale data and reference chroma planes.
3. Precompute ORB keypoints/descriptors over the clean carrier, emphasizing the envelope edges, flap, seal, paper texture, and background texture.

For each analyzed camera frame:

1. Downscale a copy so its long edge is at most 720 pixels.
2. Run ORB with an initial target of 800 features.
3. Match with Hamming KNN and Lowe ratio `0.75`.
4. Estimate homography with RANSAC, reprojection threshold `3 px` at the downscaled resolution.
5. Reject unless there are at least 18 inliers, inlier ratio at least 0.35, a convex projected quadrilateral, projected carrier area at least 5% of the frame, and a numerically stable homography.
6. Warp the relevant source pixels to canonical `768 × 512`.
7. Refine geometric alignment on luminance only using a bounded ECC/homography refinement at a lower resolution. Cap iterations/time so one poor frame cannot stall the pipeline.
8. Produce a valid-pixel mask. Do not treat black warp borders or off-frame areas as evidence.

The base envelope supplies the visual features; do not add visible fiducials. Partial visibility may be accepted only when feature matching is stable and at least 60% of the watermark mask remains valid.

Compute a frame quality value from:

- projected carrier area;
- ORB inlier count and ratio;
- homography reprojection error;
- Laplacian sharpness after rectification;
- motion blur;
- clipped highlights/glare;
- underexposure;
- valid watermark coverage;
- ECC residual.

Reject low-quality frames early. Include rejection reasons and timings in debug mode.

## Chroma extraction and soft bits

For every accepted rectified frame:

1. Convert to the same Y/Cb/Cr convention used by the encoder.
2. Estimate robust per-channel affine color mapping from the clean reference to the observed frame using only valid, non-clipped pixels.
3. Subtract the mapped clean reference chroma from observed chroma.
4. Form the same opposite-chroma projection used for embedding.
5. Remove slowly varying illumination/white-balance residual with a documented local high-pass operation whose scale is larger than one watermark cell.
6. Downsample the residual and valid weights to the `96 × 64` grid.
7. Correlate the residual against each of the 56 deterministic basis fields using weighted normalized correlation.
8. Return 56 signed soft values, per-bit estimated noise, and frame quality. Do not immediately convert to hard bits.

Add a synthetic round-trip test proving that every one of the 56 basis positions has the correct sign and that bit order matches the Python reference.

## Circular buffer and evidence accumulation

Implement the requested circular-buffer behavior, but keep memory bounded:

- analyze at a target of 12–15 frames per second;
- hold at most the last 1.25 seconds or 18 accepted rectified observations, whichever is smaller;
- store rectified low-resolution chroma residuals/soft-bit vectors, quality, homography, and timestamps—not full-resolution camera frames;
- retain at most the best 10 observations for a decode decision;
- weight observations by frame quality and inverse estimated noise;
- reduce the weight of near-identical consecutive frames so one frozen frame cannot create false certainty;
- evict and release `ImageBitmap`, OpenCV Mat, and ArrayBuffer resources deterministically.

Accumulate each bit as a weighted log-likelihood/soft score. Reset accumulated evidence when template tracking is lost for more than 400 ms or when the aligned appearance indicates a different carrier instance.

## Dictionary-assisted soft decoding

Make recovery local to the performer worker so a successful optical read does not wait for an HTTP request.

Add a build step that reads the same dictionary source/load rules as the Python application and produces:

- compact candidate metadata containing surface, canonical word, concept ID, and match type;
- a binary table of the six-byte hidden digest for every `salt8` value and candidate surface;
- a source dictionary checksum and generation version.

The generated files are build artifacts derived from the existing dictionary; do not maintain a second hand-edited word list.

At decode time:

1. Use the first eight accumulated soft values to rank all 256 possible salt bytes by likelihood.
2. Keep the best eight salt hypotheses.
3. For each retained salt, score every dictionary candidate’s complete expected 56-bit codeword against all accumulated soft values.
4. Return the best and second-best candidates, score margin, estimated bit errors, salt likelihood, and any exact hard-token match.
5. A candidate is eligible to lock only if it is unique in the generated collision table.

Do not use a hard-bit-only decoder as the main path. The existing dictionary is part of the error-correcting decision: the performer needs the most likely valid dictionary codeword, not necessarily 56 individually perfect hard bits.

## Lock policy: reliability before eagerness

Extend `OpticalFormat` with `HIDDEN_ENVELOPE_V1` and integrate with the existing acquisition state machine without breaking QR/Aztec/manual paths.

Hidden envelope may lock only when all are true:

- at least three independently accepted frames contribute;
- accepted evidence spans at least 150 ms;
- the same best candidate is produced by the last three decision updates;
- the calibrated absolute confidence threshold passes;
- the calibrated best-versus-second score margin passes;
- the salt hypothesis is stable;
- the candidate is unique;
- no frame-quality safety flag is active.

Thresholds must live in the versioned carrier manifest and be produced by calibration, not scattered in UI code. Until empirical calibration exists, choose conservative provisional thresholds, label them provisional in diagnostics, and prefer “no lock” to a false lock.

Once locked:

- freeze and display the recovered canonical word immediately;
- record time from first usable frame to lock;
- keep the camera loop alive for a new valid carrier/token;
- reuse the current duplicate suppression semantics;
- do not replace a locked result because of a later weak candidate;
- require the old carrier/token to be absent for at least the existing cooldown before accepting it again;
- preserve generation IDs so stale worker/API results cannot overwrite a new lock.

## Performer UI and diagnostics

Normal performer mode should be operationally minimal:

- camera preview;
- `Searching`, `Envelope found`, `Reading`, or `Locked` status;
- recovered word;
- clear/new-read control;
- camera selection and explicit camera errors.

Do not show the hidden token, salt, scores, dictionary list, or algorithm details in normal mode.

Under `?debug=1`, add:

- detected quadrilateral overlay;
- inlier count/ratio and reprojection error;
- valid carrier percentage;
- sharpness, glare, and quality score;
- frame accept/reject reason;
- ring-buffer length and effective independent-frame count;
- each pipeline stage time and total frame time;
- accumulated soft-bit confidence;
- top five dictionary candidates, scores, and margin;
- time from first usable frame to lock;
- worker dropped-frame count;
- memory/resource counters;
- a rectified carrier preview and amplified residual preview.

Throttle diagnostic DOM updates to at most four times per second. Diagnostics must never slow the decoding loop materially.

## Performance targets

Profile, do not guess. On the development machine and at least one real recent iPhone or Android phone if available:

- UI main-thread long tasks: none over 50 ms during scanning;
- analyzed frame rate: at least 12 fps when the envelope is present;
- median worker processing per analyzed frame: under 60 ms;
- time to lock after the first usable frame: p50 under 300 ms, p95 under 900 ms;
- dictionary scoring after soft bits: under 20 ms p95;
- memory remains bounded during a 30-minute scan;
- no overlapping worker jobs and no unbounded promises/queues.

If OpenCV.js cannot meet these targets in the web prototype, document the measured bottleneck and isolate the codec behind interfaces suitable for a later native iOS/Android or custom WASM implementation. Do not pretend CSS or a faster scan timer fixes computational overload.

## Robustness test harness

Add a deterministic Node or Python test harness that starts from generated Hidden-envelope images and applies seeded synthetic screen/camera distortions. It must test at least:

- carrier displayed at 180, 240, 320, and 480 pixels high in the simulated frame;
- rotation from -20° to +20°;
- perspective/keystone transforms approximating 0°, 15°, 30°, and 40° off-axis views;
- Gaussian blur sigma 0, 0.6, 1.0, and 1.5;
- motion blur lengths 0, 3, 5, and 7 pixels in varied directions;
- JPEG quality 50, 70, and 90;
- brightness 0.6–1.4;
- contrast 0.7–1.3;
- warm/cool white-balance shifts;
- sensor noise;
- glare/occlusion covering 0%, 10%, and 20% of carrier area;
- crop/invalid area up to the declared 40% limit;
- combinations of these conditions, not only one distortion at a time.

Do not require every Cartesian combination; define a reproducible balanced matrix plus at least 1,000 seeded randomized combined trials over a representative set of dictionary words, aliases, and salt values.

Record:

- template-detection rate;
- correct-lock rate;
- no-lock rate;
- wrong-lock rate;
- p50/p95 time or frame count to lock;
- bit confidence and best/second margin distributions by condition.

Initial release gates inside the declared supported envelope:

- at least 99% correct locks over usable trials;
- zero wrong locks in the deterministic acceptance corpus;
- at least 95% locks by 10 accepted frames;
- no false lock during a 30-minute live scan of ordinary scenes without the carrier.

The declared supported envelope for v1 is:

- at least 60% of the watermark mask visible;
- carrier at least 240 pixels high in the camera frame;
- off-axis angle no more than approximately 35°;
- no more than 15% glare/occlusion;
- enough light and focus for flap/seal/paper texture to be resolved.

The wider 180-pixel/40°/20% cases are stress tests and may be reported as outside the release envelope. The UI should continue trying, never crash, and never wrong-lock.

## Tests to add

Add unit/integration tests for at least:

- hidden protocol known vectors, including `LETTO` with a fixed salt;
- normalization parity with the existing protocol;
- exact 56-bit ordering in TypeScript and Python;
- basis determinism and checksum;
- basis balance and maximum cross-correlation;
- carrier asset and mask checksums;
- all 256-salt dictionary collision audit;
- clean digital encode/decode for canonical words and aliases;
- wrong-word rejection;
- corrupted token and ambiguous-match behavior;
- soft dictionary matching with injected bit/sign noise;
- ring-buffer eviction and resource release;
- repeated-frame de-weighting;
- lock requires three independent frames and stable winner;
- stale generation cannot overwrite a newer result;
- old visible-code transports still pass all existing tests;
- production build includes all worker/WASM/assets and loads them at correct URLs.

Use fixed random seeds in tests. No flaky timing assertions.

## Build and dependencies

Update `prototype/package.json`, lockfile, and `prototype/esbuild.config.mjs` as needed. Pin dependency versions. Add third-party notices/licenses. Prefer a maintained OpenCV.js/WASM package or a locally pinned official build; do not fetch code from a CDN at runtime. The finished pages must work after initial load with the network disabled.

The build must:

- compile the worker as its own output;
- copy WASM and carrier assets with stable URLs;
- generate the carrier manifest, admissibility mask, reference descriptors if persisted, dictionary metadata, and digest table;
- fail on carrier checksum mismatch or dictionary collisions;
- keep production source maps disabled as they are now;
- not depend on files outside the repository after the asset-copy preparation step.

Add exact local run/build/test instructions to `prototype/RUN.txt` or a new README. Preserve the existing Python server’s correct MIME types, secure-context localhost behavior, camera permissions policy, and no-store headers.

## Manual real-camera validation protocol

Create `prototype/docs/CAMERA_VALIDATION.md` with a repeatable matrix:

- at least two spectator displays with different brightness/technology;
- at least two performer phones if available;
- display brightness at 30%, 60%, and 100%;
- indoor warm light, indoor dim light, bright diffuse daylight;
- distances/angles that produce carrier heights 240, 320, and 480 px and angles 0°, 20°, 35°;
- stationary presentation and a natural 0.5–1.0 second passing glimpse;
- 20 trials per condition;
- separate counts for found, locked correctly, no lock, wrong lock, and time to lock.

Do not tune only on one screen/camera pair. Commit raw aggregate results as JSON/CSV under `prototype/test-results/`, without camera images or user data.

## Delivery order

Implement in this order so failures are diagnosable:

1. compact hidden protocol and collision audit;
2. asset preparation, manifest, mask, and deterministic basis;
3. digital encoder and exact-image decoder;
4. perceptual metric/calibration harness;
5. synthetic geometric/radiometric distortion harness;
6. worker-based camera template detection/alignment;
7. soft extraction, circular buffer, dictionary-assisted scoring, and conservative lock policy;
8. UI integration and debug overlays;
9. regression tests, production build, memory/performance profiling, and documentation;
10. real two-phone validation.

Do not skip directly to camera UI before the digital and synthetic pipelines pass. Do not mark the work complete merely because an encoded envelope is rendered.

## Definition of done

The implementation is complete only when:

- Hidden envelope displays no visible code geometry;
- the objective perceptual metrics pass for the committed alpha across the tested word/salt corpus;
- digital and synthetic test suites pass;
- real camera results are measured and recorded, or explicitly reported as an outstanding manual gate if the hardware is unavailable;
- the performer locks only with conservative multi-frame evidence and never guesses on ambiguity;
- the camera pipeline stays responsive and memory-bounded;
- the app works locally and offline after initial load;
- all previous tests and visible transports still work;
- build/test/run commands and limitations are documented;
- any missed invisibility, reliability, latency, or device gate is reported numerically and plainly.

At the end, return:

1. a concise list of changed files;
2. exact commands run and their results;
3. perceptual metrics and robustness/performance measurements;
4. which automatic gates passed or failed;
5. which manual real-camera and 20-person perceptual gates remain;
6. no claims beyond the evidence.

Relevant background only, not a library requirement: StegaStamp demonstrates the general feasibility of short learned watermarks surviving physical camera capture, but this first repository implementation is a known-carrier, spread-spectrum prototype and must earn its own measured results: https://openaccess.thecvf.com/content_CVPR_2020/html/Tancik_StegaStamp_Invisible_Hyperlinks_in_Physical_Photographs_CVPR_2020_paper.html

