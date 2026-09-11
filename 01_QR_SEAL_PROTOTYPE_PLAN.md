# Cursor implementation brief: Offline QR Seal prototype

## Instruction to Cursor

Implement this specification in the existing repository. Preserve the current CLI, engine, dictionary builder, CSV schema, and tests. The result must be a working local prototype, not pseudocode.

The spectator-side protocol is intended to remain stable after this prototype. UI styling and the performer dictionary may change later, but normalization, salt generation, hashing, binary packing, Base64URL encoding, and privacy behavior must follow this document exactly.

Do not silently change SHA-256 to a password hash or key-derivation function. Fast enumeration is intentional in this experiment.

## Goal

Create two completely separate local web experiences:

1. **Spectator page** — accepts a word, normalizes it, creates an offline salted SHA-256 commitment, displays a QR containing the commitment payload, and displays the identical payload as a copyable string.
2. **Performer page** — accepts the copied payload, validates and unpacks it, searches the existing Italian dictionary, and reports the recovered word, timing information, and any errors.

For the first prototype, QR scanning is not required. Copying the 64-character string from the spectator page and pasting it into the performer page is the test transport.

## Non-negotiable architectural boundary

The spectator application must be a standalone static bundle. It must contain no dictionary, aliases, candidate enumeration, performer API URL, recovery code, performer UI code, or shared application bundle with performer functionality.

The performer code and dictionary must be served from a different local origin/port. The spectator source files may share protocol constants with tests during development, but the built spectator bundle must not import or include any performer module.

Run the prototype with one Python command, but expose two origins:

```text
http://127.0.0.1:8000/   spectator
http://127.0.0.1:8001/   performer
```

Binding must default to `127.0.0.1`, not all network interfaces. Ports may be overridable with command-line options.

## Threat model and honest limits

Design for these observers:

- an ordinary spectator who sees the QR and 64 random-looking characters;
- a curious spectator who uses View Source or browser developer tools;
- a technically capable spectator who downloads and formats the static JavaScript.

The spectator bundle should reveal only a legitimate salted commitment implementation. It must not reveal the recovery method or candidate universe.

Do not claim that browser JavaScript is impossible to reverse engineer. A determined technical observer can discover the normalization, SHA-256, salt, and payload layout. No client-side obfuscation can prevent that. The intended conceptual concealment is that the dictionary attack exists only on the performer side.

Production builds must nevertheless remove easy clues:

- minify the spectator bundle and mangle local identifiers;
- emit no source map;
- expose no protocol functions or state on `window`;
- include no debug logging, comments, development banners, endpoint names, or performer terminology;
- serve only built assets, never the source directory;
- do not use anti-debugger loops, self-modifying code, `eval`, or aggressive obfuscators that compromise reliability or violate the Content Security Policy.

The best result of inspecting the page should be: “This is an offline page that normalizes text, creates random bytes, calculates SHA-256, and draws a QR.” That is exactly the overt explanation.

## Protocol v1: exact and immutable

Use the following constants:

```text
DIGEST_BYTES = 32
SALT_BYTES = 16
PAYLOAD_BYTES = 48
PAYLOAD_CHARS = 64
```

No separator, prefix, JSON, URL, label, version marker, checksum, padding, or metadata is present inside the payload. Version 1 is identified by its decoded length and the application version.

### 1. Normalize the word

The browser implementation must exactly mirror `build_dictionary.normalize_word`:

1. trim leading and trailing whitespace;
2. apply Unicode NFKD normalization;
3. remove combining marks/accents;
4. convert to uppercase;
5. retain only ASCII `A` through `Z`.

Examples:

```text
" ombrello "  -> "OMBRELLO"
"caffè"       -> "CAFFE"
"TV"          -> "TV"
```

Reject generation when the result is empty. The spectator page must not look up or validate the normalized word against any dictionary.

### 2. Generate the salt

Generate exactly 16 random bytes using:

```javascript
crypto.getRandomValues(new Uint8Array(16))
```

Never use `Math.random`, timestamps, UUID text, counters, or a server-provided salt.

### 3. Calculate the digest

Encode the normalized word as UTF-8. Since normalization retains only `A-Z`, the UTF-8 bytes are also ASCII bytes.

Construct the hash input as raw bytes:

```text
salt_bytes || normalized_word_utf8
```

Calculate:

```text
digest_bytes = SHA-256(salt_bytes || normalized_word_utf8)
```

Use the browser Web Crypto API, not a handwritten SHA-256 implementation:

```javascript
crypto.subtle.digest("SHA-256", hashInput)
```

If Web Crypto is unavailable, show a clear unsupported/secure-context error and generate nothing. Local testing must use `127.0.0.1` or `localhost`, which browsers treat as a trustworthy development origin. Do not add a weaker cryptographic fallback.

### 4. Pack the payload

Concatenate the raw bytes in this exact order:

```text
payload_bytes = digest_bytes || salt_bytes
```

Therefore:

- decoded bytes `0..31` are the expected SHA-256 digest;
- decoded bytes `32..47` are the salt.

### 5. Encode the displayed string

Encode the 48 payload bytes with Base64URL, without `=` padding:

- replace `+` with `-`;
- replace `/` with `_`;
- remove trailing `=` padding.

The result must always be exactly 64 case-sensitive characters matching:

```regex
^[A-Za-z0-9_-]{64}$
```

Do not uppercase or lowercase this string. The QR content must be exactly this string and nothing else.

### Mandatory cross-language test vector

Both JavaScript and Python tests must pass this fixed vector:

```text
input:       "  caffè! "
normalized:  CAFFE
salt hex:    000102030405060708090a0b0c0d0e0f
digest hex:  ad2fc692d551bed163b3498ca1bb539b3477be2d5af61b5accd9c09ad3cdda32
payload:     rS_GktVRvtFjs0mMobtTmzR3vi1a9htazNnAmtPN2jIAAQIDBAUGBwgJCgsMDQ4P
length:      64 characters
```

Production UI must never allow the user to choose or display a fixed salt. Deterministic salt injection is test-only.

## Spectator page requirements

### Functional behavior

The page must provide:

- one word input;
- a live or on-submit normalized preview in uppercase;
- a **Generate seal** button;
- a QR code generated entirely in the browser;
- the exact 64-character payload beneath the QR in a selectable monospace field;
- a **Copy** button using the Clipboard API with a manual-selection fallback;
- a **Reveal original word** control for local post-performance verification;
- a **Start again** control that clears the current seal and creates a new salt on the next generation;
- concise validation and compatibility errors;
- a small online/offline indicator labelled as the browser's reported status, not as proof of privacy.

After sealing:

- make the original input non-editable or replace it with the sealed state;
- retain the normalized word only in closure/module memory so the local reveal control works;
- never store it in a URL, form action, DOM data attribute, browser storage, IndexedDB, cookie, cache, service worker, console message, analytics event, or error report;
- clearing/resetting must remove it from application references as far as JavaScript permits.

The debug prototype may visibly show the normalized value before sealing. The sealed state should hide it until **Reveal original word** is deliberately pressed.

### Network and browser hardening

All spectator assets must be bundled locally. Do not use a CDN, external font, remote image, analytics package, error-reporting service, API request, WebSocket, EventSource, or form submission.

Apply a spectator-specific Content Security Policy equivalent to:

```text
default-src 'self';
script-src 'self';
style-src 'self';
img-src 'self' data:;
connect-src 'none';
font-src 'self';
object-src 'none';
base-uri 'none';
form-action 'none';
frame-ancestors 'none'
```

Also set `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and `Cache-Control: no-store` for the prototype.

Do not register a service worker. The page only needs to keep working after it has loaded and the device then goes offline; it does not need to survive an offline refresh.

Use a locally bundled, permissively licensed QR-generation package. Record its name, version, license, and upstream source in a third-party notice. The QR library must receive only the already-created 64-character payload.

### Source-resistance measures that must not reduce correctness

Use a small frontend build step such as esbuild:

- separate spectator and performer entry points;
- production minification enabled;
- identifier minification enabled;
- source maps disabled;
- no license/source comments in the JavaScript bundle; preserve required notices in a separate local notice file;
- deterministic, reproducible build from a lockfile.

Do not introduce a secret key or “pepper” into spectator code. Any client-side secret is extractable and would convert a transparent commitment into security theatre.

## Performer page and recovery service

### Candidate construction

Load the existing dictionary once at server startup using the current project code, preferably `Engine.load()` so CSV parsing and aliases remain consistent.

Create candidate surfaces from:

- every `canonical_word`;
- every alias in the concept's `aliases` tuple.

Deduplicate by normalized surface. For an alias match, return both the exact matched surface and its canonical concept.

At the time of writing the expected startup diagnostics are:

```text
1210 concepts
13 aliases
1223 unique candidate surfaces
0 ambiguous surfaces
```

Do not hard-code those counts in application logic; assert only that the dictionary is non-empty and report the actual values. If one surface maps to multiple concepts after a future dictionary edit, retain every mapping and report an ambiguous match instead of silently selecting one.

### Payload parsing

The performer input is case-sensitive. Trim surrounding whitespace only.

Validate in this order:

1. input exists;
2. input is exactly 64 characters;
3. input matches `^[A-Za-z0-9_-]{64}$`;
4. Base64URL decoding succeeds;
5. decoded payload is exactly 48 bytes;
6. split bytes `0..31` as digest and `32..47` as salt.

Return specific error codes rather than one generic failure.

### Dictionary search

For every candidate surface, calculate:

```python
hashlib.sha256(salt_bytes + surface.encode("utf-8")).digest()
```

Compare the result with the expected digest. Use `hmac.compare_digest` for clean constant-time byte comparison, although the local prototype is not an authentication boundary.

Search the complete candidate set even after finding a match. This makes timing independent of dictionary order and allows ambiguous matches to be detected.

Possible results:

- exactly one match: success;
- no match: `NO_DICTIONARY_MATCH`;
- more than one mapped concept: `AMBIGUOUS_MATCH` with all matches returned.

### Timing and diagnostics

Use `time.perf_counter_ns()` on the Python side. Report separately:

- payload validation/parsing time;
- full dictionary hashing/search time;
- total server processing time;
- number of concepts loaded;
- number of candidate surfaces tested;
- number of matches.

The browser must independently report request round-trip time using `performance.now()`. Label these measurements clearly so network/UI time is not confused with the actual hash search.

On success, display:

- exact matched surface;
- canonical word;
- concept ID;
- whether the match was canonical or an alias;
- the timing and count diagnostics.

For debugging, the performer page may display the extracted salt and digest in hexadecimal. This information must never be added to the spectator page.

### Performer API

Implement a same-origin performer endpoint:

```http
POST /api/recover
Content-Type: application/json

{"payload":"<64-character Base64URL string>"}
```

Return structured JSON with a stable shape:

```json
{
  "ok": true,
  "result": {
    "matchedSurface": "CAFFE",
    "canonicalWord": "CAFFE",
    "conceptId": "caffe",
    "matchType": "canonical"
  },
  "diagnostics": {
    "conceptCount": 1210,
    "candidateCount": 1223,
    "matchCount": 1,
    "parseMs": 0.0,
    "searchMs": 0.0,
    "serverTotalMs": 0.0
  },
  "debug": {
    "digestHex": "...",
    "saltHex": "..."
  }
}
```

For errors, use a non-2xx status for malformed requests and a normal processed response for a valid payload with no dictionary match. Include a stable machine-readable `error.code` and a concise human-readable `error.message`. Never return a Python traceback to the page.

Limit request bodies to a small size, accept only JSON, and do not log payload contents.

## Suggested file layout

Cursor may adjust names slightly, but preserve the separation:

```text
prototype/
├── package.json
├── package-lock.json
├── src/
│   ├── spectator/
│   │   ├── index.html
│   │   ├── spectator.ts
│   │   └── spectator.css
│   └── performer/
│       ├── index.html
│       ├── performer.ts
│       └── performer.css
├── dist/                     # generated; only this is served
│   ├── spectator/
│   └── performer/
├── THIRD_PARTY_NOTICES.md
├── protocol.py               # payload validation and recovery logic
├── server.py                 # starts isolated local origins
└── test_protocol.py
```

Do not import `protocol.py`, dictionary data, or performer assets into the spectator frontend build.

## Implementation order

1. Implement Python payload parsing, candidate loading, and dictionary matching as pure functions.
2. Add Python tests for the fixed vector, malformed payloads, known canonical words, aliases, no-match behavior, and ambiguity handling.
3. Implement spectator normalization and binary protocol functions in TypeScript.
4. Add JavaScript tests for normalization and the fixed cross-language vector. Keep deterministic-salt hooks out of the production UI.
5. Add the spectator interface and locally bundled QR generation.
6. Add the performer API and interface with timing diagnostics.
7. Add the two-origin local runner and route-specific security headers.
8. Add the production build with minification and no source maps.
9. Run all existing tests plus the new Python and JavaScript tests.
10. Perform the manual end-to-end checklist below.

## Automated test requirements

At minimum, cover:

- NFKD accent removal and uppercase normalization;
- punctuation and whitespace removal matching Python behavior;
- empty normalized input rejection;
- fixed `CAFFE` cross-language vector;
- generated payload always has 48 decoded bytes and 64 Base64URL characters;
- the same word with two salts produces two different payloads;
- a generated known canonical word is recovered;
- `SCOLAPASTA` recovers as an alias of `COLAPASTA`;
- invalid character, wrong length, and invalid decoded-size errors;
- a correctly formed payload for a word outside the dictionary returns no match;
- complete search is performed even when the match occurs early;
- ambiguous candidate surfaces are reported using a synthetic test dictionary;
- existing `python3 tests.py` continues to pass.

## Manual acceptance checklist

Start the application and open both URLs in separate browser windows.

1. Enter `ombrello` on the spectator page.
2. Confirm the preview is `OMBRELLO`.
3. Generate the seal.
4. Confirm a QR appears and the string beneath it contains exactly 64 characters.
5. Copy the string and paste it into the performer page.
6. Recover it and confirm `OMBRELLO` is shown with parse, search, server-total, and round-trip times.
7. Repeat `OMBRELLO`; confirm the second payload differs because the salt changed.
8. Test `caffè`; confirm the recovered surface is `CAFFE`.
9. Test alias `scolapasta`; confirm matched surface `SCOLAPASTA`, canonical `COLAPASTA`, match type `alias`.
10. Change one character in a valid payload; confirm either no match or a validation error, never a false word.
11. Test a word not in the dictionary and confirm `NO_DICTIONARY_MATCH`.
12. After loading the spectator page, take the browser offline and confirm generation, QR display, copying, and reveal still work.
13. Inspect the spectator Network panel while generating: there must be zero requests.
14. Inspect local/session storage, IndexedDB, cookies, and service workers: the word and payload must not be present.
15. Search the built spectator bundle for `/api/recover`, dictionary words, `italian_words.csv`, performer labels, and recovery functions: none may be present.
16. Confirm no `.map` files are generated or served.

## Documentation and run commands

Add a short README section with exact commands. The intended flow should be approximately:

```bash
cd prototype
npm ci
npm test
npm run build
cd ..
python3 -m unittest prototype.test_protocol
python3 tests.py
python3 prototype/server.py
```

The server should print both local URLs and dictionary startup counts without printing secrets or full payloads.

## Explicitly out of scope for this prototype

- camera-based QR scanning on the performer side;
- production hosting, TLS certificates, authentication, or remote sessions;
- expanding or cleaning the Italian dictionary;
- changing the existing probabilistic mentalism engine;
- transmitting the word or payload from the spectator page;
- production visual design;
- attempts to make browser code cryptographically unrecoverable;
- slow password hashing, encryption, public/private keys, or a client-side secret pepper.

## Completion definition

The prototype is complete only when:

- both pages work locally through the documented command;
- the fixed cross-language vector passes;
- a fresh random seal generated by the spectator page recovers the correct canonical word or alias on the performer page;
- timing and all required errors are visible;
- the spectator page makes no network request during sealing and stores no word or payload persistently;
- the built spectator assets contain no performer code or dictionary data;
- all old and new automated tests pass.

