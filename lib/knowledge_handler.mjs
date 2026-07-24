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
    : helpers.findApprovedFaqLocalMatch(catalog, product, text, {
        faqLibrary,
        customer,
        conversationContext,
        includeProduct: false,
      });

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
