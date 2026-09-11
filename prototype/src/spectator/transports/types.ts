export type TransportId = "parametric" | "hidden" | "qr" | "wax" | "postal";

export const TRANSPORT_LABELS: Record<TransportId, string> = {
  parametric: "Sealed envelope",
  hidden: "Hidden envelope",
  qr: "Standard QR",
  wax: "Wax seal",
  postal: "Postal mark",
};
