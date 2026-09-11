/** Postal-mark artistic frame around a protected Aztec matrix. */

import { renderAztecToCanvas } from "./aztecCore";

/** Muted stamp ink — low contrast, still decode-verified. */
const POST_MODULE = "3A1018";
const POST_STAMP_BG = "7A2838";

function el(tag: string, className: string, ariaHidden = true): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (ariaHidden) node.setAttribute("aria-hidden", "true");
  return node;
}

/**
 * Populate the postal transport host.
 * Cancellation / distress live around the matrix; canvas stays optically flat.
 */
export function renderPostalMark(host: HTMLElement, payload: string): void {
  host.replaceChildren();
  host.className = "transport-host transport-postal";

  const paper = el("div", "postal-paper", false);
  const stamp = el("div", "postal-stamp", false);

  stamp.appendChild(el("div", "postal-grain"));

  const rings = el("div", "postal-rings");
  for (let i = 0; i < 4; i++) {
    rings.appendChild(el("div", `postal-ring postal-ring-${i}`));
  }
  stamp.appendChild(rings);

  stamp.appendChild(el("div", "postal-waves"));
  stamp.appendChild(el("div", "postal-ornament"));

  const matrixWrap = el("div", "postal-matrix-wrap", false);
  const canvas = document.createElement("canvas");
  canvas.className = "aztec-matrix";
  canvas.setAttribute("aria-label", "Seal mark");
  renderAztecToCanvas(
    canvas,
    payload,
    { barcolor: POST_MODULE, backgroundcolor: POST_STAMP_BG },
    6,
    6,
  );
  matrixWrap.appendChild(canvas);
  stamp.appendChild(matrixWrap);

  paper.appendChild(stamp);
  host.appendChild(paper);
}
