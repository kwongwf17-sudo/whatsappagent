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
        expectedNextAction: null,
        pendingOrder: helpers.pendingOrderPatch(product.id, customer.pendingOrder, orderDraft),
      },
      messages: helpers.incompleteOrderMessages(product, orderDraft),
      handoffRequired: false,
    };
  }

  if (activeState === "awaitingPackageInterest") {
    return {
      customerPatch: { productId: product.id },
      messages: [],
      handoffRequired: false,
    };
  }

  return {
    customerPatch: { productId: product.id },
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
    customerPatch: { productId: product.id },
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
    routeClassification = null,
    helpers = {},
  } = context;

  const classifierClarification = Boolean(
    routeClassification?.clarificationRequired &&
      !routeClassification?.humanSupportRequired
  );
  const clarification = helpers.ambiguousQuestionClarification(text, customer, conversationContext) ||
    (classifierClarification ? "Boleh clarify sikit maksud kita? Kita tanya pasal delivery, harga, produk, atau order ya?" : "");
  if (!clarification) return null;
  const now = new Date();
  const lastAt = Date.parse(customer.lastClarificationAt || "");
  const recentClarification = Number.isFinite(lastAt) && now.getTime() - lastAt <= 30 * 60 * 1000;
  const previousCount = recentClarification ? Number(customer.unclearClarificationCount || 0) : 0;
  if (previousCount >= 1) {
    return helpers.buildUnhandledHandoffPlan({
      product,
      reason: "Customer message remains unclear after clarification.",
    });
  }
  return {
    customerPatch: {
      productId: product.id,
      unclearClarificationCount: previousCount + 1,
      lastClarificationAt: now.toISOString(),
      lastClarificationText: text,
      lastClarificationReason: routeClassification?.reason || "",
    },
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
    customerPatch: { productId: product.id },
    messages: [
      helpers.textMessage(
        "Thanks, I noted the delivery detail. Please send the full order details in this format so I can record it cleanly:\nName:\nPhone:\nDelivery address:\nQuantity:"
      ),
    ],
    handoffRequired: false,
  };
}
