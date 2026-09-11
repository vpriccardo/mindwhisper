export type TransportId = "hidden" | "qr" | "wax" | "postal";

export const TRANSPORT_LABELS: Record<TransportId, string> = {
  hidden: "Hidden envelope",
  qr: "Standard QR",
  wax: "Wax seal",
  postal: "Postal mark",
};
