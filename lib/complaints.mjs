export const DEFAULT_COMPLAINT_ACKNOWLEDGEMENT =
  "Maaf atas kesulitan kita. Saya sudah forward perkara ani kepada team kami untuk bantu check dan reply kita secepatnya ya.";

export const COMPLAINT_CATEGORIES = [
  { key: "complaint", label: "Complaint" },
  { key: "refund_return", label: "Refund / Return" },
  { key: "damaged_wrong_item", label: "Damaged / Wrong Item" },
  { key: "legal_report_threat", label: "Report / Legal Threat" },
];

export function complaintCategoryDisplay(category) {
  return COMPLAINT_CATEGORIES.find((item) => item.key === category)?.label || String(category || "Complaint");
}

export function detectObviousComplaint(text) {
  const message = String(text || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!message) return null;
  if (/\b(report|lapor|legal|lawyer|police|polis|tribunal|kpdn)\b/i.test(message)) {
    return { category: "legal_report_threat", reason: "Clear report or legal escalation wording." };
  }
  if (/\b(refund|return|pulangkan|bayar balik|duit balik|money back)\b/i.test(message)) {
    return { category: "refund_return", reason: "Clear refund or return request." };
  }
  if (
    /\b(rosak|damaged|broken|pecah|leak|salah barang|wrong item|inda berfungsi|tak berfungsi|tidak berfungsi|not working)\b/i.test(message)
  ) {
    return { category: "damaged_wrong_item", reason: "Clear damaged, incorrect, or non-working item issue." };
  }
  if (
    /\b(complain|complaint|komplen|kecewa|marah|angry|terrible|teruk|scam|penipu|lambat banar)\b/i.test(message)
  ) {
    return { category: "complaint", reason: "Clear complaint or dissatisfaction wording." };
  }
  return null;
}
