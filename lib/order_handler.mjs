export function buildOrderDraftPlan({ customer = {}, product = {}, text = "", orderDraft = {}, helpers = {} }) {
  const {
    salesConversationClosedPatch,
    pendingOrderPatch,
    incompleteOrderMessages,
    orderClosingMessages,
    formatAdminOrderMessage,
  } = helpers;

  if (orderDraft.isComplete) {
    return {
      customerPatch: {
        ...salesConversationClosedPatch(customer, false),
        productId: product.id,
        pendingOrder: null,
        awaitingPackageBInterest: false,
        handoffStatus: "human_required",
        handoffReason: "Customer submitted complete order details.",
      },
      order: {
        customerId: customer.id,
        productId: product.id,
        productName: product.name,
        shoppingLink: product.shopping_link || "",
        packageId: orderDraft.packageId,
        packageName: orderDraft.packageName,
        packagePrice: orderDraft.packagePrice,
        orderOptionId: orderDraft.orderOptionId,
        orderOptionName: orderDraft.orderOptionName,
        orderOptionPrice: orderDraft.orderOptionPrice,
        addOnChoice: orderDraft.addOnChoice,
        quantity: orderDraft.quantity,
        name: orderDraft.name,
        phone: orderDraft.phone || customer.id,
        address: orderDraft.address,
        rawMessage: text,
      },
      messages: orderClosingMessages(product),
      adminMessage: formatAdminOrderMessage(product, orderDraft, customer.id),
      handoffRequired: true,
      handoffReason: "Customer submitted complete order details.",
    };
  }

  return {
    customerPatch: {
      ...salesConversationClosedPatch(customer, false),
      productId: product.id,
      awaitingPackageBInterest: false,
      pendingOrder: pendingOrderPatch(product.id, customer.pendingOrder, orderDraft),
    },
    messages: incompleteOrderMessages(product, orderDraft),
    handoffRequired: false,
  };
}
