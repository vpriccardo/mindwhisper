/**
 * Render a complete AENV1 audio seal from an HENV1 token.
 */

import { encodeAenvPacket } from "../../shared/audioSeal/packet";
import { tokenToHex } from "../../shared/hiddenEnvelopeProtocol";
import { renderCoverSound, type CoverOptions } from "./coverSound";
import { mixAudioSeal, type MixDiagnostics } from "./modulator";

export type AudioSealRender = {
  mixed: Float32Array;
  cover: Float32Array;
  watermarkOnly: Float32Array;
  tokenHex: string;
  crc: number;
  coverSeed: number;
  diagnostics: MixDiagnostics;
  interleavedBits: Int8Array;
};

export async function renderAudioSeal(input: {
  token: Uint8Array;
  watermarkDb?: number;
  cover?: CoverOptions;
}): Promise<AudioSealRender> {
  const encoded = encodeAenvPacket(input.token);
  const { samples: cover, seed: coverSeed } = renderCoverSound(input.cover ?? {});
  const mixed = mixAudioSeal({
    cover,
    interleavedBits: encoded.interleavedBits,
    watermarkDb: input.watermarkDb,
  });
  return {
    mixed: mixed.mixed,
    cover: mixed.cover,
    watermarkOnly: mixed.watermarkOnly,
    tokenHex: tokenToHex(input.token),
    crc: encoded.crc,
    coverSeed,
    diagnostics: mixed.diagnostics,
    interleavedBits: encoded.interleavedBits,
  };
}
