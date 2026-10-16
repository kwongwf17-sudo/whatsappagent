// Accept retained customer-facing messages that predate explicit channel metadata.
// Explicit internal/admin channels must never enter customer routing context.
export function customerConversationContext(messages, customerId, businessAccountId, limit = 10) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) =>
      String(message.businessAccountId || "") === String(businessAccountId || "") &&
      (message.from === customerId || message.to === customerId) &&
      (message.channel === "customer" ||
        (message.channel === "business_admin" && message.direction === "outbound" && message.to === customerId) || (!message.channel &&
        ["inbound", "outbound"].includes(message.direction)))
    )
    .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")))
    .slice(-limit)
    .map((message) => ({
      role: message.direction === "inbound" ? "customer" : "agent",
      direction: message.direction,
      text: String(message.body || message.caption || ""),
      type: message.type || "text",
      at: message.createdAt || "",
    }))
    .filter((message) => message.text.trim());
}

export function formatConversationContext(messages = [], limit = 8) {
  return (Array.isArray(messages) ? messages : []).slice(-limit)
    .map((message) => {
      const role = message.role || (message.direction === "inbound" ? "customer" :
        message.direction === "outbound" ? "agent" : "message");
      return `${role}: ${message.body || message.text || ""}`;
    }).join("\n");
}
