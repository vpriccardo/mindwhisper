/**
 * Microphone → AudioWorklet → Decoder Worker orchestration.
 */

import { HIDDEN_DICTIONARY_META } from "../../generated/hiddenDictionaryMeta";
import type {
  AudioDiagnostics,
  AudioLockInfo,
  AudioPayloadInfo,
  AudioScanState,
  AudioWorkerOutMessage,
} from "./types";

export type AudioScannerCallbacks = {
  onStatus?: (state: AudioScanState) => void;
  onLock?: (info: AudioLockInfo) => void;
  onPayload?: (info: AudioPayloadInfo) => void;
  onDiagnostics?: (diag: AudioDiagnostics) => void;
  onError?: (message: string) => void;
  onLevel?: (dbfs: number) => void;
};

export type AudioScannerHandle = {
  stop: () => void;
  reset: () => void;
  decodeWav: (samples: Float32Array, sampleRate: number) => void;
  getTrackSettings: () => Record<string, unknown> | null;
};

export async function startAudioScanner(input: {
  deviceId?: string;
  workerUrl: string;
  workletUrl: string;
  digestTableUrl: string;
  callbacks: AudioScannerCallbacks;
}): Promise<AudioScannerHandle> {
  if (!window.isSecureContext) {
    throw new Error(
      "Microphone requires a secure context (https or http://127.0.0.1 / localhost).",
    );
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia is not available in this browser.");
  }

  let stream: MediaStream;
  const baseAudio: MediaTrackConstraints = {
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
  };
  if (input.deviceId) baseAudio.deviceId = { exact: input.deviceId };

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        ...baseAudio,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        ...baseAudio,
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        autoGainControl: { ideal: false },
      },
    });
  }
  const track = stream.getAudioTracks()[0];
  if (track) {
    try {
      await track.applyConstraints({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      } as MediaTrackConstraints);
    } catch {
      /* browser may ignore */
    }
  }
  const settings = (track?.getSettings?.() ?? {}) as Record<string, unknown>;

  const ctx = new AudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);

  await ctx.audioWorklet.addModule(input.workletUrl);
  const worklet = new AudioWorkletNode(ctx, "audio-capture-processor");
  source.connect(worklet);
  const silent = ctx.createGain();
  silent.gain.value = 0;
  worklet.connect(silent);
  silent.connect(ctx.destination);

  const worker = new Worker(input.workerUrl);
  const digestRes = await fetch(input.digestTableUrl, { cache: "no-store" });
  if (!digestRes.ok) throw new Error("Failed to load digest table.");
  const digestBuf = await digestRes.arrayBuffer();

  const ready = new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(
      () => reject(new Error("Audio decoder worker init timeout")),
      15_000,
    );
    const onMsg = (ev: MessageEvent<AudioWorkerOutMessage>) => {
      if (ev.data.type === "ready") {
        window.clearTimeout(t);
        worker.removeEventListener("message", onMsg);
        resolve();
      } else if (ev.data.type === "error") {
        window.clearTimeout(t);
        worker.removeEventListener("message", onMsg);
        reject(new Error(ev.data.message));
      }
    };
    worker.addEventListener("message", onMsg);
  });

  worker.postMessage(
    {
      type: "init",
      digestTable: digestBuf,
      surfacesJson: JSON.stringify(HIDDEN_DICTIONARY_META.surfaces),
    },
    [digestBuf],
  );

  await ready;

  worker.onmessage = (ev: MessageEvent<AudioWorkerOutMessage>) => {
    const msg = ev.data;
    if (msg.type === "status") input.callbacks.onStatus?.(msg.state);
    else if (msg.type === "payload") {
      input.callbacks.onPayload?.(msg.info);
      input.callbacks.onDiagnostics?.(msg.diag);
    } else if (msg.type === "lock") {
      input.callbacks.onLock?.(msg.info);
      input.callbacks.onDiagnostics?.(msg.diag);
    } else if (msg.type === "diag") {
      // Annotate live track processing flags so AEC issues are visible.
      msg.diag.echoCancellation = settings.echoCancellation as boolean | string;
      msg.diag.noiseSuppression = settings.noiseSuppression as boolean | string;
      msg.diag.autoGainControl = settings.autoGainControl as boolean | string;
      msg.diag.trackSettings = { ...settings };
      input.callbacks.onDiagnostics?.(msg.diag);
      input.callbacks.onLevel?.(msg.diag.inputDbfs);
    } else if (msg.type === "error") {
      input.callbacks.onError?.(msg.message);
    }
  };

  worklet.port.onmessage = (ev: MessageEvent) => {
    const data = ev.data as {
      type: string;
      samples?: Float32Array;
      count?: number;
    };
    if (data.type === "pcm" && data.samples) {
      worker.postMessage(
        {
          type: "pcm",
          samples: data.samples,
          sampleRate: ctx.sampleRate,
          tMs: performance.now(),
        },
        [data.samples.buffer],
      );
    }
  };

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    worker.postMessage({ type: "stop" });
    try {
      worklet.port.onmessage = null;
      worklet.disconnect();
      source.disconnect();
    } catch {
      /* */
    }
    stream.getTracks().forEach((t) => t.stop());
    worker.terminate();
    void ctx.close();
  };

  return {
    stop,
    reset: () => worker.postMessage({ type: "reset" }),
    decodeWav: (samples, sampleRate) => {
      worker.postMessage({ type: "wav", samples, sampleRate });
    },
    getTrackSettings: () => ({ ...settings }),
  };
}

export async function listAudioInputDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput");
}
