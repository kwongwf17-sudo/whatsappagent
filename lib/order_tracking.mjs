export const ORDER_STATUS_OPTIONS = [
  { key: "pending_admin_order", label: "Order Submitted" },
  { key: "reached_warehouse", label: "Reached Warehouse" },
];

export const DEFAULT_ORDER_STATUS_REPLIES = {
  pending_admin_order: "Your order has been received and currently in order & shipping phase.",
  reached_warehouse: "Salam kita, dlm 1-3 ari runner will hantar brg '{quantity} unit {product}' utk kita ya \uD83E\uDD70\nKita ingat reply Runner text, Runner TOMU LOGISTIC. \uD83E\uDD70",
};

export const NO_LINKED_ORDER_REPLY =
  "Kami belum menjumpai order di nombor WhatsApp ani. Sila bagi nama dan nombor telefon yang digunakan masa order untuk team kami check ya.";

const LEGACY_STATUS_MAP = {
  completed_by_order_admin: "pending_admin_order",
  acknowledged_by_order_admin: "pending_admin_order",
  ordered_from_supplier: "pending_admin_order",
  stock_arrived_waiting_delivery_time: "reached_warehouse",
  preparing_for_delivery: "reached_warehouse",
  delivering: "reached_warehouse",
  delivered: "reached_warehouse",
};

export function isAllowedOrderStatus(status) {
  return ORDER_STATUS_OPTIONS.some((item) => item.key === status);
}

export function normalizedOrderStatus(status) {
  return LEGACY_STATUS_MAP[status] || status;
}

export function orderStatusDisplay(status) {
  const normalized = normalizedOrderStatus(status);
  return ORDER_STATUS_OPTIONS.find((item) => item.key === normalized)?.label || String(status || "");
}

export function customerOrderStatusReply(order, replies = DEFAULT_ORDER_STATUS_REPLIES) {
  if (!order) return NO_LINKED_ORDER_REPLY;
  const status = normalizedOrderStatus(order.status);
  return renderOrderStatusReply(
    String(replies[status] || DEFAULT_ORDER_STATUS_REPLIES[status] || DEFAULT_ORDER_STATUS_REPLIES.pending_admin_order),
    order
  );
}

export function renderOrderStatusReply(template, order = {}) {
  const quantity = Number(order.quantity || 1) || 1;
  const productName = String(order.productName || order.productId || "barang").trim().toLowerCase();
  return String(template || "")
    .replace(/\{quantity\}/gi, String(quantity))
    .replace(/\{product\}/gi, productName)
    .replace(/\{productName\}/gi, productName)
    .replace(/\{unitText\}/gi, `${quantity} unit ${productName}`);
}

export function isDeliveryRescheduleRequest(text, { conversationContext = [], hasOrder = false } = {}) {
  const message = String(text || "").toLowerCase();
  const deliveryTerms = /\b(hantar|deliver|delivery|runner|tomu|parcel|penghantaran)\b/i;
  const previousTeamMessage = [...conversationContext].reverse().find((entry) =>
    ["outbound", "agent", "assistant", "bot", "team"].includes(String(entry.direction || entry.role || "").toLowerCase()));
  const contextualDelivery = deliveryTerms.test(String(previousTeamMessage?.body || previousTeamMessage?.text || ""));
  const mentionsDelivery = deliveryTerms.test(message);
  const changesTiming = /\b(esok|tomorrow|lusa|minggu|week|hari|date|time|masa|later)\b/i.test(message);
  const changeAction = /\b(tukar|ubah|change|reschedule|postpone|delay|later|hold|tangguh)\b/i.test(message) &&
    (mentionsDelivery || changesTiming || /\b(reschedule|postpone|tangguh)\b/i.test(message));
  const unavailable = /\b(?:takde|tiada|inda|nda|ndak|not)\s+(?:(?:ada|di|kat|at)\s+)*(?:rumah|home)\b/i.test(message) ||
    ((mentionsDelivery || contextualDelivery) && /\b(outstation|busy|kerja)\b/i.test(message));
  const proposesDeliveryDate = /\b(hantar|deliver|delivery|runner)\b.*\b(esok|tomorrow|lusa|minggu\s+depan|next\s+week)\b/i.test(message);
  // Time words and generic negation need delivery evidence. Prior delivery context
  // supports short replies without turning pre-sale date questions into changes.
  return (mentionsDelivery || contextualDelivery || (hasOrder && unavailable)) &&
    (changeAction || unavailable || (proposesDeliveryDate && (hasOrder || contextualDelivery)));
}

export function deliveryRescheduleReply() {
  return "Boleh kita, saya minta team arrange delivery semula ya. Nanti team/runner confirm dengan kita.";
}

export function isLikelyOrderStatusQuestion(text) {
  const message = String(text || "").toLowerCase();
  if (isDeliveryRescheduleRequest(message)) return false;
  return (
    /\b(status|tracking|track)\b.*\b(order|barang|parcel|delivery)\b/i.test(message) ||
    /\b(order|barang|parcel|delivery)\b.*\b(status|mana|sampai|hantar|deliver|jalanan)\b/i.test(message) ||
    /\b(bila|when)\b.*\b(order|barang|parcel)\b.*\b(sampai|deliver|hantar)\b/i.test(message)
  );
}
