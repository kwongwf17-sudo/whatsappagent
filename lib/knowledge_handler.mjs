export function buildPrimaryKnowledgePlan(context = {}) {
  const {
    catalog,
    product,
    text,
    customer,
    faqLibrary,
    conversationContext,
    routeClassification,
    ragAnswer,
    productSpecificQuestion,
    orderDraft,
    pendingOrderAnswerInterrupt,
    approvedFaqMatch,
    allowLocalKnowledge,
    helpers,
  } = context;

  if (
    pendingOrderAnswerInterrupt &&
    ragAnswer?.reply &&
    (!productSpecificQuestion || ragAnswer.allowProductSpecific || ragAnswer.replyType === "faq")
  ) {
    return helpers.ragAnswerConversationPlan(ragAnswer, product, customer, orderDraft, pendingOrderAnswerInterrupt);
  }

  const approvedFaq = !allowLocalKnowledge
    ? null
    : helpers.findApprovedFaqLocalMatch(catalog, product, text, { faqLibrary, customer, conversationContext });

  if (approvedFaq) {
    return knowledgePlanFromReply({
      product,
      customer,
      orderDraft,
      pendingOrderAnswerInterrupt,
      reply: approvedFaq.approved_reply,
      faqId: approvedFaq.id,
      helpers,
    });
  }

  const productPriceReply = allowLocalKnowledge
    ? helpers.productPriceFaq(product, helpers.normalizeReplyText(text))
    : null;
  if (productPriceReply) {
    return knowledgePlanFromReply({
      product,
      customer,
      orderDraft,
      pendingOrderAnswerInterrupt,
      reply: productPriceReply.approved_reply,
      faqId: productPriceReply.id,
      helpers,
    });
  }

  const standardReply = helpers.routeAllowsStandardReply(routeClassification)
    ? helpers.findStandardReply(catalog, product, text)
    : null;
  if (standardReply) {
    return {
      customerPatch: {
        productId: product.id,
        ...(standardReply.type === "faq"
          ? helpers.knowledgeAnswerPatch(product, customer, orderDraft, pendingOrderAnswerInterrupt)
          : { awaitingPackageBInterest: false }),
      },
      messages:
        standardReply.type === "faq"
          ? helpers.knowledgeAnswerMessages(standardReply.reply, product, customer, orderDraft, pendingOrderAnswerInterrupt)
          : [helpers.textMessage(standardReply.reply)],
      handoffRequired: false,
    };
  }

  if (approvedFaqMatch?.approvedReply) {
    return knowledgePlanFromReply({
      product,
      customer,
      orderDraft,
      pendingOrderAnswerInterrupt,
      reply: approvedFaqMatch.approvedReply,
      faqId: approvedFaqMatch.faqId,
      helpers,
    });
  }

  return null;
}

export function buildFallbackKnowledgePlan(context = {}) {
  const {
    product,
    text,
    customer,
    ragAnswer,
    productSpecificQuestion,
    orderDraft,
    pendingOrderAnswerInterrupt,
    allowLocalKnowledge,
    helpers,
  } = context;

  const faqAnswer = allowLocalKnowledge
    ? helpers.findFaqAnswer(product, text)
    : null;
  if (faqAnswer) {
    return {
      customerPatch: helpers.knowledgeAnswerPatch(product, customer, orderDraft, pendingOrderAnswerInterrupt),
      messages: helpers.knowledgeAnswerMessages(faqAnswer, product, customer, orderDraft, pendingOrderAnswerInterrupt),
      handoffRequired: false,
    };
  }

  if (ragAnswer?.reply && (!productSpecificQuestion || ragAnswer.allowProductSpecific)) {
    return helpers.ragAnswerConversationPlan(ragAnswer, product, customer, orderDraft, pendingOrderAnswerInterrupt);
  }

  return null;
}

function knowledgePlanFromReply({
  product,
  customer,
  orderDraft,
  pendingOrderAnswerInterrupt,
  reply,
  faqId,
  helpers,
}) {
  return {
    customerPatch: {
      ...helpers.knowledgeAnswerPatch(product, customer, orderDraft, pendingOrderAnswerInterrupt),
      lastApprovedFaqId: faqId,
    },
    messages: helpers.knowledgeAnswerMessages(reply, product, customer, orderDraft, pendingOrderAnswerInterrupt),
    handoffRequired: false,
  };
}
