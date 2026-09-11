/**
 * Spectator transport: PENV1 still-life envelope.
 */

import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
} from "../../shared/parametricSeal/constants";
import {
  entryForSurface,
  indexForSurface,
} from "../../shared/parametricSeal/dictionary";
import { payloadToGeometry } from "../../shared/parametricSeal/layout";
import { packPayload } from "../../shared/parametricSeal/protocol";
import { rasterizeGeometry } from "../../shared/parametricSeal/raster";

export function encodeParametricWord(normalized: string): {
  index: number;
  payload: number;
  canonicalWord: string;
} {
  const idx = indexForSurface(normalized);
  const entry = entryForSurface(normalized);
  if (idx === null || !entry) {
    throw new Error(
      "That word is not in the household list. Try another Italian household object.",
    );
  }
  return {
    index: idx,
    payload: packPayload(idx),
    canonicalWord: entry.canonicalWord,
  };
}

export function renderParametricEnvelope(
  host: HTMLElement,
  payload: number,
): { canvas: HTMLCanvasElement } {
  host.replaceChildren();
  host.className = "transport-host transport-parametric";
  const geom = payloadToGeometry(payload);
  const buf = rasterizeGeometry(geom, CANVAS_WIDTH, CANVAS_HEIGHT);
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  canvas.className = "parametric-envelope-canvas";
  canvas.setAttribute("aria-label", "Sealed envelope");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable.");
  ctx.putImageData(new ImageData(buf.rgba, buf.width, buf.height), 0, 0);
  host.appendChild(canvas);
  return { canvas };
}
