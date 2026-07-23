export function normalizeConversationPlan(plan = null) {
  if (!plan || typeof plan !== "object") {
    throw contractError("INVALID_PLAN", "Conversation plan must be an object.");
  }

  const normalized = {
    customerPatch: {},
    messages: [],
    handoffRequired: false,
    handoffReason: "",
    ...plan,
  };

  if (!normalized.customerPatch || typeof normalized.customerPatch !== "object" || Array.isArray(normalized.customerPatch)) {
    throw contractError("INVALID_CUSTOMER_PATCH", "Conversation plan customerPatch must be an object.");
  }
  if (!Array.isArray(normalized.messages)) {
    throw contractError("INVALID_MESSAGES", "Conversation plan messages must be an array.");
  }
  for (const [index, message] of normalized.messages.entries()) {
    validateMessage(message, index);
  }
  if (normalized.handoffRequired && !String(normalized.handoffReason || normalized.adminMessage || "").trim()) {
    throw contractError("INVALID_HANDOFF", "Conversation plan handoff requires a reason or admin message.");
  }

  return normalized;
}

function validateMessage(message, index) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw contractError("INVALID_MESSAGE", `Message ${index} must be an object.`);
  }
  const type = String(message.type || "");
  if (!["text", "image", "video", "document"].includes(type)) {
    throw contractError("INVALID_MESSAGE_TYPE", `Message ${index} has invalid type.`);
  }
  if (type === "text" && !String(message.body || "").trim()) {
    throw contractError("INVALID_TEXT_MESSAGE", `Text message ${index} requires body.`);
  }
  if (type !== "text" && !String(message.url || "").trim()) {
    throw contractError("INVALID_MEDIA_MESSAGE", `Media message ${index} requires url.`);
  }
}

function contractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
