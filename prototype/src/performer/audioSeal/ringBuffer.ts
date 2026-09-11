/**
 * Bounded circular buffer of canonical mono samples.
 */

import { RING_BUFFER_SAMPLES } from "../../shared/audioSeal/constants";

export class MonoRingBuffer {
  readonly capacity: number;
  private buf: Float32Array;
  private writePos = 0;
  private filled = 0;
  /** Samples written after the ring was already full (normal for a live stream). */
  samplesAfterFull = 0;
  /** True once capacity has been reached at least once. */
  everFull = false;

  constructor(capacity = RING_BUFFER_SAMPLES) {
    this.capacity = capacity;
    this.buf = new Float32Array(capacity);
  }

  get length(): number {
    return this.filled;
  }

  /** 0–1 fill ratio. */
  get fillRatio(): number {
    return this.filled / this.capacity;
  }

  clear(): void {
    this.buf.fill(0);
    this.writePos = 0;
    this.filled = 0;
    this.samplesAfterFull = 0;
    this.everFull = false;
  }

  push(chunk: Float32Array): void {
    for (let i = 0; i < chunk.length; i++) {
      this.buf[this.writePos] = chunk[i]!;
      this.writePos = (this.writePos + 1) % this.capacity;
      if (this.filled < this.capacity) this.filled++;
      else {
        this.everFull = true;
        this.samplesAfterFull++;
      }
    }
  }

  /** Snapshot the most recent `n` samples (oldest→newest). */
  snapshotTail(n: number): Float32Array {
    const count = Math.min(n, this.filled);
    const out = new Float32Array(count);
    const start = (this.writePos - count + this.capacity) % this.capacity;
    for (let i = 0; i < count; i++) {
      out[i] = this.buf[(start + i) % this.capacity]!;
    }
    return out;
  }

  /** Absolute index from oldest sample currently stored. */
  snapshotRange(startFromOldest: number, count: number): Float32Array {
    const avail = this.filled;
    if (startFromOldest < 0 || count <= 0 || startFromOldest >= avail) {
      return new Float32Array(0);
    }
    const n = Math.min(count, avail - startFromOldest);
    const out = new Float32Array(n);
    const oldestPos =
      this.filled < this.capacity
        ? 0
        : this.writePos;
    for (let i = 0; i < n; i++) {
      out[i] = this.buf[(oldestPos + startFromOldest + i) % this.capacity]!;
    }
    return out;
  }
}
