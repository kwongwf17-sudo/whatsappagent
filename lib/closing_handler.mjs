export function buildAcknowledgementPlan(context = {}) {
  const {
    product = {},
    customer = {},
    text = "",
    activeState = "",
    orderDraft = {},
    helpers = {},
  } = context;

  if (!helpers.isNeutralAcknowledgement(text)) return null;

  if (activeState === "pendingOrder") {
    return {
      customerPatch: {
        ...helpers.salesConversationClosedPatch(customer, false),
        productId: product.id,
        awaitingPackageBInterest: false,
        pendingOrder: helpers.pendingOrderPatch(product.id, customer.pendingOrder, orderDraft),
      },
      messages: helpers.incompleteOrderMessages(product, orderDraft),
      handoffRequired: false,
    };
  }

  return {
    customerPatch: { productId: product.id, awaitingPackageBInterest: false },
    messages: [],
    handoffRequired: false,
  };
}

export function buildPoliteClosePlan(context = {}) {
  const {
    product = {},
    text = "",
    closeReply = "",
    helpers = {},
  } = context;

  if (!helpers.isPoliteClose(text)) return null;
  return {
    customerPatch: { productId: product.id, awaitingPackageBInterest: false },
    messages: [helpers.textMessage(closeReply)],
    handoffRequired: false,
  };
}

export function buildClarificationPlan(context = {}) {
  const {
    product = {},
    customer = {},
    text = "",
    conversationContext = [],
    helpers = {},
  } = context;

  const clarification = helpers.ambiguousQuestionClarification(text, customer, conversationContext);
  if (!clarification) return null;
  return {
    customerPatch: { productId: product.id, awaitingPackageBInterest: false },
    messages: [helpers.textMessage(clarification)],
    handoffRequired: false,
  };
}

export function buildDeliveryFallbackPlan(context = {}) {
  const {
    product = {},
    customer = {},
    text = "",
    deliveryKeywords = null,
    helpers = {},
  } = context;

  if (!deliveryKeywords?.test(text) || !customer.pendingOrder) return null;
  return {
    customerPatch: { productId: product.id, awaitingPackageBInterest: false },
    messages: [
      helpers.textMessage(
        "Thanks, I noted the delivery detail. Please send the full order details in this format so I can record it cleanly:\nName:\nPhone:\nDelivery address:\nQuantity:"
      ),
    ],
    handoffRequired: false,
  };
}
