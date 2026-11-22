export type SendProvider = "resend" | "senddev";

export function pickProvider(fromDomain: string): SendProvider {
  if (fromDomain === "istockvn.eu.cc" || fromDomain === "icalendar.eu.cc" || fromDomain === "inotion.eu.cc") return "senddev";
  return "resend";
}
