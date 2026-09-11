/** Protected Aztec matrix renderer — payload text only, no decoration. */

import bwipjs from "bwip-js";

export type AztecColors = {
  /** Module (dark) color as hex without #, e.g. "4A0E1A" */
  barcolor: string;
  /** Background (light) color as hex without # */
  backgroundcolor: string;
};

export const DEFAULT_AZTEC_COLORS: AztecColors = {
  barcolor: "000000",
  backgroundcolor: "FFFFFF",
};

/** High EC (~33%) Aztec options shared by all artistic transports. */
export function aztecRenderOptions(
  payload: string,
  colors: AztecColors = DEFAULT_AZTEC_COLORS,
  scale = 6,
  padding = 8,
) {
  return {
    bcid: "azteccode",
    text: payload,
    scale,
    eclevel: "33",
    format: "full",
    paddingwidth: padding,
    paddingheight: padding,
    includetext: false,
    barcolor: colors.barcolor,
    backgroundcolor: colors.backgroundcolor,
  };
}

/**
 * Draw a standards-compliant Aztec code onto a canvas.
 * Preserves square modules, bullseye, and quiet zone. No styling beyond flat colors.
 */
export function renderAztecToCanvas(
  canvas: HTMLCanvasElement,
  payload: string,
  colors: AztecColors = DEFAULT_AZTEC_COLORS,
  scale = 6,
  padding = 8,
): HTMLCanvasElement {
  if (payload.length !== 64) {
    throw new Error("Aztec payload must be exactly 64 characters.");
  }
  return bwipjs.toCanvas(
    canvas,
    aztecRenderOptions(payload, colors, scale, padding),
  );
}

/** SVG string of the protected matrix (tests / optional use). */
export function renderAztecSvg(
  payload: string,
  colors: AztecColors = DEFAULT_AZTEC_COLORS,
  scale = 6,
  padding = 8,
): string {
  return bwipjs.toSVG(aztecRenderOptions(payload, colors, scale, padding));
}
