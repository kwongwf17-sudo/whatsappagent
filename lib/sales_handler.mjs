export function buildEarlySalesPlan(context = {}) {
  const {
    catalog = {},
    product = {},
    text = "",
    customer = {},
    salesReplyLibrary = null,
    salesReplyMatch = undefined,
    faqSalesResponse = "",
    allowLocalSales = false,
    helpers = {},
  } = context;

  const earlySalesReply = allowLocalSales
    ? helpers.findSalesReplyExactMatch(catalog, product, text, { salesReplyLibrary })
    : null;

  if (earlySalesReply) {
    // The server has already applied admin modes, alternates and next-action
    // detection. Do not reload raw text or resurrect a rejected prepared reply.
    if (salesReplyMatch !== undefined) {
      return buildMatchedSalesPlan({ product, customer, salesReplyMatch, helpers });
    }
    return helpers.salesReplyPlan(customer, product, earlySalesReply);
  }

  if (faqSalesResponse === "interested") {
    return {
      customerPatch: {
        ...helpers.salesConversationClosedPatch(customer, false),
        productId: product.id,
        awaitingPackageBInterest: false,
        expectedNextAction: null,
        pendingOrder: { productId: product.id, startedAt: new Date().toISOString() },
      },
      messages: helpers.orderFormMessages(product),
      handoffRequired: false,
    };
  }

  return null;
}

export function buildMatchedSalesPlan(context = {}) {
  const {
    product = {},
    customer = {},
    salesReplyMatch = null,
    helpers = {},
  } = context;

  if (!salesReplyMatch?.approvedReply) return null;
  return helpers.salesReplyPlan(customer, product, helpers.salesReplyFromMatch(salesReplyMatch));
}
