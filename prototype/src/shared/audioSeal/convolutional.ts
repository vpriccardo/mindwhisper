/**
 * K=7 rate-1/2 convolutional codec, generators 171/133 octal.
 * Output order per input bit: g171 then g133. Soft Viterbi decoder.
 */

import {
  CONV_G0_OCTAL,
  CONV_G1_OCTAL,
  CONV_INPUT_BITS,
  CONV_K,
  CODED_BITS,
  PACKET_BITS,
  TAIL_BITS,
} from "./constants";

const NUM_STATES = 1 << (CONV_K - 1); // 64
const G0 = CONV_G0_OCTAL;
const G1 = CONV_G1_OCTAL;

function parity(x: number): number {
  let v = x & 0x7f;
  v ^= v >>> 4;
  v ^= v >>> 2;
  v ^= v >>> 1;
  return v & 1;
}

function outputsFor(state: number, bit: number): [number, number] {
  const window = ((bit & 1) << (CONV_K - 1)) | (state & (NUM_STATES - 1));
  return [parity(window & G0), parity(window & G1)];
}

function nextState(state: number, bit: number): number {
  const window = ((bit & 1) << (CONV_K - 1)) | (state & (NUM_STATES - 1));
  return window >>> 1;
}

/** Encode PACKET_BITS (+ optional already-included zeros) → CODED_BITS. */
export function convEncode(bits: Int8Array): Int8Array {
  if (bits.length !== PACKET_BITS && bits.length !== CONV_INPUT_BITS) {
    throw new Error(`Expected ${PACKET_BITS} or ${CONV_INPUT_BITS} input bits.`);
  }
  const input = new Int8Array(CONV_INPUT_BITS);
  input.set(bits.subarray(0, Math.min(bits.length, PACKET_BITS)));
  // Tail zeros already zero-initialized.

  const out = new Int8Array(CODED_BITS);
  let state = 0;
  let o = 0;
  for (let i = 0; i < CONV_INPUT_BITS; i++) {
    const bit = input[i]! & 1;
    const [a, b] = outputsFor(state, bit);
    out[o++] = a;
    out[o++] = b;
    state = nextState(state, bit);
  }
  if (state !== 0) {
    throw new Error("Encoder failed to terminate in zero state.");
  }
  return out;
}

export type ViterbiResult = {
  bits: Int8Array; // PACKET_BITS (tail stripped)
  bestMetric: number;
  secondMetric: number;
  margin: number;
  finalState: number;
  tailOk: boolean;
};

/**
 * Soft Viterbi. soft[i] > 0 favors coded bit 1.
 * Metrics accumulate agreement: soft * (2*bit - 1).
 */
export function convDecodeSoft(soft: Float64Array): ViterbiResult {
  if (soft.length !== CODED_BITS) {
    throw new Error(`Expected ${CODED_BITS} soft values.`);
  }

  const NEG = -1e300;
  let prev = new Float64Array(NUM_STATES);
  let curr = new Float64Array(NUM_STATES);
  prev.fill(NEG);
  prev[0] = 0;

  // survivors[step][state] = previous state + input bit packed
  const survivors = new Int32Array(CONV_INPUT_BITS * NUM_STATES);

  for (let step = 0; step < CONV_INPUT_BITS; step++) {
    curr.fill(NEG);
    const s0 = soft[step * 2]!;
    const s1 = soft[step * 2 + 1]!;
    for (let state = 0; state < NUM_STATES; state++) {
      const pm = prev[state]!;
      if (pm <= NEG / 2) continue;
      for (let bit = 0; bit < 2; bit++) {
        const [a, b] = outputsFor(state, bit);
        const branch =
          s0 * (a === 1 ? 1 : -1) + s1 * (b === 1 ? 1 : -1);
        const ns = nextState(state, bit);
        const cand = pm + branch;
        if (cand > curr[ns]!) {
          curr[ns] = cand;
          survivors[step * NUM_STATES + ns] = (state << 1) | bit;
        }
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  // Rank final metrics; prefer state 0 due to tail.
  let bestState = 0;
  let bestMetric = prev[0]!;
  let secondMetric = NEG;
  for (let s = 1; s < NUM_STATES; s++) {
    const m = prev[s]!;
    if (m > bestMetric) {
      secondMetric = bestMetric;
      bestMetric = m;
      bestState = s;
    } else if (m > secondMetric) {
      secondMetric = m;
    }
  }

  // Force traceback from state 0 (tail bits).
  const decodeState = 0;
  const decoded = new Int8Array(CONV_INPUT_BITS);
  let st = decodeState;
  for (let step = CONV_INPUT_BITS - 1; step >= 0; step--) {
    const packed = survivors[step * NUM_STATES + st]!;
    const bit = packed & 1;
    const prevState = packed >>> 1;
    decoded[step] = bit;
    st = prevState;
  }

  let tailOk = true;
  for (let i = 0; i < TAIL_BITS; i++) {
    if (decoded[PACKET_BITS + i] !== 0) {
      tailOk = false;
      break;
    }
  }

  const bits = decoded.subarray(0, PACKET_BITS);
  const margin = bestMetric - (secondMetric <= NEG / 2 ? bestMetric : secondMetric);

  return {
    bits: Int8Array.from(bits),
    bestMetric: prev[0]!,
    secondMetric: secondMetric <= NEG / 2 ? prev[0]! : secondMetric,
    margin: prev[0]! - (Number.isFinite(secondMetric) && secondMetric > NEG / 2
      ? secondMetric
      : prev[0]!),
    finalState: 0,
    tailOk,
  };
}

/** Hard-decision convenience for tests. */
export function convDecodeHard(coded: Int8Array): ViterbiResult {
  const soft = new Float64Array(coded.length);
  for (let i = 0; i < coded.length; i++) {
    soft[i] = coded[i]! === 1 ? 1 : -1;
  }
  return convDecodeSoft(soft);
}

export { outputsFor as _outputsFor, nextState as _nextState, NUM_STATES as _NUM_STATES };
