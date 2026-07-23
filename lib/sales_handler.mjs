export function buildEarlySalesPlan(context = {}) {
  const {
    catalog = {},
    product = {},
    text = "",
    customer = {},
    salesReplyLibrary = null,
    faqSalesResponse = "",
    allowLocalSales = false,
    helpers = {},
  } = context;

  if (faqSalesResponse === "not_interested") {
    return {
      customerPatch: { productId: product.id, awaitingPackageBInterest: false },
      messages: [helpers.textMessage("bah, terima kasih.")],
      handoffRequired: false,
    };
  }

  const earlySalesReply = allowLocalSales || helpers.hasSalesObjectionLanguage(text)
    ? helpers.findSalesReplyExactMatch(catalog, product, text, { salesReplyLibrary })
    : null;

  if (earlySalesReply) {
    return helpers.salesReplyPlan(customer, product, earlySalesReply);
  }

  if (faqSalesResponse === "interested") {
    return {
      customerPatch: {
        ...helpers.salesConversationClosedPatch(customer, false),
        productId: product.id,
        awaitingPackageBInterest: false,
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
