/** Standard QR transport — encodes the raw 64-character payload. */

import QRCode from "qrcode";

export async function renderStandardQr(
  canvas: HTMLCanvasElement,
  payload: string,
  size = 320,
): Promise<void> {
  await QRCode.toCanvas(canvas, payload, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: size,
    color: { dark: "#000000", light: "#ffffff" },
  });
}
