const DEFAULT_HANDOFF_ALERT_COOLDOWN_MINUTES = 10;

export function cleanHandoffAlertNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 5 && digits.length <= 18 ? digits : "";
}

export function handoffAlertSettings(settings = {}) {
  const enabled = Boolean(settings.handoffAlertEnabled);
  const number = cleanHandoffAlertNumber(settings.handoffAlertNumber);
  const rawCooldown = Number(settings.handoffAlertCooldownMinutes);
  const cooldownMinutes = Number.isFinite(rawCooldown)
    ? Math.min(Math.max(Math.trunc(rawCooldown), 0), 1440)
    : DEFAULT_HANDOFF_ALERT_COOLDOWN_MINUTES;
  return { enabled, number, cooldownMinutes };
}

export function shouldSendHandoffAlert(customer = {}, settings = {}, now = new Date()) {
  const alert = handoffAlertSettings(settings);
  if (!alert.enabled || !alert.number) return false;
  if (customer.handoffStatus !== "human_required") return false;
  const reason = String(customer.handoffReason || "").trim();
  if (!reason) return true;
  if (String(customer.lastHandoffAlertReason || "") !== reason) return true;
  const previous = Date.parse(customer.lastHandoffAlertAt || "");
  if (!Number.isFinite(previous)) return true;
  const cooldownMs = alert.cooldownMinutes * 60 * 1000;
  return cooldownMs <= 0 || now.getTime() - previous >= cooldownMs;
}

export function handoffAlertPatch(customer = {}, now = new Date()) {
  return {
    lastHandoffAlertAt: now.toISOString(),
    lastHandoffAlertReason: String(customer.handoffReason || "").trim(),
  };
}

export function customerDisplayForAlert(customer = {}, customerId = "") {
  const phone = cleanHandoffAlertNumber(customer.phone || customer.phoneNumber || "");
  const id = String(customerId || customer.id || "").trim();
  if (phone && id && id.includes("@lid")) return { customer: phone, customerId: id };
  if (phone) return { customer: phone, customerId: id && id !== phone ? id : "" };
  if (id && !id.includes("@lid")) {
    const idPhone = cleanHandoffAlertNumber(id.split("@")[0] || id);
    if (idPhone) return { customer: idPhone, customerId: id.includes("@") ? id : "" };
  }
  return { customer: id || "unknown", customerId: id && id.includes("@lid") ? id : "" };
}

export function formatHandoffAlert({
  accountId = "",
  customer = {},
  customerId = "",
  productName = "",
  reason = "",
  lastCustomerMessage = "",
  now = new Date(),
} = {}) {
  const display = customerDisplayForAlert(customer, customerId);
  const lines = [
    "AI handoff needed",
    "",
    `Account: ${accountId || "unknown"}`,
    `Customer: ${display.customer}`,
  ];
  if (display.customerId && display.customerId !== display.customer) {
    lines.push(`Customer ID: ${display.customerId}`);
  }
  if (productName) lines.push(`Product: ${productName}`);
  lines.push(`Reason: ${String(reason || customer.handoffReason || "Manual reply required.").trim()}`);
  if (lastCustomerMessage) lines.push(`Last customer message: ${String(lastCustomerMessage).trim()}`);
  lines.push(`Time: ${now.toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur" })}`);
  return lines.join("\n");
}
