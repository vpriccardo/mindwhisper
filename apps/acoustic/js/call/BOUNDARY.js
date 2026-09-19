/**
 * CALL CHANNEL BOUNDARY
 *
 * This directory (and tx2.html / rx2.html / audio/rx2-worklet.js) is owned by
 * the call-path agents.
 *
 * Do NOT modify room-v1 files from here:
 *   tx.html, rx.html, js/tx.js, js/rx.js, js/tx-engine.js,
 *   js/ambient-profiles.js, js/watermark.js, js/rx-decoder.js,
 *   audio/rx-worklet.js
 *
 * Shared read-only protocol helpers live in js/protocol.js (CRC/Hamming/packing).
 * Prefer additive call-* exports; avoid changing room-v1 defaults or frame timing.
 */
export const CALL_CHANNEL_OWNER = 'call-v1';
