/**
 * Microphone → AudioWorklet → Decoder Worker orchestration.
 *
 * iPhone Safari notes:
 * - Create AudioContext in the user-gesture turn, before awaiting getUserMedia.
 * - Do not route the mic graph to speakers (that enables voice-processing/AEC).
 * - 44.1 kHz capture is normal; the worker streaming-resamples to 48 kHz.
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

type AudioCtor = typeof AudioContext;

function audioContextCtor(): AudioCtor {
  const w = window as unknown as {
    AudioContext?: AudioCtor;
    webkitAudioContext?: AudioCtor;
  };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) throw new Error("Web Audio is not available in this browser.");
  return Ctor;
}

function createCaptureContext(): AudioContext {
  const Ctor = audioContextCtor();
  try {
    return new Ctor({ sampleRate: 48_000, latencyHint: "interactive" });
  } catch {
    return new Ctor();
  }
}

function micConstraints(deviceId?: string): MediaTrackConstraints {
  const extra = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    // Safari 17+; ignored when unsupported.
    voiceIsolation: false,
  } as MediaTrackConstraints;
  const base: MediaTrackConstraints = {
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48_000 },
    ...extra,
  };
  if (deviceId) base.deviceId = { exact: deviceId };
  return base;
}

async function openMic(deviceId?: string): Promise<MediaStream> {
  const attempts: MediaStreamConstraints[] = [
    { video: false, audio: micConstraints(deviceId) },
    {
      video: false,
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    },
    { video: false, audio: deviceId ? { deviceId: { exact: deviceId } } : true },
  ];
  let last: unknown;
  for (const spec of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(spec);
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error("Microphone permission failed.");
}

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

  // Must be synchronous with the tap that called us (iOS autoplay/audio rules).
  const ctx = createCaptureContext();
  if (ctx.state === "suspended") void ctx.resume();

  const stream = await openMic(input.deviceId);
  if (ctx.state === "suspended") await ctx.resume();

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
    try {
      const hinted = track as MediaStreamTrack & { contentHint?: string };
      if ("contentHint" in hinted) hinted.contentHint = "music";
    } catch {
      /* */
    }
  }
  const settings = (track?.getSettings?.() ?? {}) as Record<string, unknown>;

  const source = ctx.createMediaStreamSource(stream);
  await ctx.audioWorklet.addModule(input.workletUrl);
  const worklet = new AudioWorkletNode(ctx, "audio-capture-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  source.connect(worklet);
  // Keep the worklet graph alive without playing the mic out of the speaker
  // (Safari treats mic→destination as a voice-call graph and turns on AEC/NS).
  const sink = ctx.createMediaStreamDestination();
  worklet.connect(sink);
  let fallbackGain: GainNode | null = null;

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
      msg.diag.echoCancellation = settings.echoCancellation as boolean | string;
      msg.diag.noiseSuppression = settings.noiseSuppression as boolean | string;
      msg.diag.autoGainControl = settings.autoGainControl as boolean | string;
      msg.diag.trackSettings = {
        ...settings,
        audioContextSampleRate: ctx.sampleRate,
      };
      input.callbacks.onDiagnostics?.(msg.diag);
      input.callbacks.onLevel?.(msg.diag.inputDbfs);
    } else if (msg.type === "error") {
      input.callbacks.onError?.(msg.message);
    }
  };

  let gotPcm = false;
  const pcmWatchdog = window.setTimeout(() => {
    if (gotPcm || fallbackGain) return;
    try {
      fallbackGain = ctx.createGain();
      fallbackGain.gain.value = 0;
      worklet.connect(fallbackGain);
      fallbackGain.connect(ctx.destination);
    } catch {
      /* */
    }
  }, 1500);

  worklet.port.onmessage = (ev: MessageEvent) => {
    const data = ev.data as {
      type: string;
      samples?: Float32Array;
      count?: number;
    };
    if (data.type === "pcm" && data.samples) {
      gotPcm = true;
      window.clearTimeout(pcmWatchdog);
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
    window.clearTimeout(pcmWatchdog);
    worker.postMessage({ type: "stop" });
    try {
      worklet.port.onmessage = null;
      worklet.disconnect();
      source.disconnect();
      fallbackGain?.disconnect();
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
    getTrackSettings: () => ({ ...settings, audioContextSampleRate: ctx.sampleRate }),
  };
}

export async function listAudioInputDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput");
}
