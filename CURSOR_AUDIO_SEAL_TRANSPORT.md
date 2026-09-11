# Cursor implementation prompt — audio hidden in envelope closing and wax stamp

Copy everything below this line into Cursor Agent mode at the repository root.

---

You are modifying the existing repository at:

`/Users/riccardo/projects/intuizione`

Implement an experimental acoustic transmitter and receiver for the mentalism prototype. The spectator presses **Generate seal** and hears a natural 2-second sound of paper/envelope closure followed by a wax-stamp impact. The existing 7-byte `HENV1` token must be hidden inside that sound. The performer page listens continuously through the microphone, decodes the token locally, resolves it against the existing dictionary, and locks the word. The existing hidden-envelope image remains available as the backup channel.

The first validation setup is two browser tabs on the same laptop:

- spectator transmitter: `http://127.0.0.1:8000/audio-lab/`
- performer receiver: `http://127.0.0.1:8001/audio-lab/`
- sound must travel physically from the laptop speaker to its microphone;
- there must be no network, storage, BroadcastChannel, SharedWorker, Service Worker, WebSocket, WebRTC data channel, URL, clipboard, or other hidden communication between the tabs.

After the isolated audio laboratory works, integrate the same modules into the existing spectator and performer pages. Do not create a second incompatible implementation for the main UI.

This is an implementation task. Inspect the current files, implement the complete vertical slice, add tests and diagnostics, run the existing and new tests, build the pages, and report measured results and any failed gates.

## Read and preserve the current implementation

Read these files before editing:

- `prototype/src/shared/hiddenEnvelopeProtocol.ts`
- `prototype/src/performer/watermark/dictionaryMatcher.ts`
- `prototype/src/generated/hiddenDictionaryMeta.ts`
- `prototype/src/generated/hiddenDigestTable.bin`
- `prototype/src/spectator/spectator.ts`
- `prototype/src/spectator/transports/hiddenEnvelope.ts`
- `prototype/src/performer/performer.ts`
- `prototype/src/performer/acquisition.ts`
- `prototype/src/performer/index.html`
- `prototype/src/spectator/index.html`
- `prototype/esbuild.config.mjs`
- `prototype/server.py`
- `prototype/package.json`
- `prototype/RUN.txt`
- all current tests

Preserve all working visual transports, manual-paste recovery, camera selection, hidden-envelope worker, dictionary generation, duplicate suppression, stale-generation protection, content-security policy, offline-after-load behavior, and existing tests.

Do not edit generated dictionary files manually. Reuse the generated candidate metadata and digest table.

## Non-negotiable constraints

1. The audio and image must carry the exact same `HENV1` token.
2. Generate that token exactly once per sealed session.
3. “Repeat seal” reuses the same token and salt; it may generate fresh cover-sound noise.
4. Switching between audio, hidden image, and diagnostic visual transports must not generate a new `HENV1` token.
5. Do not transmit the 48-byte visible-code Protocol v1 through audio.
6. The receiver must decode from microphone samples, not from a direct in-memory waveform handoff.
7. Digital loopback is allowed only in automated tests and an explicitly labelled debug control.
8. Normal spectator UI must never display token, payload, frequencies, waveform, codec, or “transmitting” terminology.
9. Audio processing and decoding must be local after the pages have loaded. Do not add an API call to reveal the word.
10. Do not claim that the watermark is absolutely inaudible or universally reliable. Measure both.

## Correct the current token lifecycle

The current `renderHiddenEnvelope()` creates its own `HENV1` token. Refactor this before adding audio:

- `spectator.ts` owns one `HiddenToken | null` for the sealed session;
- on Generate, normalize once and call `createHiddenToken(normalized)` once;
- pass the resulting token into the visual embedder;
- pass the same token into the acoustic transmitter;
- change `renderHiddenEnvelope()` to accept a `HiddenToken` or exact seven-byte token instead of creating one;
- remove logic that recreates a token when transport changes;
- update misleading comments that currently say Hidden envelope intentionally creates a fresh token per render;
- zero/release session references on reset/open;
- add a regression test proving image, first audio play, repeated audio play, and a re-render all use the identical 14-character token.

Continue using the exact existing `HENV1` definition:

```text
byte 0       salt8
bytes 1..6   first six bytes of SHA-256(salt8 || UTF8(normalized word))
total        7 bytes / 56 bits, MSB-first
```

Do not modify `HENV1` normalization, bit ordering, hashing, salt generation, or dictionary collision rules.

## Acoustic protocol AENV1

`AENV1` is a transport wrapper around the unchanged 7-byte `HENV1` token.

Build this exact logical packet:

```text
HENV1 token                 7 bytes / 56 bits
CRC-16/CCITT-FALSE          2 bytes / 16 bits
payload before FEC          9 bytes / 72 bits
six zero termination bits             6 bits
convolutional input                   78 bits
rate-1/2 convolutional output        156 bits
```

CRC definition:

- CRC-16/CCITT-FALSE;
- polynomial `0x1021`;
- initial value `0xFFFF`;
- no reflection;
- final XOR `0x0000`;
- append CRC high byte then low byte;
- CRC covers only the seven HENV1 bytes.

FEC definition:

- binary convolutional code;
- constraint length `K=7`;
- rate `1/2`;
- generator polynomials `171` and `133` in octal;
- shift the 72 packet bits MSB-first;
- append six zero tail bits;
- output generator `171` first, then `133`, for every input bit;
- implement a soft-decision Viterbi decoder, not hard-only decoding;
- verify that the best final state is zero because of the tail bits;
- expose best-path metric and second-path/margin diagnostics.

Interleaving:

- deterministically permute the 156 coded bits before modulation;
- generate the permutation with a small documented 32-bit PRNG seeded only by the fixed `AENV1` version constant;
- use Fisher–Yates exactly once at module initialization;
- expose and test the inverse permutation;
- never use `Math.random()` for protocol structure.

Create shared modules such as:

- `prototype/src/shared/audioSeal/constants.ts`
- `prototype/src/shared/audioSeal/crc16.ts`
- `prototype/src/shared/audioSeal/convolutional.ts`
- `prototype/src/shared/audioSeal/interleave.ts`
- `prototype/src/shared/audioSeal/packet.ts`
- `prototype/src/shared/audioSeal/prng.ts`

Protocol/FEC code must run identically in browser, Audio Worker, Node tests, and a small Python reference test.

## Canonical waveform and timing

Generate and decode against a canonical mono sample rate of exactly `48,000 Hz`. If the actual microphone `AudioContext` uses another sample rate, resample captured mono audio to 48 kHz in the worker with a deterministic band-limited or high-quality windowed-sinc resampler. Do not merely reinterpret samples.

The initial `AENV1` sound is exactly 2.10 seconds / 100,800 canonical samples:

```text
0.00–0.10 s   natural paper pre-roll                 4,800 samples
0.10–0.26 s   masked synchronization preamble        7,680 samples
0.26–0.30 s   guard / paper movement                  1,920 samples
0.30–1.86 s   156 data symbols × 480 samples         74,880 samples
1.86–2.10 s   wax impact/release tail                11,520 samples
```

Each data symbol is exactly 10 ms / 480 samples at the canonical rate.

Do not shorten or change these values ad hoc. Put them in one constants module and assert that all regions sum to exactly 100,800 samples.

## Synchronization preamble

Use a known, zero-mean, tapered double chirp hidden under the paper sound:

- first 80 ms: logarithmic chirp from 2.6 kHz to 7.4 kHz;
- next 80 ms: logarithmic chirp from 7.4 kHz to 2.6 kHz;
- continuous phase inside each chirp;
- Hann fade at boundaries;
- normalized unit RMS before masking;
- fixed polarity and versioned checksum.

The preamble is not payload. It locates packet start and provides a first timing/channel-quality estimate.

## Data modulation: masked DSSS/BPSK

Do not encode data as obvious DTMF, Morse, sequential beeps, or a single near-ultrasonic tone. For this remote-oriented prototype, do not rely on frequencies above 16 kHz. Video-call noise suppression and phone/laptop hardware may remove them.

Use noise-like direct-sequence spread-spectrum BPSK under the audible envelope/wax effect:

- useful band: approximately 2.8–7.6 kHz;
- 156 modulated symbols, one per interleaved coded bit;
- bit `1 => +basis`, bit `0 => -basis`;
- each 480-sample symbol gets a deterministic pseudo-random balanced chip sequence;
- 30 chips per symbol, 16 canonical samples per chip;
- exactly 15 positive and 15 negative chips per symbol;
- derive chips from `AENV1`, symbol index, and a fixed basis key;
- reject/regenerate a sequence if it has excessive DC or correlation with adjacent symbol bases;
- multiply chips by a deterministic frequency-hopped sinusoidal basis;
- select hop frequency from `{3200, 4000, 4800, 5600, 6400, 7200}` Hz using the same versioned PRNG and symbol index;
- preserve phase continuously within a symbol;
- apply a short raised-cosine edge taper that does not change total symbol length;
- normalize every final symbol basis to unit RMS;
- assert low normalized cross-correlation between adjacent symbol bases.

The receiver must regenerate these exact bases. Do not store the 156 waveforms as hand-edited assets.

## Natural cover sound

For the prototype, procedurally synthesize a convincing placeholder sound with independent code paths for:

1. paper friction/folding;
2. envelope flap closing;
3. stamp handle/wood contact;
4. wax impact and low thump;
5. brief wax/paper crackle and decay.

Create this as deterministic DSP over a `Float32Array`, with an optional test seed. Production playback uses a fresh cryptographically random cover-noise seed on every play, while the HENV1 token remains unchanged.

The cover sound should occupy the full 2.10 seconds so the data never sits in silence. It should have:

- filtered pink/brown and white-noise components for paper texture;
- short broadband transients for flap and stamp;
- damped low-frequency resonances for physical weight;
- no speech;
- no repeated tonal melody;
- no clipping, DC offset, or discontinuities;
- a coherent theatrical progression: paper movement → flap closure → stamp → decay.

Separate the cover generator from the data embedder so the procedural sound can later be replaced by a professionally recorded, owned WAV without changing `AENV1`.

Suggested files:

- `prototype/src/spectator/audioSeal/coverSound.ts`
- `prototype/src/spectator/audioSeal/modulator.ts`
- `prototype/src/spectator/audioSeal/renderAudioSeal.ts`
- `prototype/src/spectator/audioSeal/playback.ts`

## Masking and mix level

The data waveform must be mixed beneath the natural cover, not played separately.

Implement a versioned `watermarkDb` parameter and a calibration sweep. Initial provisional value: `-18 dB` relative to the cover RMS inside the data region. This is provisional, not a claim that it is imperceptible.

For every 20 ms cover window:

- estimate local cover RMS;
- derive a smooth masking envelope;
- keep data gain proportional to cover energy;
- enforce a conservative floor only where needed for decodability;
- smooth gain changes to avoid modulation clicks;
- never allow the watermark alone to dominate a quiet region.

After mixing:

- remove DC;
- calculate cover RMS, watermark RMS, local and global watermark-to-cover ratio, and peak;
- scale the complete mix linearly if needed to keep absolute peak at or below `-1 dBFS`;
- do not use a nonlinear limiter or compressor in the transmitter because it can damage correlation;
- add 5 ms fades at the complete-buffer boundaries;
- expose all measurements only in debug/lab mode.

Add a calibration command that sweeps at least `-30, -26, -22, -20, -18, -16, -14, -12 dB`, runs the channel simulator, and reports decoding performance. Do not automatically commit a stronger level merely because it decodes better.

## Transmitter behavior and autoplay

The transmitter requires no microphone permission. Audio playback must begin only as a consequence of the spectator’s click.

Browser autoplay detail is important: create/resume the `AudioContext` synchronously at the beginning of the **Generate seal** click handler, before awaiting SHA-256, image encoding, asset fetches, or other promises. Then generate the token, image, and audio. Play when ready using that already-unlocked context.

If audio cannot start, show a neutral normal-mode message such as “Tap the seal to close the envelope.” Do not mention browser autoplay or transmission to the spectator.

Normal spectator flow:

1. enter word;
2. press **Generate seal**;
3. page creates one HENV1 token;
4. hidden image is rendered with that token;
5. the 2.10-second closure/stamp sound plays once;
6. the screen shows the closed envelope;
7. a natural **Press the seal again** control repeats the same token with a fresh cover-noise seed;
8. reset/open stops playback, disconnects nodes, zeros releasable buffers, revokes object URLs, and drops token references.

Prevent overlapping plays. If the repeat control is pressed while playing, either ignore it or restart cleanly after stopping the previous source; never mix two packets.

The transmitter lab page must additionally provide:

- word entry and normalized preview;
- fixed-salt field for repeatable tests;
- Generate and Play;
- Repeat same token;
- Stop;
- cover-only playback;
- encoded playback;
- digital-loopback decode button clearly labelled debug-only;
- `watermarkDb` selector;
- token hex, CRC, FEC bit count, sample rate, duration, render time, RMS and peak diagnostics;
- waveform canvas and spectrogram canvas;
- WAV download for cover-only, watermark-only, and mixed signals in debug mode.

WAV export must be implemented locally and is for laboratory use only.

## Microphone receiver architecture

Suggested files:

- `prototype/src/performer/audioSeal/audioCaptureWorklet.ts`
- `prototype/src/performer/audioSeal/audioDecoderWorker.ts`
- `prototype/src/performer/audioSeal/resample.ts`
- `prototype/src/performer/audioSeal/preambleDetector.ts`
- `prototype/src/performer/audioSeal/softDemodulator.ts`
- `prototype/src/performer/audioSeal/audioLockPolicy.ts`
- `prototype/src/performer/audioSeal/audioScanner.ts`
- `prototype/src/performer/audioSeal/types.ts`

Capture and decode off the UI thread:

- `getUserMedia({video:false, audio:{...}})` for the receiver;
- an `AudioWorkletProcessor` only collects mono PCM into bounded chunks;
- transfer chunks to a dedicated decoder Worker;
- perform resampling, filtering, correlation, Viterbi, CRC, and dictionary matching in the Worker;
- never run continuous correlation on the main thread;
- allow at most one decoder operation in flight;
- use a bounded circular buffer of at most six seconds of canonical mono samples;
- release transferred arrays and audio nodes deterministically;
- never record, upload, persist, or log microphone audio.

Request these microphone constraints as preferences:

```js
{
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 48000 },
  echoCancellation: { ideal: false },
  noiseSuppression: { ideal: false },
  autoGainControl: { ideal: false }
}
```

Do not use `exact` for processing preferences because unsupported constraints should not prevent capture. After permission, inspect `track.getSettings()` and show the actual sample rate/channel count/processing flags in lab diagnostics.

Update performer HTTP headers to explicitly allow `microphone=(self)` as well as `camera=(self)`. Update CSP/build output so the dedicated Worker and AudioWorklet load only from the performer origin and work offline after the initial page load.

## Receiver synchronization and preprocessing

Maintain a continuously updated six-second ring buffer. Preprocess a detection copy as follows:

- mix channels to mono if necessary;
- resample to canonical 48 kHz;
- remove DC with a stable high-pass filter;
- band-limit the detection path to approximately 2.2–8.2 kHz;
- use block normalization/AGC only in the analysis path, never alter captured source data destructively;
- estimate input dBFS and clipping percentage.

Use a two-stage preamble detector:

1. Coarse stage: decimate the band-limited stream to 12 kHz and run normalized correlation against the decimated double chirp every 2 ms.
2. Fine stage: around each coarse peak, search the full-rate 48 kHz signal over at least ±96 samples and select the maximum normalized correlation.

Debounce adjacent peaks from the same packet. A preamble candidate must exceed a provisional versioned correlation threshold and local peak-to-sidelobe ratio. Keep thresholds configurable in the audio manifest and show them in diagnostics.

To tolerate clock mismatch and conferencing/resampling, test timing scale hypotheses at least `{0.995, 0.9975, 1.0000, 1.0025, 1.005}` during fine alignment, or estimate an equivalent bounded scale from the two chirp halves. Use the winning timing model when locating all 156 symbols.

Do not block listening while a candidate packet is decoded. Snapshot only the required bounded region. If samples for the full packet have not arrived, retain the candidate until complete or expired.

## Soft demodulation and FEC decode

For each of the 156 expected symbols:

1. regenerate the exact symbol basis;
2. apply the winning time scale;
3. search a small bounded timing offset around the expected start;
4. compute normalized correlation against both polarities;
5. estimate local noise from orthogonal/off-symbol correlations;
6. produce a signed log-likelihood/soft value, not just a hard bit.

Then:

1. inverse-interleave the 156 soft values;
2. run soft-decision Viterbi for `K=7`, rate `1/2`, polynomials 171/133 octal;
3. require the six tail bits to decode to zero;
4. recover the 72 packet bits;
5. parse 7-byte token and 2-byte CRC;
6. require CRC success;
7. perform exact dictionary lookup using the existing generated HENV1 digest table;
8. require exactly one dictionary surface/concept match;
9. emit a lock event with canonical word, matched surface, match type, token hex, timings, and confidence.

Add an exact-token lookup helper to the existing dictionary matcher instead of fabricating visual soft scores. Never choose a nearest dictionary word after CRC failure. CRC failure, no match, or ambiguity means no lock.

## Audio lock and repeat policy

A valid CRC plus a unique exact HENV1 dictionary match is required to lock. Additionally require:

- preamble correlation over threshold;
- acceptable peak-to-sidelobe ratio;
- Viterbi metric/margin over provisional threshold;
- no severe input clipping flag;
- packet not previously locked during the duplicate-suppression window.

One valid complete packet may lock; do not require the spectator to play it twice. “Repeat seal” is recovery for a missed packet.

After lock:

- freeze the word immediately;
- keep listening for a genuinely new token;
- suppress repetitions of the same token;
- preserve the current acquisition generation/stale-result protections;
- optionally vibrate the performer device with a short pattern if the Vibration API is available, but do not depend on vibration.

If a later packet disagrees while a word is locked, do not overwrite silently. Require the performer to clear/start a new read or meet the existing explicit new-token policy.

## Receiver lab page

Build a dedicated performer lab page at `/audio-lab/` with:

- microphone selector;
- Start listening and Stop;
- permission/error messages;
- large state: `IDLE`, `LISTENING`, `PREAMBLE`, `DECODING`, `LOCKED`;
- large recovered canonical word;
- Clear/new read;
- input level meter;
- scrolling waveform and spectrogram, throttled for UI performance;
- decoded token and dictionary metadata;
- actual track settings;
- sample rate and resampler status;
- preamble score and sidelobe ratio;
- time-scale hypothesis;
- per-stage timing;
- 156 soft-value summary;
- Viterbi metric/margin;
- CRC result;
- packet SNR estimate;
- counts for candidates, CRC failures, no-match, duplicates, locks, dropped chunks, and buffer overruns.

Do not update diagnostic DOM more than four times per second.

Add an optional debug file input so a WAV recorded through Zoom/Meet or another device can be decoded through the exact same worker pipeline. This is a laboratory input, not a separate decoder.

## Integrate with the main application

After the lab round trip passes:

### Spectator

- Hidden envelope remains the visual output.
- Generate seal plays the encoded closure/stamp sound automatically from the same click.
- Add a natural seal-repeat interaction without technical wording.
- Use the same HENV1 token for sound and image.
- Keep all audio diagnostics behind `?debug=1` or the lab route.
- If playback fails, keep the visual envelope fully usable as backup.

### Performer

Add scan choices:

- **Audio — primary** (default);
- **Hidden envelope — visual backup**;
- **Diagnostics / visible codes**.

Audio mode requests only microphone permission. Visual backup requests only camera permission. Switching modes stops and releases the previous media stream cleanly but does not clear an already locked word unless the performer presses Clear.

Design interfaces now so a later **Audio + image fusion** mode can combine both channels, but do not fake fusion in this first task. The first deliverable is a reliable exact audio lock plus the existing manual visual fallback.

## Security/privacy assertions for the two-tab test

The audio lab must prove the acoustic channel is real:

- spectator and performer remain on separate existing origins/ports;
- do not relax spectator `connect-src` to performer origin;
- no CORS between the origins;
- no token in query string, fragment, referrer, cookies, storage, or server logs;
- no cross-tab messaging API;
- after both pages load, Generate/Play/Decode must work with network disabled;
- receiver must fail if speaker is muted and digital loopback is off;
- receiver must succeed from an imported WAV only when the explicit debug file-input path is used.

Add a test/static audit that searches production bundles for accidental use of `BroadcastChannel`, `WebSocket`, `RTCPeerConnection`, cross-origin performer URLs in spectator code, and token persistence APIs.

## Automated tests

Add deterministic tests for at least:

- CRC known vectors and corruption detection;
- convolutional encoder known vectors;
- Viterbi exact clean decode;
- Viterbi soft decode with controlled bit noise;
- tail-bit and final-state enforcement;
- interleaver permutation/inverse round trip and checksum;
- exact packet length: 72 input bits, 78 terminated bits, 156 coded bits;
- waveform exact length: 100,800 samples;
- preamble checksum and detection offset;
- symbol basis determinism, balance, RMS, and adjacent correlation;
- `LETTO` with fixed HENV1 salt and fixed cover seed;
- end-to-end digital encode/decode for canonical and alias dictionary entries;
- identical image/audio/repeat token lifecycle;
- CRC failure never locks;
- valid CRC with no dictionary match never locks;
- duplicate token suppresses repeated locks;
- new token can lock after clear;
- 44.1 kHz → 48 kHz resample path;
- bounded ring-buffer wrap/eviction;
- chunk loss and stale candidate expiration;
- no resource growth over repeated start/stop cycles;
- production build contains Worklet, Worker, lab pages, and required binary assets;
- all previous visual tests remain green.

Mirror packet, CRC, convolutional, interleave, and a fixed `LETTO` waveform/token vector in Python. TypeScript and Python must agree byte-for-byte and bit-for-bit.

## Channel simulator

Add `npm run test:audio-channel` or an equivalent deterministic harness. Generate many encoded sounds and apply seeded combinations of:

- gain from -30 dB to +6 dB;
- additive white and pink noise at SNR 0, 5, 10, 15, 20, and 30 dB;
- low-pass cutoffs 6, 8, 10, 12, and 16 kHz;
- high-pass cutoffs 80, 200, 500, 1000, and 2000 Hz;
- broad EQ tilt and narrow notches;
- room impulse responses / echoes from 10–150 ms;
- sample-rate conversion 44.1 ↔ 48 kHz;
- clock drift/time scaling ±0.5%;
- soft clipping and 1% hard clipping;
- automatic-gain-like slow amplitude changes;
- short dropouts of 5–30 ms;
- MP3/AAC/Opus transcoding when a locally available encoder exists;
- combinations, not just one impairment at a time.

Use at least 1,000 reproducible randomized combined trials across representative canonical words, aliases, salts, and cover seeds.

Report:

- preamble detection rate;
- correct token rate;
- correct word-lock rate;
- CRC rejection rate;
- wrong-lock count;
- p50/p95 decode time after the last packet sample;
- results grouped by impairment and watermark level.

Never count a CRC/no-lock outcome as a wrong word. The critical metric is zero wrong locks.

## Initial acceptance gates

For clean digital and mild simulated conditions:

- 100% correct token and word;
- zero wrong locks;
- at least 99% packet detection;
- worker decode completes within 250 ms p95 after the final sample on the development laptop;
- no main-thread task over 50 ms caused by continuous decoding;
- ring-buffer and memory use remain bounded for a 30-minute run.

For the initial physical two-tab laptop test:

- receiver started before transmission;
- internal speaker and microphone selected;
- speaker volume tested at 30%, 60%, and 100%;
- at least 20 plays at each level;
- at least 95% correct locks at 60% and 100% in a quiet room;
- zero wrong locks;
- repeat seal succeeds when an isolated first play is deliberately interrupted;
- muting the speaker produces zero locks;
- time from sound start to displayed word is recorded.

These are prototype gates, not claims about arbitrary phones or video-call platforms.

## Audibility/perceptual evaluation

The natural seal sound is intentionally audible. The encoded data should not be recognizable as beeps, modem tones, Morse, or a separate artificial layer.

Add `prototype/docs/AUDIO_PERCEPTUAL_TEST.md` specifying a randomized double-blind test comparing cover-only and encoded seal sounds at matched loudness. Record:

- whether listeners can identify which contains data;
- reports of beep, whistle, chirp, metallic tone, or discomfort;
- headphone and phone/laptop speaker results;
- younger listeners because high-frequency sensitivity differs.

Do not call the data layer perceptually hidden until at least 20 listeners perform no better than chance within the declared analysis and no systematic tonal artifact is reported. Keep this as a manual release gate.

## Remote-call validation, after local success

Create `prototype/docs/AUDIO_REMOTE_VALIDATION.md`. The remote channel is not considered validated by same-laptop success.

Record the seal sound through real calls using at least Zoom and Google Meet where available, with default noise suppression first. Test these topologies separately:

1. spectator page on phone, call on a separate laptop/tablet;
2. spectator page and call on the same phone;
3. performer decoder phone listening near the performer computer speaker;
4. imported recording captured from the conferencing output.

The same-phone spectator topology is expected to be risky because audio routing and echo cancellation may remove locally played sound. Report it separately; do not generalize from the two-device topology.

Store only short purpose-made seal recordings with no voices or personal data. Report correct/no-lock/wrong-lock and platform settings. Do not ask ordinary spectators to change “original sound” or music-mode settings; default settings are the target.

## Build and server changes

Update `prototype/esbuild.config.mjs` to:

- build the transmitter lab JS/CSS/HTML under `dist/spectator/audio-lab/`;
- build the receiver lab JS/CSS/HTML under `dist/performer/audio-lab/`;
- build the receiver AudioWorklet as a separate unbundled-compatible module;
- build the decoder Worker as a separate file;
- include shared audio modules in test bundles;
- copy any later professional cover WAV with checksum verification;
- preserve disabled production source maps;
- keep all assets local with no runtime CDN.

Update `prototype/server.py`:

- add `.wav` MIME if required;
- keep `Cache-Control: no-store`;
- set performer `Permissions-Policy: camera=(self), microphone=(self)`;
- ensure CSP permits the local Worker/AudioWorklet without `unsafe-eval`;
- never log token or microphone data.

Update `prototype/RUN.txt` with exact commands and this two-tab sequence:

1. build and start the existing dual-origin server;
2. open performer `/audio-lab/`;
3. click Start listening and grant microphone permission;
4. verify correct input device and live level;
5. open spectator `/audio-lab/`;
6. disconnect Bluetooth/headphones for the first physical test;
7. set laptop media volume to 60%;
8. enter `LETTO` and press Generate and Play;
9. verify CRC, exact HENV1 token, and recovered `LETTO`;
10. mute speaker and prove no acoustic lock occurs;
11. test Repeat same token;
12. run cover-only and prove it never locks.

## Implementation order

Implement in this order:

1. refactor single-token ownership and add regression tests;
2. CRC, convolutional FEC, interleaver, Viterbi, and Python parity vectors;
3. deterministic preamble and symbol basis;
4. procedural cover and masked transmitter;
5. exact digital-loopback decoder tests;
6. channel simulator and calibration report;
7. receiver Worklet, Worker, ring buffer, and microphone device handling;
8. transmitter and receiver lab pages;
9. physical two-tab instructions and measurements;
10. main spectator/performer integration;
11. full regressions, offline test, memory test, and documentation;
12. remote-call recording tests only after local gates pass.

Do not start by drawing a spectrogram UI. The codec must pass exact digital and simulated-channel tests before microphone UI integration.

## Definition of done

The task is complete only when:

- sound and hidden image use the same HENV1 token;
- a natural closure/stamp sound carries the AENV1 packet;
- receiver microphone decoding works between two tabs without any non-acoustic communication;
- CRC and exact dictionary match are mandatory before lock;
- cover-only and muted-speaker tests never lock;
- Repeat seal reuses the token and can recover a missed read;
- worker/audio resources and memory are bounded;
- current visual transports and tests are not regressed;
- build/run/test commands are documented;
- automatic metrics are reported numerically;
- unperformed physical, perceptual, or remote tests are identified plainly rather than claimed as passed.

At the end return:

1. concise changed-file list;
2. exact commands run and results;
3. `LETTO` fixed-vector details;
4. digital and simulated-channel results;
5. two-tab physical results if hardware execution was possible;
6. latency and memory measurements;
7. audibility observations without unsupported claims;
8. passed, failed, and still-manual gates.

