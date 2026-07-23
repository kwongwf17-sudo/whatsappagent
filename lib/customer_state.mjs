export function deriveCustomerState(customer = {}) {
  if (!customer || typeof customer !== "object") {
    return emptyCustomerState();
  }

  const status = normalizeStateValue(customer.status);
  const salesStatus = normalizeStateValue(customer.salesStatus);
  const conversationState = normalizeStateValue(customer.conversationState);
  const guardrail = normalizeStateValue(customer.guardrailStatus || customer.guardrail);
  const handoffStatus = normalizeStateValue(customer.handoffStatus);
  const handoffReason = normalizeStateValue(customer.handoffReason);
  const followupBlockedReason = normalizeStateValue(customer.followupBlockedReason);
  const lastSalesReplyIntent = normalizeStateValue(customer.lastSalesReplyIntent);

  const state = {
    conversationState,
    salesState: salesStatus,
    orderState: "",
    handoffState: "",
    openingFlowHistory: customer.openingFlowsSent && typeof customer.openingFlowsSent === "object"
      ? customer.openingFlowsSent
      : {},
    followupState: followupBlockedReason,
    activeState: "",
  };

  if (customer.optedOut || status === "opted_out" || followupBlockedReason === "opted_out") {
    return { ...state, activeState: "optedOut", followupState: "opted_out" };
  }
  if (normalizeStateValue(customer.complaintStatus) === "open" || followupBlockedReason === "complaint_handoff") {
    return { ...state, handoffState: "complaint", activeState: "complaint" };
  }
  if (
    customer.humanRequired ||
    handoffStatus === "human_required" ||
    status === "human_required" ||
    guardrail.includes("human") ||
    Boolean(handoffReason)
  ) {
    return { ...state, handoffState: "human_required", activeState: "handoff" };
  }
  if (customerHasSubmittedOrder(customer)) {
    return { ...state, orderState: "submitted", activeState: "submittedOrder" };
  }
  if (status === "done" || followupBlockedReason === "done" || customer.done) {
    return { ...state, activeState: "done" };
  }
  if (customer.pendingOrder) {
    return { ...state, orderState: "pending", activeState: "pendingOrder" };
  }
  if (customer.awaitingPackageBInterest || conversationState === "awaiting_package_interest") {
    return { ...state, salesState: "awaiting_package_interest", activeState: "awaitingPackageInterest" };
  }
  if (
    status === "another_date_purchase" ||
    salesStatus === "another_date_purchase" ||
    conversationState === "another_date_purchase" ||
    followupBlockedReason === "another_date_purchase" ||
    lastSalesReplyIntent === "another_date_purchase"
  ) {
    return { ...state, salesState: "another_date_purchase", activeState: "anotherDatePurchase" };
  }
  if (
    customer.salesConversationClosed ||
    salesStatus === "sales_closed" ||
    conversationState === "sales_closed" ||
    followupBlockedReason === "sales_conversation_closed"
  ) {
    return { ...state, salesState: "sales_closed", activeState: "salesClosed" };
  }

  return state;
}

export function conversationActiveState(customer = {}) {
  return deriveCustomerState(customer).activeState;
}

export function customerHasSubmittedOrder(customer = {}) {
  return Boolean(
    customer.status === "order_submitted" ||
      customer.followupBlockedReason === "order_submitted" ||
      (Array.isArray(customer.orderIds) && customer.orderIds.length > 0)
  );
}

export function normalizeStateValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function emptyCustomerState() {
  return {
    conversationState: "",
    salesState: "",
    orderState: "",
    handoffState: "",
    openingFlowHistory: {},
    followupState: "",
    activeState: "",
  };
}
