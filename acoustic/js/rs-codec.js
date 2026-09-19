/**
 * Reed-Solomon codec over GF(256).
 *
 * primitive polynomial = 0x11D
 * primitive element    = 0x02
 *
 * Implements a systematic shortened RS(255, k) code: for a given number of
 * data bytes and parity bytes (parityBytes = nsym), the encoder appends
 * `nsym` parity bytes so that codeword = data || parity is a valid codeword
 * of the (conceptually 255-symbol, left-zero-padded) RS code.
 *
 * The decoder supports simultaneous errors and erasures using:
 *   - syndrome calculation
 *   - Forney syndrome shift (to remove known erasure contributions before BM)
 *   - Berlekamp–Massey (seeded with the erasure locator polynomial)
 *   - Chien search (root finding over all codeword positions)
 *   - Forney algorithm (error/erasure magnitude computation)
 *
 * This mirrors the well-known "Reed-Solomon codes for coders" reference
 * algorithm (the same algorithm underlying the Python `reedsolo` library),
 * reimplemented here with no runtime dependency. Test vectors were
 * cross-checked against Python `reedsolo` during development (dev-only,
 * see run-rs-tests.mjs comments) — it is NOT a runtime dependency.
 *
 * Byte/array convention: index 0 is the FIRST transmitted symbol (most
 * significant term of the message polynomial). This matches the protocol-v2
 * framing: codeword = header|message|CRC (data) || parity.
 */

export const RS_PRIMITIVE_POLY = 0x11d;
export const RS_PRIMITIVE_ELEMENT = 0x02;
export const RS_FIELD_SIZE = 256;
export const RS_FIELD_CARDINALITY_MINUS_1 = 255;

// ---------------------------------------------------------------------------
// GF(256) tables
// ---------------------------------------------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

function gfMulNoLUT(a, b, prim) {
  let x = a;
  let y = b;
  let r = 0;
  while (y) {
    if (y & 1) r ^= x;
    y >>>= 1;
    x <<= 1;
    if (x & 0x100) x ^= prim;
  }
  return r & 0xff;
}

function initTables(prim = RS_PRIMITIVE_POLY, generator = RS_PRIMITIVE_ELEMENT) {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x = gfMulNoLUT(x, generator, prim);
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
  // GF_LOG[0] is undefined mathematically; leave as 0 (never dereferenced
  // for value 0 because all gf* helpers special-case zero explicitly).
}

initTables();

export function gfAdd(a, b) {
  return (a ^ b) & 0xff;
}

export const gfSub = gfAdd; // characteristic 2

export function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

export function gfDiv(a, b) {
  if (b === 0) throw new Error('Division by zero in GF(256)');
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255];
}

export function gfPow(a, power) {
  if (a === 0) return power === 0 ? 1 : 0;
  let p = (GF_LOG[a] * power) % 255;
  if (p < 0) p += 255;
  return GF_EXP[p];
}

export function gfInverse(a) {
  if (a === 0) throw new Error('No inverse for 0 in GF(256)');
  return GF_EXP[255 - GF_LOG[a]];
}

// ---------------------------------------------------------------------------
// GF(256) polynomial helpers (array index 0 = highest-degree coefficient)
// ---------------------------------------------------------------------------

export function gfPolyMul(p, q) {
  const r = new Uint8Array(p.length + q.length - 1);
  for (let j = 0; j < q.length; j++) {
    if (q[j] === 0) continue;
    for (let i = 0; i < p.length; i++) {
      if (p[i] === 0) continue;
      r[i + j] ^= gfMul(p[i], q[j]);
    }
  }
  return r;
}

export function gfPolyAdd(p, q) {
  const len = Math.max(p.length, q.length);
  const r = new Uint8Array(len);
  for (let i = 0; i < p.length; i++) r[i + len - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + len - q.length] ^= q[i];
  return r;
}

export function gfPolyScale(p, x) {
  const r = new Uint8Array(p.length);
  for (let i = 0; i < p.length; i++) r[i] = gfMul(p[i], x);
  return r;
}

/** Horner evaluation of polynomial p at x. */
export function gfPolyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) {
    y = gfMul(y, x) ^ p[i];
  }
  return y & 0xff;
}

/** Polynomial long division; returns { quotient, remainder }. */
export function gfPolyDiv(dividend, divisor) {
  const out = Uint8Array.from(dividend);
  for (let i = 0; i < dividend.length - (divisor.length - 1); i++) {
    const coef = out[i];
    if (coef !== 0) {
      for (let j = 1; j < divisor.length; j++) {
        if (divisor[j] !== 0) {
          out[i + j] ^= gfMul(divisor[j], coef);
        }
      }
    }
  }
  const sep = divisor.length - 1;
  return {
    quotient: out.slice(0, out.length - sep),
    remainder: out.slice(out.length - sep),
  };
}

// ---------------------------------------------------------------------------
// Generator polynomial
// ---------------------------------------------------------------------------

const generatorCache = new Map();

/** g(x) = Π_{i=0}^{nsym-1} (x - α^i), roots α^0 .. α^(nsym-1) */
export function rsGeneratorPoly(nsym) {
  const cached = generatorCache.get(nsym);
  if (cached) return cached;
  let g = new Uint8Array([1]);
  for (let i = 0; i < nsym; i++) {
    g = gfPolyMul(g, new Uint8Array([1, GF_EXP[i]]));
  }
  generatorCache.set(nsym, g);
  return g;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Systematic RS encode. Returns Uint8Array(dataBytes.length + nsym) =
 * dataBytes followed by nsym parity bytes.
 */
export function rsEncode(dataBytes, nsym) {
  if (nsym <= 0) throw new Error('nsym must be > 0');
  if (dataBytes.length + nsym > 255) {
    throw new Error(
      `RS codeword too long: ${dataBytes.length}+${nsym} > 255`
    );
  }
  const gen = rsGeneratorPoly(nsym);
  const msgOut = new Uint8Array(dataBytes.length + nsym);
  msgOut.set(dataBytes, 0);
  // LFSR-style polynomial division: msgOut[data.length:] becomes remainder.
  for (let i = 0; i < dataBytes.length; i++) {
    const coef = msgOut[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msgOut[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  // Restore original data bytes (loop above scribbles over msgOut[0..data.length)
  // with a value that happens to equal the *original* data because gen[0] === 1
  // -- but be explicit/defensive rather than relying on that subtlety).
  msgOut.set(dataBytes, 0);
  return msgOut;
}

// ---------------------------------------------------------------------------
// Decoding — syndromes, Berlekamp–Massey (+erasures), Chien, Forney
// ---------------------------------------------------------------------------

export class ReedSolomonError extends Error {}

/** synd[0]=0 (index padding for polynomial form), synd[1..nsym] = S_1..S_nsym */
export function rsCalcSyndromes(msg, nsym) {
  const synd = new Uint8Array(nsym + 1);
  for (let i = 0; i < nsym; i++) {
    synd[i + 1] = gfPolyEval(msg, GF_EXP[i]);
  }
  return synd;
}

function isAllZero(arr) {
  for (let i = 0; i < arr.length; i++) if (arr[i] !== 0) return false;
  return true;
}

/** Errata (erasure) locator polynomial from 0-indexed positions in msg. */
export function rsFindErrataLocator(coefPositions) {
  let eLoc = new Uint8Array([1]);
  for (const i of coefPositions) {
    eLoc = gfPolyMul(eLoc, gfPolyAdd(new Uint8Array([1]), new Uint8Array([GF_EXP[i % 255], 0])));
  }
  return eLoc;
}

/** Omega(x) = (synd * errLoc) mod x^(nsym+1), synd/errLoc given reversed (poly form). */
export function rsFindErrorEvaluator(syndRev, errLocRev, nsym) {
  const product = gfPolyMul(syndRev, errLocRev);
  const divisor = new Uint8Array(nsym + 2);
  divisor[0] = 1;
  const { remainder } = gfPolyDiv(product, divisor);
  return remainder;
}

/**
 * Berlekamp–Massey error locator, optionally seeded with an erasure locator.
 * `synd` full syndrome array with synd[0]=0 padding (length nsym+1).
 */
export function rsFindErrorLocator(synd, nsym, eraseLoc = null, eraseCount = 0) {
  let errLoc = eraseLoc ? Uint8Array.from(eraseLoc) : new Uint8Array([1]);
  let oldLoc = eraseLoc ? Uint8Array.from(eraseLoc) : new Uint8Array([1]);
  const syndShift = synd.length > nsym ? synd.length - nsym : 0;

  for (let i = 0; i < nsym - eraseCount; i++) {
    const K = eraseLoc ? eraseCount + i + syndShift : i + syndShift;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= gfMul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    }
    // old_loc = old_loc shifted by one (append 0)
    const shiftedOld = new Uint8Array(oldLoc.length + 1);
    shiftedOld.set(oldLoc, 0);
    oldLoc = shiftedOld;
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = gfPolyScale(oldLoc, delta);
        oldLoc = gfPolyScale(errLoc, gfInverse(delta));
        errLoc = newLoc;
      }
      errLoc = gfPolyAdd(errLoc, gfPolyScale(oldLoc, delta));
    }
  }

  // Strip leading zero coefficients
  let start = 0;
  while (start < errLoc.length - 1 && errLoc[start] === 0) start++;
  errLoc = errLoc.slice(start);

  const errs = errLoc.length - 1;
  if ((errs - eraseCount) * 2 + eraseCount > nsym) {
    throw new ReedSolomonError('Too many errors to correct');
  }
  return errLoc;
}

/** Chien search: roots of errLoc (given MSB-first) → 0-indexed error positions in msg. */
export function rsFindErrors(errLocMsbFirst, msgLength) {
  const errs = errLocMsbFirst.length - 1;
  const errLocRev = Uint8Array.from(errLocMsbFirst).reverse();
  const errPos = [];
  for (let i = 0; i < msgLength; i++) {
    if (gfPolyEval(errLocRev, GF_EXP[i]) === 0) {
      errPos.push(msgLength - 1 - i);
    }
  }
  if (errPos.length !== errs) {
    throw new ReedSolomonError(
      'Chien search found wrong number of roots (uncorrectable)'
    );
  }
  return errPos;
}

/** Forney syndrome shift — removes known erasure influence prior to BM. */
export function rsForneySyndromes(synd, positions, msgLength) {
  const erasePosRev = positions.map((p) => msgLength - 1 - p);
  let fsynd = Array.from(synd.slice(1));
  for (let i = 0; i < erasePosRev.length; i++) {
    const x = GF_EXP[erasePosRev[i]];
    for (let j = 0; j < fsynd.length - 1; j++) {
      fsynd[j] = gfMul(fsynd[j], x) ^ fsynd[j + 1];
    }
    fsynd.pop();
  }
  return Uint8Array.from(fsynd);
}

/** Forney algorithm: compute error/erasure magnitudes and correct msg in place (copy). */
export function rsCorrectErrata(msgIn, synd, errPos) {
  const n = msgIn.length;
  const coefPos = errPos.map((p) => n - 1 - p);
  const errLoc = rsFindErrataLocator(coefPos);
  const syndRev = Uint8Array.from(synd).reverse();
  // NOTE: errLoc is passed AS-IS (not reversed) here — only synd is reversed.
  const errEvalRev = rsFindErrorEvaluator(syndRev, errLoc, errLoc.length - 1);
  const errEval = Uint8Array.from(errEvalRev).reverse();

  const X = coefPos.map((cp) => {
    const l = 255 - cp;
    return gfPow(2, -l);
  });

  const E = new Uint8Array(n);
  for (let i = 0; i < X.length; i++) {
    const Xi = X[i];
    const XiInv = gfInverse(Xi);
    let errLocPrime = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) {
        errLocPrime = gfMul(errLocPrime, gfAdd(1, gfMul(XiInv, X[j])));
      }
    }
    if (errLocPrime === 0) {
      throw new ReedSolomonError('Could not compute error magnitude (division by 0)');
    }
    const errEvalRevPoly = Uint8Array.from(errEval).reverse();
    let y = gfPolyEval(errEvalRevPoly, XiInv);
    y = gfMul(gfPow(Xi, 1), y);
    const magnitude = gfDiv(y, errLocPrime);
    E[errPos[i]] = magnitude;
  }

  return gfPolyAdd(msgIn, E).slice(-n);
}

/**
 * Decode a received systematic RS codeword (data || parity), correcting up
 * to floor(nsym/2) pure errors, or more when accurate erasure positions are
 * supplied (2*errors + erasures <= nsym).
 *
 * @param {Uint8Array|number[]} received full codeword (data+parity)
 * @param {number} nsym parity byte count
 * @param {number[]} erasurePositions 0-indexed positions (into `received`) that are known-unreliable
 * @returns {{ ok: boolean, data: Uint8Array, codeword: Uint8Array, errorCount: number, erasureCount: number, correctedPositions: number[], error?: string }}
 */
export function rsDecode(received, nsym, erasurePositions = []) {
  const n = received.length;
  if (n > 255) {
    return { ok: false, error: 'Codeword too long (>255)', errorCount: 0, erasureCount: 0 };
  }
  if (erasurePositions.length > nsym) {
    return {
      ok: false,
      error: 'Too many erasures to correct',
      errorCount: 0,
      erasureCount: erasurePositions.length,
    };
  }

  const msgOut = Uint8Array.from(received);
  const erasePos = Array.from(new Set(erasurePositions)).filter(
    (p) => p >= 0 && p < n
  );
  for (const p of erasePos) msgOut[p] = 0;

  const synd = rsCalcSyndromes(msgOut, nsym);
  if (isAllZero(synd)) {
    return {
      ok: true,
      data: msgOut.slice(0, n - nsym),
      codeword: msgOut,
      errorCount: 0,
      erasureCount: erasePos.length,
      correctedPositions: [],
    };
  }

  try {
    // Forney syndrome shift hides the known erasures from Berlekamp–Massey
    // so BM only needs to locate the *additional*, unknown errors.
    const fsynd = rsForneySyndromes(synd, erasePos, n);
    const errLoc = rsFindErrorLocator(fsynd, nsym, null, erasePos.length);
    const errPosOnly = rsFindErrors(errLoc, n);
    const allErrPos = erasePos.concat(errPosOnly);
    // Combine known erasures + newly located errors; magnitudes computed
    // from the true (non-shifted) syndrome via Forney's algorithm.
    const corrected = rsCorrectErrata(msgOut, synd, allErrPos);
    const verifySynd = rsCalcSyndromes(corrected, nsym);
    if (!isAllZero(verifySynd)) {
      return {
        ok: false,
        error: 'Could not correct message (residual syndrome nonzero)',
        errorCount: errPosOnly.length,
        erasureCount: erasePos.length,
      };
    }
    return {
      ok: true,
      data: corrected.slice(0, n - nsym),
      codeword: corrected,
      errorCount: errPosOnly.length,
      erasureCount: erasePos.length,
      correctedPositions: allErrPos,
    };
  } catch (e) {
    return {
      ok: false,
      error: e && e.message ? e.message : String(e),
      errorCount: -1,
      erasureCount: erasePos.length,
    };
  }
}

export const RS_CONSTANTS = Object.freeze({
  RS_PRIMITIVE_POLY,
  RS_PRIMITIVE_ELEMENT,
  RS_FIELD_SIZE,
});
