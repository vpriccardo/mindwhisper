import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AcquisitionController } from "./.bundle/acquisition.mjs";

const P1 =
  "rS_GktVRvtFjs0mMobtTmzR3vi1a9htazNnAmtPN2jIAAQIDBAUGBwgJCgsMDQ4P";
const P2 =
  "XSHy_HNIbO4Kp8PNNgwB8TX-suBZKMiEB7d-9JZmzz0QERITFBUWFxgZGhscHR4f";

describe("AcquisitionController", () => {
  it("first valid payload locks and triggers exactly one recover", () => {
    const ac = new AcquisitionController();
    const calls = [];
    ac.onRecover((p, g) => calls.push({ p, g }));
    ac.beginScanning();
    const r = ac.onRecognized({ text: P1, format: "QR_CODE", nowMs: 1000 });
    assert.equal(r, "locked");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].p, P1);
    assert.equal(ac.snapshot.recoverCalls, 1);
    assert.equal(ac.snapshot.state, "RECOVERING");
  });

  it("repeated equal detections do not retrigger recovery", () => {
    const ac = new AcquisitionController();
    let calls = 0;
    ac.onRecover(() => {
      calls += 1;
    });
    ac.onRecognized({ text: P1, format: "AZTEC", nowMs: 1 });
    ac.onRecognized({ text: P1, format: "AZTEC", nowMs: 50 });
    ac.onRecognized({ text: P1, format: "AZTEC", nowMs: 100 });
    assert.equal(calls, 1);
    assert.equal(ac.snapshot.recoverCalls, 1);
  });

  it("a different valid payload replaces the lock and triggers one new recovery", () => {
    const ac = new AcquisitionController();
    const calls = [];
    ac.onRecover((p, g) => calls.push({ p, g }));
    ac.onRecognized({ text: P1, format: "QR_CODE", nowMs: 1 });
    ac.onRecognized({ text: P2, format: "AZTEC", nowMs: 50 });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].p, P1);
    assert.equal(calls[1].p, P2);
    assert.equal(ac.snapshot.lockedPayload, P2);
    assert.equal(ac.snapshot.recoverCalls, 2);
  });

  it("ignores invalid optical text without locking", () => {
    const ac = new AcquisitionController();
    let calls = 0;
    ac.onRecover(() => {
      calls += 1;
    });
    const r = ac.onRecognized({
      text: "https://example.com/foo",
      format: "QR_CODE",
      nowMs: 1,
    });
    assert.equal(r, "ignored");
    assert.equal(calls, 0);
    assert.equal(ac.snapshot.debug.invalidRecognized, 1);
    assert.equal(ac.snapshot.lockedPayload, null);
  });

  it("stale recovery responses cannot overwrite a newer result", () => {
    const ac = new AcquisitionController();
    ac.onRecognized({ text: P1, format: "QR_CODE", nowMs: 1 });
    const gen1 = ac.snapshot.generation;
    ac.onRecognized({ text: P2, format: "QR_CODE", nowMs: 20 });
    const gen2 = ac.snapshot.generation;
    assert.ok(gen2 > gen1);
    assert.equal(ac.markRecovered(gen1), false);
    assert.equal(ac.markRecovered(gen2), true);
    assert.equal(ac.snapshot.state, "RECOVERED");
    assert.equal(ac.snapshot.lockedPayload, P2);
  });

  it("no-match and API-error states retain the locked payload", () => {
    const ac = new AcquisitionController();
    ac.onRecognized({ text: P1, format: "QR_CODE", nowMs: 1 });
    const gen = ac.snapshot.generation;
    ac.markNoMatch(gen, "No dictionary match");
    assert.equal(ac.snapshot.lockedPayload, P1);
    assert.equal(ac.snapshot.state, "RECOVERY_ERROR");
    ac.markRecoveryError(gen, "network down");
    assert.equal(ac.snapshot.lockedPayload, P1);
  });

  it("stopping camera stops all stream tracks (mock)", () => {
    const stopped = [];
    const track = {
      stop() {
        stopped.push(1);
      },
      kind: "video",
    };
    const stream = { getTracks: () => [track, track] };
    for (const t of stream.getTracks()) t.stop();
    assert.equal(stopped.length, 2);
  });

  it("clear then same payload does not relock until absent cooldown", () => {
    const ac = new AcquisitionController({ clearCooldownMs: 500 });
    let calls = 0;
    ac.onRecover(() => {
      calls += 1;
    });
    ac.onRecognized({ text: P1, format: "QR_CODE", nowMs: 0 });
    assert.equal(calls, 1);
    ac.clearLockedResult(10);
    assert.equal(
      ac.onRecognized({ text: P1, format: "QR_CODE", nowMs: 20 }),
      "ignored",
    );
    assert.equal(calls, 1);
    ac.noteAbsence(100);
    ac.noteAbsence(650);
    assert.equal(
      ac.onRecognized({ text: P1, format: "QR_CODE", nowMs: 700 }),
      "locked",
    );
    assert.equal(calls, 2);
  });

  it("lockFromHiddenEnvelope skips HTTP recover and uses HIDDEN_ENVELOPE_V1", () => {
    const ac = new AcquisitionController();
    let calls = 0;
    ac.onRecover(() => {
      calls += 1;
    });
    const g1 = ac.lockFromHiddenEnvelope({
      canonicalWord: "LETTO",
      tokenHex: "2a60a5363d6eb3",
      nowMs: 10,
    });
    assert.equal(g1, 1);
    assert.equal(calls, 0);
    assert.equal(ac.snapshot.opticalFormat, "HIDDEN_ENVELOPE_V1");
    assert.equal(ac.snapshot.state, "RECOVERED");
    const g2 = ac.lockFromHiddenEnvelope({
      canonicalWord: "LETTO",
      tokenHex: "2a60a5363d6eb3",
      nowMs: 20,
    });
    assert.equal(g2, 1);
    ac.clearLockedResult(30);
    const g3 = ac.lockFromHiddenEnvelope({
      canonicalWord: "CAFFE",
      tokenHex: "aabbccddeeff00",
      nowMs: 40,
    });
    assert.equal(g3, 2);
  });

  it("stale generation cannot overwrite a newer hidden lock", () => {
    const ac = new AcquisitionController();
    const g1 = ac.lockFromHiddenEnvelope({
      canonicalWord: "LETTO",
      tokenHex: "11111111111111",
      nowMs: 1,
    });
    const g2 = ac.lockFromHiddenEnvelope({
      canonicalWord: "CAFFE",
      tokenHex: "22222222222222",
      nowMs: 2,
    });
    assert.equal(g2, g1 + 1);
    assert.equal(ac.isCurrentGeneration(g1), false);
    assert.equal(ac.isCurrentGeneration(g2), true);
  });
});
