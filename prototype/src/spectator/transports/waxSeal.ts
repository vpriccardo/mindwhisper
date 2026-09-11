/** Wax-seal artistic frame around a protected Aztec matrix. */

import { renderAztecToCanvas } from "./aztecCore";

/**
 * Continuous wax field: module and background are close burgundy tones so the
 * square quiet zone disappears into the disc and the concentric Aztec rings
 * read as a circular stamped crest (concept top-left).
 * Decode-verified; do not put texture/filters on the canvas itself.
 */
const WAX_MODULE = "2A0C12";
const WAX_FIELD = "6A2030";

function el(tag: string, className: string, ariaHidden = true): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (ariaHidden) node.setAttribute("aria-hidden", "true");
  return node;
}

/**
 * Populate the wax transport host.
 * Material, scallops, bubbles, and rim gloss live in layers around the matrix.
 * The canvas is optically flat: two colors only, no CSS filter/mask on pixels.
 */
export function renderWaxSeal(host: HTMLElement, payload: string): void {
  host.replaceChildren();
  host.className = "transport-host transport-wax";

  const envelope = el("div", "wax-envelope", false);

  const disc = el("div", "wax-disc", false);

  // Outer-ring material only (CSS mask punches a hole over the matrix well)
  disc.appendChild(el("div", "wax-skin"));
  disc.appendChild(el("div", "wax-grain"));
  disc.appendChild(el("div", "wax-gloss"));
  disc.appendChild(el("div", "wax-ring-band"));

  const bubbles = el("div", "wax-bubbles");
  for (let i = 0; i < 14; i++) {
    const b = el("span", `wax-bubble wax-bubble-${i}`);
    bubbles.appendChild(b);
  }
  disc.appendChild(bubbles);

  const drips = el("div", "wax-drips");
  for (let i = 0; i < 6; i++) {
    drips.appendChild(el("span", `wax-drip wax-drip-${i}`));
  }
  disc.appendChild(drips);

  // Protected matrix well — same field color as wax so square outline vanishes
  const well = el("div", "wax-matrix-well", false);
  const canvas = document.createElement("canvas");
  canvas.className = "aztec-matrix";
  canvas.setAttribute("aria-label", "Seal mark");
  renderAztecToCanvas(
    canvas,
    payload,
    { barcolor: WAX_MODULE, backgroundcolor: WAX_FIELD },
    6,
    6,
  );
  well.appendChild(canvas);
  disc.appendChild(well);

  envelope.appendChild(disc);
  host.appendChild(envelope);
}
