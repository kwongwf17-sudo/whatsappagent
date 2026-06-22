export const ORDER_STATUS_OPTIONS = [
  { key: "pending_admin_order", label: "Order Submitted" },
  { key: "reached_warehouse", label: "Reached Warehouse" },
];

export const DEFAULT_ORDER_STATUS_REPLIES = {
  pending_admin_order: "Your order has been received and currently in order & shipping phase.",
  reached_warehouse: "Barang kita sudah sampai warehouse ya. Kami akan prepare untuk delivery.",
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
  return String(replies[status] || DEFAULT_ORDER_STATUS_REPLIES[status] || DEFAULT_ORDER_STATUS_REPLIES.pending_admin_order);
}

export function isLikelyOrderStatusQuestion(text) {
  const message = String(text || "").toLowerCase();
  return (
    /\b(status|tracking|track)\b.*\b(order|barang|parcel|delivery)\b/i.test(message) ||
    /\b(order|barang|parcel|delivery)\b.*\b(status|mana|sampai|hantar|deliver|jalanan)\b/i.test(message) ||
    /\b(bila|when)\b.*\b(order|barang|parcel)\b.*\b(sampai|deliver|hantar)\b/i.test(message)
  );
}
