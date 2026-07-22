import { readFile } from "node:fs/promises";
import { sanitizeImageKnowledgeChunk } from "./knowledge_sanitizer.mjs";

const DELIVERY_KEYWORDS = /\b(delivery|deliver|address|send)\b/i;
const DEFAULT_SALES_PROMPT = "Ada minat nak beli Package B?";
const DEFAULT_ORDER_FORM = {
  intro: "Can you help me fill up this details for hold promo? \uD83E\uDD70",
  nameLabel: "Full name",
  addressLabel: "Full address",
  phoneLabel: "Phone number",
  optionLabel: "Order option",
};
const DEFAULT_ORDER_CLOSING_MESSAGES = [
  "Sorry Dear our stock just finish , I will take order again, will take around 15-18 days for arrived brunei new stock 🥰 But i will try my best to get it quick for you ya.",
  "REMINDER ✨: \n-Order after 1 hour cannot be canceled. \n-Brg Sampai baru byr runner",
  "Terima kasih❤️",
];

const SALES_AFTER_REPLY_WAIT = "WAIT_FOR_CUSTOMER";
const SALES_AFTER_REPLY_CLOSE = "CLOSE_SALES_CONVERSATION";

export async function loadCatalog(catalogPath) {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  if (!Array.isArray(catalog.products) || catalog.products.length === 0) {
    throw new Error(`Catalog has no products: ${catalogPath}`);
  }
  return catalog;
}

export async function buildConversationPlan({
  catalog,
  customer,
  customerMessage,
  source = {},
  faqLibrary = null,
  salesReplyLibrary = null,
  approvedFaqMatch,
  salesReplyMatch,
  ragAnswer,
  routeClassification = null,
  conversationContext = [],
}) {
  const product = findProduct(catalog, customerMessage, source, customer.productId);
  const text = customerMessage.trim();
  if (customerHasSubmittedOrder(customer)) {
    customer = { ...customer, pendingOrder: null, awaitingPackageBInterest: false };
  }
  const activeState = conversationActiveState(customer);
  const productNameOpening = !activeState && isProductNameMessage(product, text);
  const productOpeningFlow = !activeState && shouldSendProductOpeningFlow(customer, product, text, source);
  const shouldOpenNewProductJourney = !activeState && (productOpeningFlow || productNameOpening);
  const productSpecificQuestion = isProductSpecificQuestion(text);
  const faqSalesResponse = classifyFaqSalesPromptResponse(customer, text);
  const allowLocalSales = routeAllowsSalesReply(routeClassification);
  const allowLocalKnowledge = routeAllowsKnowledgeAnswer(routeClassification);

  if (faqSalesResponse === "not_interested") {
    return {
      customerPatch: { productId: product.id, awaitingPackageBInterest: false },
      messages: [textMessage("bah, terima kasih.")],
      handoffRequired: false,
    };
  }

  const earlySalesReply = allowLocalSales || hasSalesObjectionLanguage(text)
    ? findSalesReplyExactMatch(catalog, product, text, { salesReplyLibrary })
    : null;

  if (earlySalesReply) {
    return salesReplyPlan(customer, product, earlySalesReply);
  }

  if (shouldOpenNewProductJourney) {
    return {
      customerPatch: {
        productId: product.id,
        source: { ...(customer.source || {}), ...source },
        handoffStatus: "",
        handoffReason: "",
        awaitingPackageBInterest: false,
      },
      messages: product.opening_flow || [textMessage(productIntro(product))],
      handoffRequired: false,
    };
  }

  if (faqSalesResponse === "interested") {
    return {
      customerPatch: {
        ...salesConversationClosedPatch(customer, false),
        productId: product.id,
        awaitingPackageBInterest: false,
        pendingOrder: { productId: product.id, startedAt: new Date().toISOString() },
      },
      messages: orderFormMessages(product),
      handoffRequired: false,
    };
  }

  const currentOrderDraft = extractOrderDetails(text, product);
  const earlyOrderDraft = mergePendingOrderDraft(customer, currentOrderDraft, text, product);
  const pendingOrderAnswerInterrupt = shouldAnswerBeforePendingOrder(
    customer,
    text,
    currentOrderDraft,
    earlyOrderDraft,
    product,
    routeClassification
  );
  if (activeState === "pendingOrder" && refersToPreviousOrderDetails(text)) {
    return {
      customerPatch: {
        ...salesConversationClosedPatch(customer, false),
        productId: product.id,
        awaitingPackageBInterest: false,
        pendingOrder: pendingOrderPatch(product.id, customer.pendingOrder, earlyOrderDraft),
      },
      messages: incompleteOrderMessages(product, earlyOrderDraft),
      handoffRequired: false,
    };
  }
  if (!pendingOrderAnswerInterrupt && shouldHandleOrderDraft(customer, text, earlyOrderDraft, product, ragAnswer, routeClassification)) {
    if (earlyOrderDraft.isComplete) {
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
          packageId: earlyOrderDraft.packageId,
          packageName: earlyOrderDraft.packageName,
          packagePrice: earlyOrderDraft.packagePrice,
          orderOptionId: earlyOrderDraft.orderOptionId,
          orderOptionName: earlyOrderDraft.orderOptionName,
          orderOptionPrice: earlyOrderDraft.orderOptionPrice,
          addOnChoice: earlyOrderDraft.addOnChoice,
          quantity: earlyOrderDraft.quantity,
          name: earlyOrderDraft.name,
          phone: earlyOrderDraft.phone || customer.id,
          address: earlyOrderDraft.address,
          rawMessage: text,
        },
        messages: orderClosingMessages(product),
        adminMessage: formatAdminOrderMessage(product, earlyOrderDraft, customer.id),
        handoffRequired: true,
        handoffReason: "Customer submitted complete order details.",
      };
    }

    return {
      customerPatch: {
        ...salesConversationClosedPatch(customer, false),
        productId: product.id,
        awaitingPackageBInterest: false,
        pendingOrder: pendingOrderPatch(product.id, customer.pendingOrder, earlyOrderDraft),
      },
      messages: incompleteOrderMessages(product, earlyOrderDraft),
      handoffRequired: false,
    };
  }

  if (isNeutralAcknowledgement(text)) {
    if (activeState === "pendingOrder") {
      return {
        customerPatch: {
          ...salesConversationClosedPatch(customer, false),
          productId: product.id,
          awaitingPackageBInterest: false,
          pendingOrder: pendingOrderPatch(product.id, customer.pendingOrder, earlyOrderDraft),
        },
        messages: incompleteOrderMessages(product, earlyOrderDraft),
        handoffRequired: false,
      };
    }
    return {
      customerPatch: { productId: product.id, awaitingPackageBInterest: false },
      messages: [],
      handoffRequired: false,
    };
  }

  if (isPoliteClose(text)) {
    return {
      customerPatch: { productId: product.id, awaitingPackageBInterest: false },
      messages: [textMessage("Sama-sama ðŸ˜Š Boleh, nanti kalau kita kan order atau ada soalan lagi, WhatsApp saja kami di sini. Terima kasih!")],
      handoffRequired: false,
    };
  }

  if (
    pendingOrderAnswerInterrupt &&
    ragAnswer?.reply &&
    (!productSpecificQuestion || ragAnswer.allowProductSpecific || ragAnswer.replyType === "faq")
  ) {
    return ragAnswerConversationPlan(ragAnswer, product, customer, earlyOrderDraft, pendingOrderAnswerInterrupt);
  }

  const approvedFaq = !allowLocalKnowledge
    ? null
    : findApprovedFaqLocalMatch(catalog, product, text, { faqLibrary, customer, conversationContext });

  if (approvedFaq) {
    return {
      customerPatch: {
        ...knowledgeAnswerPatch(product, customer, earlyOrderDraft, pendingOrderAnswerInterrupt),
        lastApprovedFaqId: approvedFaq.id,
      },
      messages: knowledgeAnswerMessages(approvedFaq.approved_reply, product, customer, earlyOrderDraft, pendingOrderAnswerInterrupt),
      handoffRequired: false,
    };
  }

  const productPriceReply = allowLocalKnowledge
    ? productPriceFaq(product, normalizeReplyText(text))
    : null;
  if (productPriceReply) {
    return {
      customerPatch: {
        ...knowledgeAnswerPatch(product, customer, earlyOrderDraft, pendingOrderAnswerInterrupt),
        lastApprovedFaqId: productPriceReply.id,
      },
      messages: knowledgeAnswerMessages(productPriceReply.approved_reply, product, customer, earlyOrderDraft, pendingOrderAnswerInterrupt),
      handoffRequired: false,
    };
  }

  const standardReply = routeAllowsStandardReply(routeClassification)
    ? findStandardReply(catalog, product, text)
    : null;

  if (standardReply) {
    return {
      customerPatch: {
        productId: product.id,
        ...(standardReply.type === "faq"
          ? knowledgeAnswerPatch(product, customer, earlyOrderDraft, pendingOrderAnswerInterrupt)
          : { awaitingPackageBInterest: false }),
      },
      messages:
        standardReply.type === "faq"
          ? knowledgeAnswerMessages(standardReply.reply, product, customer, earlyOrderDraft, pendingOrderAnswerInterrupt)
          : [textMessage(standardReply.reply)],
      handoffRequired: false,
    };
  }

  if (isPoliteClose(text)) {
    return {
      customerPatch: { productId: product.id, awaitingPackageBInterest: false },
      messages: [textMessage("Sama-sama 😊 Boleh, nanti kalau kita kan order atau ada soalan lagi, WhatsApp saja kami di sini. Terima kasih!")],
      handoffRequired: false,
    };
  }

  const orderDraft = earlyOrderDraft;
  if (!pendingOrderAnswerInterrupt && shouldHandleOrderDraft(customer, text, orderDraft, product, ragAnswer, routeClassification)) {
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

  if (approvedFaqMatch?.approvedReply) {
    return {
      customerPatch: {
        ...knowledgeAnswerPatch(product, customer, earlyOrderDraft, pendingOrderAnswerInterrupt),
        lastApprovedFaqId: approvedFaqMatch.faqId,
      },
      messages: knowledgeAnswerMessages(approvedFaqMatch.approvedReply, product, customer, earlyOrderDraft, pendingOrderAnswerInterrupt),
      handoffRequired: false,
    };
  }

  if (salesReplyMatch?.approvedReply) {
    return salesReplyPlan(customer, product, salesReplyFromMatch(salesReplyMatch));
  }

  const faqAnswer = allowLocalKnowledge
    ? findFaqAnswer(product, text)
    : null;
  if (faqAnswer) {
    return {
      customerPatch: knowledgeAnswerPatch(product, customer, earlyOrderDraft, pendingOrderAnswerInterrupt),
      messages: knowledgeAnswerMessages(faqAnswer, product, customer, earlyOrderDraft, pendingOrderAnswerInterrupt),
      handoffRequired: false,
    };
  }

  if (ragAnswer?.reply && (!productSpecificQuestion || ragAnswer.allowProductSpecific)) {
    return ragAnswerConversationPlan(ragAnswer, product, customer, earlyOrderDraft, pendingOrderAnswerInterrupt);
  }

  const clarification = ambiguousQuestionClarification(text, customer, conversationContext);
  if (clarification) {
    return {
      customerPatch: { productId: product.id, awaitingPackageBInterest: false },
      messages: [textMessage(clarification)],
      handoffRequired: false,
    };
  }

  if (DELIVERY_KEYWORDS.test(text) && customer.pendingOrder) {
    return {
      customerPatch: { productId: product.id, awaitingPackageBInterest: false },
      messages: [
        textMessage(
          "Thanks, I noted the delivery detail. Please send the full order details in this format so I can record it cleanly:\nName:\nPhone:\nDelivery address:\nQuantity:"
        ),
      ],
      handoffRequired: false,
    };
  }

  return {
    customerPatch: {
      productId: product.id,
      awaitingPackageBInterest: false,
      handoffStatus: "human_required",
      handoffReason: "No matching sales response, FAQ, or RAG answer.",
    },
    messages: [],
    handoffRequired: true,
    handoffReason: "No matching sales response, FAQ, or RAG answer.",
  };
}

export function usesFixedOpeningFlow(customer, customerMessage, source = {}) {
  const text = String(customerMessage || "").trim();
  if (conversationActiveState(customer)) return false;
  return isLikelyAdOpening(source, text) || Boolean(source.productNameMatch);
}

export function shouldSendProductOpeningFlow(customer = {}, product = null, customerMessage = "", source = {}) {
  const text = String(customerMessage || "").trim();
  if (!product?.id || !text) return false;
  if (conversationActiveState(customer)) return false;
  if (hasOpeningFlowAlreadySent(customer, product)) return false;
  return (
    isLikelyAdOpening(source, text) ||
    source.productNameMatch ||
    sourceHasProductContext(product, source) ||
    isProductNameMessage(product, text) ||
    isProductMentionedInText(product, text)
  );
}

export function isProductOpeningInquiry(product = null, customerMessage = "") {
  if (!product?.id) return false;
  const normalized = normalizeReplyText(customerMessage);
  if (!normalized) return false;
  if (!isProductMentionedInText(product, normalized)) return false;
  return (
    /\b(harga|price|how\s*much|brapa|berapa|promo|promosi|package|pakej|paket|pkg|combo|pm)\b/i.test(normalized) ||
    /\b(order|beli|buy|ambil)\b/i.test(normalized) ||
    /\b(mau|mahu|nak|kan|want)\b.{0,16}\b(order|beli|buy|ambil)\b/i.test(normalized)
  );
}

function isProductMentionedInText(product = null, customerMessage = "") {
  if (!product?.id) return false;
  const normalized = normalizeReplyText(customerMessage);
  if (!normalized) return false;
  const terms = productDetectionTerms(product)
    .map((term) => normalizeReplyText(term))
    .filter((term) => term.length > 2);
  return terms.some((term) => normalized.includes(term));
}

function sourceHasProductContext(product = null, source = {}) {
  if (!product?.id || !source || typeof source !== "object") return false;
  return Boolean(findProductMatch({ products: [product] }, "", source));
}

function hasOpeningFlowAlreadySent(customer = {}, product = null) {
  if (!customer || !product?.id) return false;
  return (
    customer.conversationState === "opening_flow_sent" &&
    String(customer.openingFlowProductId || customer.productId || "") === String(product.id)
  );
}

function routeAllowsFallback(route) {
  return !route || route.confidence === "low";
}

function routeAllowsSalesReply(route) {
  return routeAllowsFallback(route) || ["sales_reply", "purchase_intent"].includes(route.messageType);
}

function routeAllowsKnowledgeAnswer(route) {
  return routeAllowsFallback(route) || ["general_faq", "product_question"].includes(route.messageType);
}

function ragAnswerConversationPlan(ragAnswer, product, customer, earlyOrderDraft, pendingOrderAnswerInterrupt) {
  const shouldUseFaqPrompt = ragAnswer.replyType === "faq" && !ragAnswer.handoffRequired;
  const forceHandoff = replyImpliesHumanCheck(ragAnswer.reply);
  const handoffRequired = Boolean(ragAnswer.handoffRequired || forceHandoff);
  const handoffReason = ragAnswer.handoffReason || (forceHandoff ? "AI reply requires team follow-up." : "");
  return {
    customerPatch: {
      productId: product.id,
      ...(shouldUseFaqPrompt
        ? knowledgeAnswerPatch(product, customer, earlyOrderDraft, pendingOrderAnswerInterrupt)
        : { awaitingPackageBInterest: false }),
      ...(handoffRequired
        ? {
            handoffStatus: "human_required",
            handoffReason: handoffReason || "No approved answer found.",
          }
        : {}),
    },
    messages:
      shouldUseFaqPrompt
        ? knowledgeAnswerMessages(ragAnswer.reply, product, customer, earlyOrderDraft, pendingOrderAnswerInterrupt)
        : [textMessage(ragAnswer.reply)],
    handoffRequired,
    handoffReason,
  };
}

function routeAllowsStandardReply(route) {
  return routeAllowsFallback(route) || ["general_faq", "product_question", "sales_reply"].includes(route.messageType);
}

export function isProductSpecificQuestion(text) {
  const normalized = normalizeReplyText(text);
  if (!normalized) return false;
  return (
    isUsageDurationQuestion(normalized) ||
    isProductOriginQuestion(normalized) ||
    /\b(cara\s*guna|macam\s*mana\s*guna|how\s*to\s*use|cara\s*pakai|how\s*to\s*apply|usage|instruction|fungsi|function|what\s*(is|are).*(function|benefit)|benefit|kebaikan|ingredient|bahan|contains?|contain|spec|specification|berapa\s*ml|volume|size|suction|mode|head|usb|recharge|side\s*effect|allergy|sensitive|warranty|refund|rosak|price|harga|package|pakej|combo|stock|available|origin|made\s*in)\b/i.test(normalized)
  );
}

export function isGeneralBusinessQuestion(text) {
  const normalized = normalizeReplyText(text);
  if (!normalized) return false;
  return /\b(area|location|lokasi|alamat|warehouse|kedai|store|shop|delivery|deliver|hantar|perhantaran|penghantaran|shipping|cod|bayar|payment|caj|charge|fee|runner|pickup|pick\s*up|self\s*collect|barang\s*baru\s*sampai|stock\s*arrival|sampai\s*brunei)\b/i.test(normalized);
}

export function classifyFaqSalesPromptResponse(customer, customerMessage) {
  if (!customer.awaitingPackageBInterest) return "";
  const normalized = normalizeReplyText(customerMessage);
  if (/^(ada|awu|awu ada|ya|yes|boleh|buleh|mau|nak|mahu|minat)$/.test(normalized)) {
    return "interested";
  }
  if (/^(nda minat|inda minat|tidak minat|tak minat|nda|inda|tidak|tak|no)$/.test(normalized)) {
    return "not_interested";
  }
  return "";
}

export function findProduct(catalog, text = "", source = {}, fallbackProductId = "") {
  const enabledProducts = catalog.products.filter((product) => product.openingFlowEnabled !== false);
  const products = enabledProducts.length ? enabledProducts : catalog.products;
  const haystack = [
    text,
    source.adTitle,
    source.adId,
    source.sourceUrl,
    source.productId,
    source.referralBody,
    source.referralHeadline,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const bySourceProductId = catalog.products.find((product) => product.id === source.productId);
  const byFallback = catalog.products.find((product) => product.id === fallbackProductId);
  const byMatch = products.find((product) => {
    const terms = productDetectionTerms(product);
    return terms.some((term) => term && haystack.includes(String(term).toLowerCase()));
  });

  return bySourceProductId || byFallback || byMatch || catalog.products.find((p) => p.id === catalog.default_product_id) || products[0];
}

export function findProductMatch(catalog, text = "", source = {}) {
  const enabledProducts = catalog.products.filter((product) => product.openingFlowEnabled !== false);
  const products = enabledProducts.length ? enabledProducts : catalog.products;
  const haystack = [
    text,
    source.adTitle,
    source.adId,
    source.sourceUrl,
    source.productId,
    source.referralBody,
    source.referralHeadline,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!haystack) return null;
  return products.find((product) =>
    productDetectionTerms(product).some((term) => term && haystack.includes(String(term).toLowerCase()))
  ) || null;
}

export function isProductNameMessage(product, text) {
  const normalized = normalizeReplyText(text);
  if (!normalized) return false;
  const terms = productDetectionTerms(product)
    .map((term) => normalizeReplyText(term))
    .filter((term) => term.length > 2);
  return terms.some((term) => normalized === term);
}

function productDetectionTerms(product) {
  const rawTerms = [
    product.name,
    product.id,
    product.sku_code,
    product.skuCode,
    ...(product.aliases || []),
    ...(product.ad_keywords || []),
  ].filter(Boolean);
  const expandedTerms = rawTerms.flatMap(productDetectionTermVariants);
  return [...new Set(expandedTerms.map((term) => String(term).trim()).filter(Boolean))];
}

function productDetectionTermVariants(term) {
  const original = String(term || "").trim();
  const normalizedTerm = original.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  const withoutLeadingSku = normalizedTerm.replace(/^(?:sku\s*)?[a-z]{1,4}\d{1,5}\s+/i, "").trim();
  const variants = [original, normalizedTerm];
  if (withoutLeadingSku && withoutLeadingSku !== normalizedTerm) variants.push(withoutLeadingSku);
  const words = withoutLeadingSku.split(/\s+/).filter(Boolean);
  if (words.length >= 3) {
    const shortName = words.slice(0, 2).join(" ");
    if (/\d/.test(shortName) || shortName.length >= 8) variants.push(shortName);
  }
  return variants;
}

export function approvedFaqRecordsForProduct(catalog, product, options = {}) {
  const includeGeneral = options.includeGeneral !== false;
  const library = options.faqLibrary || null;
  const libraryRecords = Array.isArray(library?.approved_faqs) ? library.approved_faqs : null;
  const general = includeGeneral
    ? (libraryRecords || catalog.approved_faqs || []).filter((item) => item.active !== false)
    : [];
  const productFaqs = (product?.approved_faqs || []).filter((item) => item.active !== false);
  return [
    ...general.map((item) => ({ ...item, scope: "general", product_id: "" })),
    ...productFaqs.map((item) => ({ ...item, scope: "product", product_id: product.id })),
  ];
}

export function findApprovedFaqExactMatch(catalog, product, text, options = {}) {
  const normalizedText = normalizeReplyText(text);
  const records = approvedFaqRecordsForProduct(catalog, product, {
    includeGeneral: isGeneralBusinessQuestion(text),
    faqLibrary: options.faqLibrary,
  });
  return (
    records.find((item) =>
      (item.example_questions || []).some((question) => normalizeReplyText(question) === normalizedText)
    ) || null
  );
}

export function findApprovedFaqLocalMatch(catalog, product, text, options = {}) {
  const exact = findApprovedFaqExactMatch(catalog, product, text, options);
  if (exact) return exact;
  const records = approvedFaqRecordsForProduct(catalog, product, {
    includeGeneral: isGeneralBusinessQuestion(text) || isContextualGeneralQuestion(text, options.customer, options.conversationContext),
    faqLibrary: options.faqLibrary,
  });
  const contextual = findContextualApprovedFaqMatch(records, text, options.customer, options.conversationContext);
  if (contextual) return contextual;
  return findApprovedFaqHeuristicMatch(records, product, text);
}

export function salesReplyRecordsForProduct(catalog, product, options = {}) {
  const includeGeneral = options.includeGeneral !== false;
  const library = options.salesReplyLibrary || null;
  const libraryRecords = Array.isArray(library?.sales_replies) ? library.sales_replies : null;
  const general = includeGeneral
    ? (libraryRecords
        ? libraryRecords.filter((item) => item.active !== false && (item.scope || "business") !== "product")
        : (catalog.sales_replies || []).filter((item) => item.active !== false))
    : [];
  return [
    ...general.map((item) => ({ ...item, scope: "general", product_id: "" })),
  ];
}

export function approvedProductFactRecordsForProduct(product) {
  if (!product) return [];
  const chunks = (product?.extracted_knowledge?.approvedImages || [])
    .filter((chunk) => chunk && chunk.active !== false && (chunk.summary || chunk.extracted_text || chunk.embedding_text || chunk.brunei_malay_summary || chunk.brunei_malay_search_text))
    .map((chunk, index) => {
      const safeChunk = sanitizeImageKnowledgeChunk(chunk);
      return {
        ...safeChunk,
        kind: "image_chunk",
        id: safeChunk.id || `${product.id}_image_${index + 1}`,
        product_id: product.id,
        product_name: product.name,
        label: safeChunk.title || "Image knowledge",
        value: safeChunk.brunei_malay_summary || safeChunk.summary || safeChunk.extracted_text || safeChunk.embedding_text,
        approved_reply: formatImageChunkReply(safeChunk),
        active: safeChunk.active !== false,
      };
    });
  return chunks;
}

export function findSalesReplyExactMatch(catalog, product, text, options = {}) {
  const normalizedText = normalizeReplyText(text);
  const records = salesReplyRecordsForProduct(catalog, product, options);
  const anotherDateReply = findAnotherDatePurchaseReply(records, normalizedText);
  if (anotherDateReply) return anotherDateReply;
  const intentReply = findSalesReplyIntentMatch(records, normalizedText);
  if (intentReply) return intentReply;
  return (
    records.find((item) =>
      (item.example_messages || []).some((message) => salesReplyExampleMatches(normalizedText, message))
    ) || null
  );
}

function findSalesReplyIntentMatch(records, normalizedText) {
  const intent = classifySalesIntent(normalizedText);
  if (!intent) return null;
  return records.find((item) => salesReplyIntentKey(item) === intent) || null;
}

function classifySalesIntent(text) {
  const normalized = normalizeReplyText(text);
  if (!normalized) return "";
  if (looksLikeAnotherDatePurchaseMessage(normalized)) return "another_date_purchase";
  if (/\b(not interested|no interest|nda minat|inda minat|tak minat|tidak minat|next time|lain kali|nanti saja|nanti sja|maybe next time)\b/i.test(normalized)) {
    return "not_interested";
  }
  if (/\b(payday|gaji|salary|budget|bajet|duit|money|bayar|payment)\b/i.test(normalized) &&
      /\b(tunggu|nanti|belum|after|lapas|lepas|baru|cukup|later|pay\s*later)\b/i.test(normalized)) {
    return "payday_only_pay";
  }
  if (/\b(mahal|expensive|too much|harga tinggi|price high|over budget|overbudget)\b/i.test(normalized)) {
    return "too_expensive";
  }
  if (/\b(discount|diskaun|kurang|less|nego|negotiate|murah sikit|boleh kurang|best price)\b/i.test(normalized)) {
    return "price_objection_negotiation";
  }
  if (/\b(fikir|pikir|think|thinking|consider|timbang|tanya dulu|ask first|confirm dulu|check dulu|liat dulu|lihat dulu|nanti dulu|tunggu dulu)\b/i.test(normalized)) {
    return "thinking_first";
  }
  if (isQuestionLike(normalized) || isOrderStartIntent(normalized)) return "";
  return "";
}

function isQuestionLike(normalizedText) {
  return /\?$/.test(normalizedText) ||
    /\b(kah|ka|kh)\s*$/i.test(normalizedText) ||
    /^(apa|ada|berapa|buleh|boleh|can|do|does|is|are|where|when|how|why|macam mana|mana|caj|harga)\b/i.test(normalizedText);
}

function findAnotherDatePurchaseReply(records, normalizedText) {
  if (!looksLikeAnotherDatePurchaseMessage(normalizedText)) return null;
  return records.find((item) => salesReplyIntentKey(item) === "another_date_purchase") || null;
}

function looksLikeAnotherDatePurchaseMessage(normalizedText) {
  const text = String(normalizedText || "");
  if (!text) return false;
  if (/\b\d{1,2}\s*[\/.-]\s*\d{1,2}(?:\s*[\/.-]\s*\d{2,4})?\b/.test(text)) return true;
  if (/\b\d{1,2}\s*(?:jan|january|feb|february|mac|march|apr|april|may|mei|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december|dis|disember)\b/i.test(text)) return true;
  if (/\b(next month|bulan depan|minggu depan|next week|esok|bisuk|tomorrow)\b/i.test(text)) return true;
  if (/\b(tunggu|lapas|lepas|after|bila|when|nanti)\b/i.test(text) && /\b(gaji|payday|salary)\b/i.test(text)) return true;
  return false;
}

function salesReplyExampleMatches(normalizedText, example) {
  const normalizedExample = normalizeReplyText(example);
  if (!normalizedText || !normalizedExample) return false;
  if (normalizedText === normalizedExample) return true;
  if (normalizedExample.length < 6 || !/\s/.test(normalizedExample)) return false;
  return new RegExp(`(^|\\b)${escapeRegExp(normalizedExample)}(\\b|$)`, "i").test(normalizedText);
}

export function textMessage(body) {
  return { type: "text", body };
}

export function imageMessage(url, caption = "") {
  return { type: "image", url, caption };
}

export function productIntro(product) {
  return `Hi! Thanks for messaging us. ${product.name} is ${product.price}. Would you like product details or help placing an order?`;
}

export function formatStockArrivalMessage(product) {
  return `Good news, ${product.name} stock has arrived.\n\nPlease reply with your preferred delivery date and time so we can arrange delivery.`;
}

function isLikelyAdOpening(source, text) {
  return (
    Boolean(source.sourceUrl || source.adId || source.referralHeadline) ||
    /^(hi|hello|hai|helo|interested)$/i.test(text) ||
    /\b(berminat|interested|saya berminat|mau info|nak info)\b/i.test(text)
  );
}

function findFaqAnswer(product, text) {
  const normalized = text.toLowerCase();
  for (const faq of product.faqs || []) {
    const questionTerms = String(faq.question || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 2 && !FAQ_STOPWORDS.has(term));
    if (questionTerms.length === 0) continue;
    const matchedTerms = questionTerms.filter((term) => normalized.includes(term));
    const neededMatches = questionTerms.length === 1 ? 1 : 2;
    if (matchedTerms.length >= neededMatches) return faq.answer;
  }
  return "";
}

const FAQ_STOPWORDS = new Set([
  "apa",
  "ada",
  "boleh",
  "untuk",
  "yang",
  "mana",
  "macam",
  "mana",
  "berapa",
  "kita",
]);

function findStandardReply(catalog, product, text) {
  const normalizedText = normalizeReplyText(text);
  const replies = [...(catalog.standard_replies || []), ...(product.standard_replies || [])]
    .filter((item) => item.type !== "sales_response");
  for (const item of replies) {
    const messages = item.customer_messages || item.triggers || [];
    if (messages.some((message) => normalizeReplyText(message) === normalizedText)) {
      return item;
    }
  }
  return null;
}

function findApprovedFaqHeuristicMatch(records, product, text) {
  const normalized = normalizeReplyText(text);
  const findRecord = (id) => records.find((item) => item.id === id && item.active !== false) || null;

  if (
    (
      /\b(area|location|lokasi|alamat)\b/i.test(normalized) ||
      /\b(business|kedai|warehouse|store|shop)\b.*\b(mana|di mana|kat mana)\b/i.test(normalized) ||
      /\b(mana|di mana|kat mana)\b.*\b(business|kedai|warehouse|store|shop)\b/i.test(normalized)
    ) &&
    !/\b(delivery|deliver|hantar|perhantaran|penghantaran|shipping)\b/i.test(normalized)
  ) {
    return findRecord("general_business_location");
  }

  if (/\b(perhantaran|penghantaran|hantar|deliver|delivery|shipping)\b/i.test(normalized)) {
    if (/\b(caj|charge|fee|bayar|payment|free|harga|termasuk|include|included)\b/i.test(normalized)) {
      return findRecord("general_delivery_fee");
    }
    if (/\b(rumah|home|alamat|address|ada|boleh|buleh|dapat)\b/i.test(normalized)) {
      return findRecord("general_delivery_available");
    }
  }

  const productPrice = productPriceFaq(product, normalized);
  if (productPrice) return productPrice;

  return null;
}

function findContextualApprovedFaqMatch(records, text, customer = {}, conversationContext = []) {
  const normalized = normalizeReplyText(text);
  const findRecord = (id) => records.find((item) => item.id === id && item.active !== false) || null;
  if (
    /\b(caj|charge|fee)\b/i.test(normalized) &&
    hasDeliveryContext(customer, conversationContext)
  ) {
    return findRecord("general_delivery_fee");
  }
  return null;
}

function isContextualGeneralQuestion(text, customer = {}, conversationContext = []) {
  const normalized = normalizeReplyText(text);
  return /\b(caj|charge|fee|bayar|payment|free)\b/i.test(normalized) &&
    hasDeliveryContext(customer, conversationContext);
}

function ambiguousQuestionClarification(text, customer = {}, conversationContext = []) {
  const normalized = normalizeReplyText(text);
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (!normalized || wordCount > 5) return "";
  if (isProductSpecificQuestion(normalized)) return "";
  if (isPoliteClose(normalized) || isOrderStartIntent(normalized)) return "";

  const asksCharge = /\b(caj|charge|fee|bayar|payment|free)\b/i.test(normalized);
  const asksBareAmount = /^(berapa|how much|how many|ada berapa|brapa)\??$/i.test(normalized);
  const asksBareOption = /^(yang mana|mana satu|which one|yg mana|apa|ada|boleh|buleh)\??$/i.test(normalized);
  const asksBareReference = /\b(itu|ani|ni|this|that|tadi)\b/i.test(normalized);
  if (!(asksCharge || asksBareAmount || asksBareOption || asksBareReference)) return "";

  const topic = recentConversationTopic(conversationContext, customer);
  if (asksCharge && topic === "delivery") {
    return "Kita maksudkan caj delivery kah?";
  }
  if (asksBareAmount && topic === "price") {
    return "Kita maksudkan harga package yang mana ya?";
  }
  if (asksBareOption && topic === "order") {
    return "Kita maksudkan pilihan order yang mana ya?";
  }
  if (topic === "delivery") {
    return "Kita maksudkan pasal delivery kah?";
  }
  if (topic === "price") {
    return "Kita maksudkan pasal harga kah?";
  }
  if (topic === "product") {
    return "Kita maksudkan pasal produk yang mana ya?";
  }
  return "Kita maksudkan yang mana ya? Delivery, harga, atau produk?";
}

function hasDeliveryContext(customer = {}, conversationContext = []) {
  if (["general_delivery_available", "general_delivery_or_pickup"].includes(String(customer?.lastApprovedFaqId || ""))) {
    return true;
  }
  return recentConversationTopic(conversationContext, customer) === "delivery";
}

function recentConversationTopic(conversationContext = [], customer = {}) {
  const recentText = (Array.isArray(conversationContext) ? conversationContext : [])
    .slice(-8)
    .map((item) => normalizeReplyText(item?.text || item?.body || item?.caption || ""))
    .filter(Boolean)
    .join(" ");
  if (/\b(delivery|deliver|hantar|perhantaran|penghantaran|shipping|runner|cod|rumah|alamat|address)\b/i.test(recentText)) {
    return "delivery";
  }
  if (/\b(harga|price|promo|package|pakej|combo|unit|discount|diskaun)\b/i.test(recentText)) {
    return "price";
  }
  if (/\b(order|beli|mau|nak|ambil|full name|full address|phone number|add-on|add on)\b/i.test(recentText) || customer?.pendingOrder) {
    return "order";
  }
  if (/\b(cara guna|fungsi|benefit|kegunaan|ingredient|side effect|warranty|berapa ml|produk|product)\b/i.test(recentText)) {
    return "product";
  }
  return "";
}

function productPriceFaq(product, normalizedText) {
  if (isUsageDurationQuestion(normalizedText)) return null;
  if (/\b(ml|milliliter|millilitre|volume|isi|berapa\s*ml|berapa\s*mililiter)\b/i.test(normalizedText)) return null;
  if (!/(harga|price|promo|promosi|offer|deal|b\\$|\$|\bberapa\b.*\b(unit|package|pakej|combo|satu|1)\b|\b(unit|package|pakej|combo|satu|1)\b.*\bberapa\b)/i.test(normalizedText)) return null;
  const options = orderOptionsForProduct(product);
  if (!options.length) return null;

  const selected = options.filter((option) => {
    const terms = [option.id, option.name, ...(option.aliases || [])].map((item) => normalizeReplyText(item)).filter(Boolean);
    return terms.some((term) => term.length > 1 && normalizedText.includes(term));
  });
  const rows = (selected.length ? selected : options)
    .map((option) => `${option.name}: ${option.price}${option.requiresAddOn ? " termasuk 1 add-on pilihan" : ""}`)
    .join(". ");
  if (!rows) return null;

  return {
    id: `${product.id}_order_option_price`,
    topic: "Order option prices",
    approved_reply: rows,
    active: true,
  };
}

function isUsageDurationQuestion(normalizedText) {
  return /\b(berapa\s*lama|how\s*long|guna\s*berapa\s*lama|tahan\s*berapa\s*lama|last\s*how\s*long|one\s*bottle|satu\s*botol)\b/i.test(normalizedText) &&
    /\b(guna|pakai|use|last|lama|tahan|bottle|botol)\b/i.test(normalizedText);
}

function isProductOriginQuestion(normalizedText) {
  return /\b(from\s*where|where\s*(is|are|this|the)?.*(product|barang)|product\s*(from|made)|made\s*in|asal\s*(mana|dari)|dari\s*mana|barang\s*mana|produk\s*(dari|asal))\b/i.test(normalizedText);
}

function formatImageChunkReply(chunk, normalizedQuestion = "") {
  const text = String(chunk.brunei_malay_summary || chunk.summary || chunk.extracted_text || chunk.embedding_text || chunk.value || "").trim();
  const fullText = [
    chunk.summary,
    chunk.extracted_text,
    chunk.embedding_text,
    chunk.brunei_malay_summary,
    chunk.brunei_malay_search_text,
    chunk.value,
  ].filter(Boolean).join("\n");
  const category = String(chunk.category || "").toLowerCase();
  if (/\bcod\b/i.test(normalizedQuestion) && /\bcod\b/i.test(fullText)) {
    return "Boleh, COD to all Brunei ya.";
  }
  if (/\b(refund|warranty|rosak)\b/i.test(normalizedQuestion) && /\b(refund|rosak)\b/i.test(text)) {
    const refund = text.match(/\b\d+\s*hari\s*rosak\s*[-–—]?\s*100%\s*fully\s*refund\b/i)?.[0];
    if (refund) return `${refund}.`;
  }
  if (/\b(volume|ml|milliliter|millilitre)\b/i.test(`${chunk.title || ""} ${text}`)) {
    const volume = text.match(/\b\d+(?:\.\d+)?\s*(?:ml|mL|ML|fl\.?\s*oz\.?)\b/i)?.[0];
    if (volume) return `Isinya ${volume} ya.`;
  }
  if (category === "feature" && text) {
    return "";
  }
  if (category === "price") {
    const unit = fullText.match(/\b1\s*unit\s*=\s*(?:B?\$)\s*\d+/i)?.[0]?.replace(/\s+/g, " ");
    const combo = fullText.match(/\b(?:best\s*seller\s*)?combo:?\s*(?:B?\$)\s*\d+/i)?.[0]?.replace(/\s+/g, " ");
    if (unit || combo) return [unit, combo].filter(Boolean).join(". ");
  }
  return String(chunk.brunei_malay_summary || chunk.summary || chunk.extracted_text || chunk.embedding_text || chunk.value || "").trim();
}

function isPoliteClose(text) {
  const normalized = normalizeReplyText(text);
  return (
    /\b(tq|thank|thanks|terima kasih|makasih|info)\b/i.test(normalized) &&
    /\b(nanti|kalau|klau|klu|if|mau|kan|txt|text|wassap|whatsapp|wa|lagi)\b/i.test(normalized) &&
    !/\b(order|beli|ambil|proceed|lock|book)\b/i.test(normalized)
  );
}

function isNeutralAcknowledgement(text) {
  const normalized = normalizeReplyText(text)
    .replace(/[.!?,]+$/g, "")
    .trim();
  if (!normalized) return false;
  return /^(ok|okay|oki|okey|noted|noted kita|baik|baik kita|awu|awu kita|bah|bah kita|alright|sure|yes|ya|yea|yup|thanks|tq|terima kasih|thank you)$/.test(normalized);
}

function legacyStandardSalesReply(product, item, index) {
  const examples = item.customer_messages || item.triggers || [];
  const label = examples[0] || item.reply || `sales response ${index + 1}`;
  return {
    id: `${product.id}_legacy_sales_${safeIdSegment(label)}_${index + 1}`,
    objection_type: label,
    intent: `Customer gives this sales response or hesitation: ${label}`,
    example_messages: examples,
    approved_reply: item.reply || "",
    active: item.active !== false,
    legacy_standard_reply: true,
  };
}

function safeIdSegment(value) {
  return String(value || "reply")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "reply";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function faqReplyMessages(answer, product, customer) {
  const messages = [textMessage(answer)];
  if (shouldSendKnowledgeSalesPrompt(product, customer)) {
    messages.push(textMessage(salesPromptForProduct(product)));
  }
  return messages;
}

function knowledgeAnswerPatch(product, customer, orderDraft, pendingOrderAnswerInterrupt) {
  if (!pendingOrderAnswerInterrupt) {
    return { productId: product.id, ...faqSalesPromptPatch(product, customer) };
  }
  return {
    ...salesConversationClosedPatch(customer, false),
    productId: product.id,
    awaitingPackageBInterest: false,
    pendingOrder: pendingOrderPatch(product.id, customer.pendingOrder, orderDraft),
  };
}

function knowledgeAnswerMessages(answer, product, customer, orderDraft, pendingOrderAnswerInterrupt) {
  const messages = pendingOrderAnswerInterrupt
    ? [textMessage(answer)]
    : faqReplyMessages(answer, product, customer);
  return appendPendingOrderReminder(messages, product, orderDraft, pendingOrderAnswerInterrupt);
}

function appendPendingOrderReminder(messages, product, orderDraft, shouldAppend) {
  if (!shouldAppend) return messages;
  const reminder = pendingOrderReminderText(product, orderDraft);
  return reminder ? [...messages, textMessage(reminder)] : messages;
}

function pendingOrderReminderText(product, orderDraft) {
  const missing = missingOrderFields(product, orderDraft);
  if (!missing.length) return "";
  const form = orderFormConfig(product);
  const labels = missing.map((field) => {
    if (field === "name") return orderFormPlainLabel(form, "name");
    if (field === "phone") return orderFormPlainLabel(form, "phone");
    if (field === "address") return orderFormPlainLabel(form, "address");
    if (field === "orderOption") return orderFormPlainLabel(form, "option");
    if (field === "addOnChoice") return "add-on choice";
    return field;
  });
  return `Untuk order kita tadi, tinggal ${labels.join(", ")} saja lagi ya.`;
}

function faqSalesPromptProductKey(product) {
  return String(product?.id || "default");
}

function salesPromptFrequencyForProduct(product) {
  const raw = product?.sales_prompt_frequency ?? product?.salesPromptFrequency ?? 1;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(20, Math.trunc(value)));
}

function faqSalesPromptCountForProduct(customer, product) {
  const counts = customer?.faqSalesPromptCounts && typeof customer.faqSalesPromptCounts === "object"
    ? customer.faqSalesPromptCounts
    : {};
  const value = Number(counts[faqSalesPromptProductKey(product)] || 0);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function nextFaqSalesPromptCount(customer, product) {
  return faqSalesPromptCountForProduct(customer, product) + 1;
}

function shouldSendFaqSalesPrompt(product, customer) {
  const frequency = salesPromptFrequencyForProduct(product);
  if (frequency <= 0) return false;
  if (!salesPromptForProduct(product)) return false;
  return nextFaqSalesPromptCount(customer, product) % frequency === 0;
}

function shouldSendKnowledgeSalesPrompt(product, customer) {
  return !suppressesKnowledgeSalesPrompt(customer) && shouldSendFaqSalesPrompt(product, customer);
}

function faqSalesPromptPatch(product, customer) {
  if (conversationActiveState(customer) === "awaitingPackageInterest") {
    return { awaitingPackageBInterest: true };
  }
  if (suppressesKnowledgeSalesPrompt(customer)) {
    return { awaitingPackageBInterest: false };
  }
  const key = faqSalesPromptProductKey(product);
  const nextCount = nextFaqSalesPromptCount(customer, product);
  return {
    faqSalesPromptCounts: {
      ...(customer?.faqSalesPromptCounts && typeof customer.faqSalesPromptCounts === "object" ? customer.faqSalesPromptCounts : {}),
      [key]: nextCount,
    },
    awaitingPackageBInterest: shouldSendFaqSalesPrompt(product, customer),
  };
}

function suppressesKnowledgeSalesPrompt(customer) {
  return ["awaitingPackageInterest", "pendingOrder", "submittedOrder", "done", "handoff", "anotherDatePurchase", "salesClosed", "optedOut"].includes(
    conversationActiveState(customer)
  );
}

function salesReplyMessages(salesReply) {
  return [textMessage(salesReply.approved_reply)];
}

function salesReplyFromMatch(match = {}) {
  return {
    id: match.salesReplyId,
    sales_intent: match.salesIntent,
    objection_type: match.objectionType || match.salesIntent || "",
    intent: match.intent || "",
    approved_reply: match.approvedReply,
    repeat_action: match.repeatAction,
    after_reply: match.afterReply || match.after_reply,
  };
}

function salesReplyPlan(customer, product, salesReply) {
  const intentKey = salesReplyIntentKey(salesReply);
  const nowIso = new Date().toISOString();
  const afterReply = salesReplyAfterReplyAction(salesReply);
  const closeAfterReply = afterReply === SALES_AFTER_REPLY_CLOSE;
  const alreadyClosed = conversationActiveState(customer) === "salesClosed";
  if (customer?.lastSalesReplyIntent === intentKey && customer?.lastSalesReplyId) {
    return {
      customerPatch: {
        ...(alreadyClosed || closeAfterReply ? salesConversationClosedPatch(customer, true) : {}),
        productId: product.id,
        awaitingPackageBInterest: false,
        lastRepeatedSalesReplyId: salesReply.id,
        lastRepeatedSalesReplyIntent: intentKey,
        lastRepeatedSalesReplyAt: nowIso,
      },
      messages: [],
      handoffRequired: false,
      repeatedSalesReply: {
        salesReplyId: salesReply.id || "",
        salesIntent: intentKey,
        action: salesReplyRepeatAction(salesReply),
        afterReply,
        approvedReply: salesReply.approved_reply || "",
      },
    };
  }
  return {
    customerPatch: {
      ...salesConversationClosedPatch(customer, closeAfterReply),
      productId: product.id,
      awaitingPackageBInterest: false,
      lastSalesReplyId: salesReply.id,
      lastSalesReplyIntent: intentKey,
      lastSalesReplyAt: nowIso,
      ...(intentKey === "another_date_purchase"
        ? {
            status: "another_date_purchase",
            salesStatus: "another_date_purchase",
            followupBlocked: true,
            followupBlockedReason: "another_date_purchase",
          }
        : {}),
    },
    messages: salesReplyMessages(salesReply),
    handoffRequired: false,
  };
}

function salesReplyIntentKey(salesReply = {}) {
  const raw = String(
    salesReply.sales_intent ||
    salesReply.intent_key ||
    salesReply.objection_type ||
    salesReply.id ||
    "general_sales_reply"
  ).trim();
  return normalizeReplyText(raw).replace(/\s+/g, "_") || "general_sales_reply";
}

function salesReplyRepeatAction(salesReply = {}) {
  const action = String(salesReply.repeat_action || salesReply.repeatAction || "openai_acknowledge").trim();
  return ["openai_acknowledge", "opt_out", "handoff"].includes(action) ? action : "openai_acknowledge";
}

function replyImpliesHumanCheck(reply) {
  const normalized = normalizeReplyText(reply);
  return /\b(team|admin|staff|orang|human)\b.*\b(check|cek|reply|balas|confirm)\b/i.test(normalized) ||
    /\b(check|cek|confirm)\b.*\b(team|admin|staff|orang|human)\b/i.test(normalized) ||
    /\b(minta|forward|refer|escalate)\b.*\b(team|admin|staff|orang|human)\b/i.test(normalized) ||
    /\b(reply|balas)\s+(kita|you)\s+(sekejap|nanti)\b/i.test(normalized);
}

function orderFormMessages(product) {
  return [textMessage(orderFormText(product))];
}

function orderClosingMessages(product) {
  const hasSavedMessages = Array.isArray(product?.order_closing_messages);
  const messages = hasSavedMessages ? product.order_closing_messages : DEFAULT_ORDER_CLOSING_MESSAGES;
  const cleaned = messages
    .map((message) => String(message || "").trim())
    .filter(Boolean);
  return cleaned.map(textMessage);
}

function incompleteOrderMessages(product, orderDraft) {
  if (orderDraft.unsupportedQuantity || orderDraft.unsupportedOrderOption) {
    return [textMessage(unsupportedOrderOptionReply(product, orderDraft))];
  }
  if (!orderDraft.hasAnyDetails) {
    return [textMessage(orderFormText(product))];
  }
  const missing = missingOrderFields(product, orderDraft);
  if (!missing.length) {
    return [textMessage(orderFormText(product))];
  }
  return [textMessage(missingOrderReply(product, orderDraft, missing))];
}

function unsupportedOrderOptionReply(product, orderDraft = {}) {
  const options = formatOrderOptionsForReply(product);
  const requested = orderDraft.requestedQuantity ? `${orderDraft.requestedQuantity} unit` : "option atu";
  return [
    `Untuk ${requested}, option atu belum ada dalam pilihan order masa ani.`,
    options ? `Option yang ada: ${options}` : "Boleh pilih dari order option yang kami sediakan ya.",
    "Kita mau pilih yang mana?",
  ].join("\n");
}

function formatOrderOptionsForReply(product) {
  return orderOptionsForProduct(product)
    .map((option) => {
      const pieces = [option.name];
      const quantity = Number(option.total_units || option.quantity || 0);
      if (quantity > 0 && !new RegExp(`\\b${quantity}\\s*unit\\b`, "i").test(option.name)) {
        pieces.push(`${quantity} unit`);
      }
      if (option.price) pieces.push(option.price);
      return pieces.filter(Boolean).join(" - ");
    })
    .filter(Boolean)
    .join(" / ");
}

function missingOrderReply(product, orderDraft, missing) {
  const form = orderFormConfig(product);
  const first = missing[0];
  if (missing.length === 1) {
    if (first === "name") return `Noted kita, tinggal ${orderFormDisplayLabel(form, "name")} saja lagi \uD83D\uDE0A\nBoleh share ${orderFormPlainLabel(form, "name")} kita?`;
    if (first === "phone") return `Noted kita, tinggal ${orderFormDisplayLabel(form, "phone")} saja lagi \uD83D\uDE0A\nBoleh share ${orderFormPlainLabel(form, "phone")} kita?`;
    if (first === "address") return `Noted kita, tinggal ${orderFormDisplayLabel(form, "address")} saja lagi \uD83D\uDE0A\nBoleh share ${orderFormPlainLabel(form, "address")} untuk delivery?`;
    if (first === "orderOption") {
      const options = orderOptionsForProduct(product).map((option) => option.name).filter(Boolean).join(" / ");
      return `Noted kita, tinggal pilih ${orderFormPlainLabel(form, "option")} saja lagi \uD83D\uDE0A\nKita mau yang mana${options ? `: ${options}` : ""}?`;
    }
    if (first === "addOnChoice") {
      const option = optionFromDraft(orderDraft, product);
      const addOns = option?.addOns?.length ? option.addOns.join(" / ") : "add-on choice";
      return `Noted kita, untuk ${orderDraft.orderOptionName || "combo"} ani tinggal pilih add-on saja lagi \uD83D\uDE0A\nKita mau ${addOns}?`;
    }
  }

  const labels = missing.map((field) => {
    if (field === "name") return orderFormPlainLabel(form, "name");
    if (field === "phone") return orderFormPlainLabel(form, "phone");
    if (field === "address") return orderFormPlainLabel(form, "address");
    if (field === "orderOption") return orderFormPlainLabel(form, "option");
    if (field === "addOnChoice") return "add-on choice";
    return field;
  });
  return [
    `Noted kita, masih kurang ${labels.join(", ")} saja lagi \uD83D\uDE0A`,
    "Boleh share detail ani untuk kami hold promo?",
    "",
    ...missingOrderFormLines(product, missing),
  ].join("\n");
}

function missingOrderFormLines(product, missing) {
  const form = orderFormConfig(product);
  const lines = [];
  if (missing.includes("name")) lines.push(orderFormFieldLine(form, "name"));
  if (missing.includes("address")) lines.push(orderFormFieldLine(form, "address"));
  if (missing.includes("phone")) lines.push(orderFormFieldLine(form, "phone"));
  if (missing.includes("orderOption")) {
    const options = orderOptionsForProduct(product).map((option) => option.name).filter(Boolean).join(" / ");
    lines.push(orderFormFieldLine(form, "option", options));
  }
  if (missing.includes("addOnChoice")) lines.push("Add-on choice :");
  return lines;
}

function salesPromptForProduct(product) {
  return String(product?.sales_prompt || "").trim();
}

function orderFormText(product) {
  const form = orderFormConfig(product);
  const options = orderOptionsForProduct(product);
  const optionNames = options.map((option) => option.name).filter(Boolean).join(" / ");
  const requiresAddOn = options.some((option) => option.requiresAddOn);
  return [
    form.intro,
    "",
    orderFormFieldLine(form, "name"),
    orderFormFieldLine(form, "address"),
    orderFormFieldLine(form, "phone"),
    orderFormFieldLine(form, "option", optionNames),
    ...(requiresAddOn ? ["Add-on choice :"] : []),
  ].join("\n");
}

function orderFormConfig(product) {
  const saved = product?.order_form && typeof product.order_form === "object" ? product.order_form : {};
  return {
    intro: cleanOrderFormText(saved.intro, DEFAULT_ORDER_FORM.intro),
    nameLabel: cleanOrderFormText(saved.nameLabel || saved.name_label, DEFAULT_ORDER_FORM.nameLabel),
    addressLabel: cleanOrderFormText(saved.addressLabel || saved.address_label, DEFAULT_ORDER_FORM.addressLabel),
    phoneLabel: cleanOrderFormText(saved.phoneLabel || saved.phone_label, DEFAULT_ORDER_FORM.phoneLabel),
    optionLabel: cleanOrderFormText(saved.optionLabel || saved.option_label, DEFAULT_ORDER_FORM.optionLabel),
  };
}

function cleanOrderFormText(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function orderFormPlainLabel(form, field) {
  const label = {
    name: form.nameLabel,
    address: form.addressLabel,
    phone: form.phoneLabel,
    option: form.optionLabel,
  }[field] || field;
  if (field === "name" && label === DEFAULT_ORDER_FORM.nameLabel) return "nama penuh";
  if (field === "address" && label === DEFAULT_ORDER_FORM.addressLabel) return "alamat penuh";
  return label.replace(/^[^\p{L}\p{N}]+/u, "").trim().toLowerCase() || label.toLowerCase();
}

function orderFormDisplayLabel(form, field) {
  const label = {
    name: form.nameLabel,
    address: form.addressLabel,
    phone: form.phoneLabel,
    option: form.optionLabel,
  }[field] || field;
  return label.replace(/^[^\p{L}\p{N}]+/u, "").trim().toLowerCase() || label.toLowerCase();
}

function orderFormFieldLine(form, field, value = "") {
  const icon = { name: "\u2705", address: "\uD83C\uDFE0", phone: "\uD83D\uDCF1", option: "" }[field] || "";
  const label = {
    name: form.nameLabel,
    address: form.addressLabel,
    phone: form.phoneLabel,
    option: form.optionLabel,
  }[field] || field;
  const prefix = icon ? `${icon} ${label}` : label;
  return `${prefix} :${value ? ` ${value}` : ""}`;
}

function uniqueFieldAliases(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function normalizeCustomerMessage(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}\s/+.$@:'-]/gu, " ")
    .replace(/\bcollect\s+sendiri\b/g, "pickup sendiri")
    .replace(/\bbrg\b/g, "barang")
    .replace(/\b(?:sja|sj|saje)\b/g, "saja")
    .replace(/\b(?:tungu|tnggu|tggu|tungguu)\b/g, "tunggu")
    .replace(/\b(?:blom|balum|lum|belom|blum)\b/g, "belum")
    .replace(/\b(?:bajet)\b/g, "budget")
    .replace(/\b(?:nda|inda|indah)\b/g, "tidak")
    .replace(/\b(?:tdk|tak)\b/g, "tidak")
    .replace(/\b(?:brpa|brp|bpa)\b/g, "berapa")
    .replace(/\b(?:klu|klau|klo)\b/g, "kalau")
    .replace(/\b(?:utk|untk|untok)\b/g, "untuk")
    .replace(/\b(?:pakej|paket|pkg)\b/g, "package")
    .replace(/\b(?:gaji|salary)\b/g, "payday")
    .replace(/\bke\s*$/g, "kah")
    .replace(/[?!.,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeReplyText(value) {
  return normalizeCustomerMessage(value);
}

export function extractOrderDetails(text, product) {
  const normalizedText = normalizeOrderFormText(text);
  const availableOptions = orderOptionsForProduct(product);
  const form = orderFormConfig(product);
  let orderOptionChoice = extractOrderOptionChoice(normalizedText, product);
  const requestedQuantity = extractRequestedUnitQuantity(normalizedText);
  if (!orderOptionChoice && requestedQuantity) {
    orderOptionChoice = findOrderOptionByQuantity(product, requestedQuantity);
  }
  const unsupportedQuantity = Boolean(requestedQuantity && availableOptions.length && !orderOptionChoice);
  const freeForm = extractFreeFormOrderDetails(normalizedText);
  const name = fieldValue(normalizedText, uniqueFieldAliases([form.nameLabel, "full name", "name", "nama"])) || freeForm.name;
  const phone = fieldValue(normalizedText, uniqueFieldAliases([form.phoneLabel, "phone number", "phone", "tel", "mobile", "whatsapp"])) || freeForm.phone;
  const address = fieldValue(normalizedText, uniqueFieldAliases([form.addressLabel, "full address", "delivery address", "address", "alamat"])) || freeForm.address;
  if (!orderOptionChoice && availableOptions.length === 1 && (name || phone || address)) {
    orderOptionChoice = availableOptions[0];
  }
  const quantity = Number(
    orderOptionChoice?.total_units ||
      orderOptionChoice?.quantity ||
      normalizedText.match(/\b(?:qty|quantity|jumlah|x)\s*:?\s*(\d+)\b/i)?.[1] ||
      normalizedText.match(/\b(\d+)\s*(?:pcs|pc|unit|units)\b/i)?.[1] ||
      1
  );
  const addOnChoice = extractAddOnChoice(normalizedText, orderOptionChoice);
  const optionComplete = Boolean(orderOptionChoice) && (!orderOptionChoice.requiresAddOn || Boolean(addOnChoice));
  return {
    packageId: orderOptionChoice?.legacyPackage ? legacyPackageId(orderOptionChoice) : "",
    packageName: orderOptionChoice?.legacyPackage ? orderOptionChoice.name : "",
    packagePrice: orderOptionChoice?.legacyPackage ? orderOptionChoice.price : "",
    orderOptionId: orderOptionChoice?.id || "",
    orderOptionName: orderOptionChoice?.name || "",
    orderOptionPrice: orderOptionChoice?.price || "",
    addOnChoice,
    requiresAddOn: Boolean(orderOptionChoice?.requiresAddOn),
    quantity,
    requestedQuantity,
    unsupportedQuantity,
    unsupportedOrderOption: unsupportedQuantity,
    name,
    phone,
    address,
    hasAnyDetails: Boolean(
      orderOptionChoice ||
        addOnChoice ||
        name ||
        phone ||
        address ||
        unsupportedQuantity ||
        /\b\d+\s*(pcs|pc|unit|units)\b/i.test(normalizedText)
    ),
    isComplete: Boolean(optionComplete && name && phone && address && quantity > 0),
  };
}

function mergePendingOrderDraft(customer, currentDraft, text, product) {
  const pending = customer?.pendingOrder;
  const pendingDraft = pending?.productId === product?.id ? pending.draft || {} : {};
  const previous = normalizeStoredOrderDraft(pendingDraft);
  const previousMissing = missingOrderFields(product, previous);
  const plainText = String(text || "").trim();
  const hasLabelledField = hasOrderFormFields(currentDraft) || Boolean(currentDraft.orderOptionId || currentDraft.addOnChoice);
  const currentChatPhone = inferPhoneFromCurrentChatRequest(plainText, customer?.id);
  const inferred = !hasLabelledField && previousMissing.length === 1
    ? inferSingleMissingField(previousMissing[0], plainText, previous, product)
    : {};
  const hasInferredDetail = Object.keys(inferred).length > 0 || Boolean(currentChatPhone);
  const merged = {
    ...currentDraft,
    packageId: currentDraft.packageId || previous.packageId || "",
    packageName: currentDraft.packageName || previous.packageName || "",
    packagePrice: currentDraft.packagePrice || previous.packagePrice || "",
    orderOptionId: currentDraft.orderOptionId || previous.orderOptionId || "",
    orderOptionName: currentDraft.orderOptionName || previous.orderOptionName || "",
    orderOptionPrice: currentDraft.orderOptionPrice || previous.orderOptionPrice || "",
    addOnChoice: currentDraft.addOnChoice || previous.addOnChoice || "",
    requiresAddOn: currentDraft.requiresAddOn || previous.requiresAddOn || false,
    quantity: currentDraft.quantity || previous.quantity || 1,
    requestedQuantity: currentDraft.requestedQuantity || "",
    unsupportedQuantity: Boolean(currentDraft.unsupportedQuantity),
    unsupportedOrderOption: Boolean(currentDraft.unsupportedOrderOption),
    name: currentDraft.name || previous.name || "",
    phone: currentDraft.phone || inferred.phone || currentChatPhone || previous.phone || "",
    address: currentDraft.address || previous.address || "",
    ...inferred,
  };
  if (merged.unsupportedQuantity || merged.unsupportedOrderOption) {
    merged.orderOptionId = "";
    merged.orderOptionName = "";
    merged.orderOptionPrice = "";
    merged.packageId = "";
    merged.packageName = "";
    merged.packagePrice = "";
    merged.addOnChoice = "";
    merged.requiresAddOn = false;
    merged.quantity = merged.requestedQuantity || 1;
  }
  const option = optionFromDraft(merged, product);
  if (option && !merged.unsupportedQuantity && !merged.unsupportedOrderOption) {
    merged.packageId = option.legacyPackage ? legacyPackageId(option) : "";
    merged.packageName = option.legacyPackage ? option.name : "";
    merged.packagePrice = option.legacyPackage ? option.price : "";
    merged.orderOptionId = option.id || "";
    merged.orderOptionName = option.name || "";
    merged.orderOptionPrice = option.price || "";
    merged.requiresAddOn = Boolean(option.requiresAddOn);
    merged.quantity = Number(option.total_units || option.quantity || merged.quantity || 1) || 1;
    if (!merged.addOnChoice) merged.addOnChoice = extractAddOnChoice(text, option);
  }
  const optionComplete = Boolean(merged.orderOptionId || merged.packageId) && (!merged.requiresAddOn || Boolean(merged.addOnChoice));
  merged.hasAnyDetails = Boolean(
    merged.orderOptionId ||
      merged.packageId ||
      merged.addOnChoice ||
      merged.name ||
      merged.phone ||
      merged.address ||
      merged.unsupportedQuantity ||
      merged.unsupportedOrderOption ||
      currentDraft.hasAnyDetails
  );
  merged.hasNewDetails = Boolean(currentDraft.hasAnyDetails || hasLabelledField || hasInferredDetail);
  merged.isComplete = Boolean(optionComplete && merged.name && merged.phone && merged.address && Number(merged.quantity) > 0);
  return merged;
}

function inferSingleMissingField(field, text, previousDraft, product) {
  const value = String(text || "").trim();
  if (!value) return {};
  if (!isLikelyOrderDetailAnswer(value)) return {};
  if (field === "phone") return /\d{5,}/.test(value.replace(/\s+/g, "")) ? { phone: value } : {};
  if (field === "name") return /\d{5,}/.test(value) ? {} : { name: value };
  if (field === "address") return { address: value };
  if (field === "orderOption") {
    const option = extractOrderOptionChoice(value, product);
    return option ? orderDraftFromOption(option) : {};
  }
  if (field === "addOnChoice") {
    const option = optionFromDraft(previousDraft, product);
    const addOnChoice = extractAddOnChoice(value, option);
    return addOnChoice ? { addOnChoice } : {};
  }
  return {};
}

function isLikelyOrderDetailAnswer(value) {
  const text = String(value || "").trim();
  if (!text || /[?？]$/.test(text)) return false;
  if (/^(ada|berapa|can|boleh|do|does|is|are|kenapa|apa|macam mana|how|why|what)\b/i.test(text)) return false;
  return true;
}

function pendingOrderPatch(productId, existingPendingOrder, orderDraft) {
  return {
    productId,
    startedAt: existingPendingOrder?.startedAt || new Date().toISOString(),
    draft: storedOrderDraft(orderDraft),
  };
}

function storedOrderDraft(orderDraft) {
  return {
    packageId: orderDraft.packageId || "",
    packageName: orderDraft.packageName || "",
    packagePrice: orderDraft.packagePrice || "",
    orderOptionId: orderDraft.orderOptionId || "",
    orderOptionName: orderDraft.orderOptionName || "",
    orderOptionPrice: orderDraft.orderOptionPrice || "",
    addOnChoice: orderDraft.addOnChoice || "",
    requiresAddOn: Boolean(orderDraft.requiresAddOn),
    quantity: Number(orderDraft.quantity || 1) || 1,
    requestedQuantity: orderDraft.requestedQuantity || "",
    unsupportedQuantity: Boolean(orderDraft.unsupportedQuantity),
    unsupportedOrderOption: Boolean(orderDraft.unsupportedOrderOption),
    name: orderDraft.name || "",
    phone: orderDraft.phone || "",
    address: orderDraft.address || "",
  };
}

function salesReplyAfterReplyAction(salesReply = {}) {
  const action = String(salesReply.after_reply || salesReply.afterReply || SALES_AFTER_REPLY_WAIT).trim().toUpperCase();
  return action === SALES_AFTER_REPLY_CLOSE ? SALES_AFTER_REPLY_CLOSE : SALES_AFTER_REPLY_WAIT;
}

function salesConversationClosedPatch(customer = {}, close = false) {
  if (close) {
    return {
      salesConversationClosed: true,
      salesStatus: "sales_closed",
      conversationState: "sales_closed",
      followupBlocked: true,
      followupBlockedReason: "sales_conversation_closed",
    };
  }
  const patch = { salesConversationClosed: false };
  if (normalizeStateValue(customer.salesStatus) === "sales_closed") patch.salesStatus = "engaged";
  if (normalizeStateValue(customer.conversationState) === "sales_closed") patch.conversationState = "";
  if (normalizeStateValue(customer.followupBlockedReason) === "sales_conversation_closed") {
    patch.followupBlocked = false;
    patch.followupBlockedReason = "";
  }
  return patch;
}

function normalizeStoredOrderDraft(draft = {}) {
  const normalized = storedOrderDraft(draft);
  normalized.hasAnyDetails = Boolean(
    normalized.packageId ||
      normalized.orderOptionId ||
      normalized.addOnChoice ||
      normalized.unsupportedQuantity ||
      normalized.unsupportedOrderOption ||
      normalized.name ||
      normalized.phone ||
      normalized.address
  );
  normalized.isComplete = false;
  return normalized;
}

function orderDraftFromOption(option) {
  return {
    packageId: option.legacyPackage ? legacyPackageId(option) : "",
    packageName: option.legacyPackage ? option.name : "",
    packagePrice: option.legacyPackage ? option.price : "",
    orderOptionId: option.id || "",
    orderOptionName: option.name || "",
    orderOptionPrice: option.price || "",
    requiresAddOn: Boolean(option.requiresAddOn),
    quantity: Number(option.total_units || option.quantity || 1) || 1,
  };
}

function missingOrderFields(product, orderDraft) {
  const missing = [];
  const hasOption = Boolean(orderDraft.orderOptionId || orderDraft.packageId);
  if (!orderDraft.name) missing.push("name");
  if (!orderDraft.address) missing.push("address");
  if (!orderDraft.phone) missing.push("phone");
  if (!hasOption && orderOptionsForProduct(product).length) missing.push("orderOption");
  if (hasOption && orderDraft.requiresAddOn && !orderDraft.addOnChoice) missing.push("addOnChoice");
  return missing;
}

function optionFromDraft(orderDraft, product) {
  const options = orderOptionsForProduct(product);
  return options.find((option) =>
    (orderDraft.orderOptionId && option.id === orderDraft.orderOptionId) ||
    (orderDraft.orderOptionName && normalizeReplyText(option.name) === normalizeReplyText(orderDraft.orderOptionName)) ||
    (orderDraft.packageId && legacyPackageId(option) === orderDraft.packageId)
  ) || null;
}

function hasOrderFormFields(orderDraft) {
  return Boolean(orderDraft.name || orderDraft.phone || orderDraft.address);
}

function isClearOrderOptionReply(text, orderDraft, product) {
  const option = optionFromDraft(orderDraft, product);
  if (!option) return false;
  const raw = String(text || "").trim();
  if (!raw || /[?ï¼Ÿ]$/.test(raw)) return false;
  if (/\b(harga|price|berapa|how\s*much|caj|charge|delivery|deliver|hantar|sampai|stock|available)\b/i.test(raw)) {
    return false;
  }
  const normalized = normalizeReplyText(raw);
  if (!normalized || normalized.split(/\s+/).length > 5) return false;
  const name = normalizeReplyText(option.name);
  const id = normalizeReplyText(option.id);
  const spacedId = normalizeReplyText(String(option.id || "").replace(/[-_]+/g, " "));
  const legacyId = normalizeReplyText(legacyPackageId(option));
  const shortPackage = name.match(/^package\s+([a-z0-9]+)$/i)?.[1] || "";
  const aliases = (option.aliases || []).map((alias) => normalizeReplyText(alias));
  const terms = [name, id, spacedId, legacyId, shortPackage, ...aliases].filter(Boolean);
  return terms.includes(normalized);
}

function shouldAnswerBeforePendingOrder(customer, text, currentDraft, orderDraft, product, routeClassification = null) {
  if (!customer?.pendingOrder) return false;
  const classifiedQuestionRoute = routeClassification && routeClassification.confidence !== "low" &&
    ["general_faq", "product_question", "sales_reply", "order_status", "complaint", "human_request", "unknown"].includes(routeClassification.messageType);
  const clearOrderDetails = Boolean(
    currentDraft?.isComplete ||
      hasOrderFormFields(currentDraft) ||
      (!classifiedQuestionRoute && (currentDraft?.orderOptionId || currentDraft?.orderOptionName)) ||
      currentDraft?.addOnChoice ||
      currentDraft?.unsupportedOrderOption ||
      (currentDraft?.unsupportedQuantity && !classifiedQuestionRoute)
  );
  if (clearOrderDetails || (orderDraft?.hasNewDetails && !classifiedQuestionRoute)) return false;
  if (refersToPreviousOrderDetails(text)) return false;
  if (requestsCurrentChatPhone(text)) return false;
  if (isClearOrderOptionReply(text, orderDraft, product)) return false;
  if (routeIndicatesPurchaseIntent(routeClassification)) return false;
  if (hasSalesObjectionLanguage(text)) return true;
  if (classifiedQuestionRoute) return true;
  return isQuestionLike(normalizeReplyText(text)) || isGeneralBusinessQuestion(text) || isProductSpecificQuestion(text);
}

function refersToPreviousOrderDetails(text) {
  const normalized = normalizeReplyText(text);
  if (!normalized) return false;
  const mentionsPrevious = /\b(atas|above|tadi|before|previous|earlier)\b/i.test(normalized);
  const mentionsDetails = /\b(detail|details|maklumat|info|alamat|address|nama|name|phone|nombor|number)\b/i.test(normalized);
  const saysAlreadySent = /\b(sudah|sdh|dah|dh|already)\b/i.test(normalized) &&
    /\b(send|sent|hantar|antar|bagi|share|beri|kasih|kasi)\b/i.test(normalized);
  const asksAdminToFill = /\b(kamu|kmu|kita|admin|team)\b/i.test(normalized) &&
    /\b(isi|fill|masuk(?:kan)?|input)\b/i.test(normalized);
  return Boolean((mentionsPrevious && (mentionsDetails || saysAlreadySent || asksAdminToFill)) || (asksAdminToFill && saysAlreadySent));
}

function shouldHandleOrderDraft(customer, text, orderDraft, product, ragAnswer, routeClassification = null) {
  const hasPurchaseIntent = routeIndicatesPurchaseIntent(routeClassification);
  if (!customer?.pendingOrder && customerHasSubmittedOrder(customer)) return false;
  if (hasSalesObjectionLanguage(text)) return false;
  if (customer?.pendingOrder) {
    return Boolean(
      orderDraft.unsupportedQuantity ||
        orderDraft.unsupportedOrderOption ||
        orderDraft.isComplete ||
        orderDraft.hasNewDetails ||
        requestsCurrentChatPhone(text) ||
        isOrderStartIntent(text) ||
        hasPurchaseIntent
    );
  }
  if (customer?.awaitingPackageBInterest && isClearOrderOptionReply(text, orderDraft, product)) return true;
  if (
    (orderDraft.unsupportedQuantity || orderDraft.unsupportedOrderOption) &&
    (customer?.awaitingPackageBInterest || isQuantityPurchaseRequest(text) || isOrderStartIntent(text) || hasPurchaseIntent)
  ) {
    return true;
  }
  if (isOrderStartIntent(text) || hasPurchaseIntent) return true;
  if (orderDraft.isComplete) return hasStrongOrderEvidence(text, orderDraft, product);
  if (orderDraft.hasNewDetails || hasOrderFormFields(orderDraft)) return hasStrongOrderEvidence(text, orderDraft, product);
  return false;
}

function customerHasSubmittedOrder(customer = {}) {
  return Boolean(
    customer.status === "order_submitted" ||
      customer.followupBlockedReason === "order_submitted" ||
      (Array.isArray(customer.orderIds) && customer.orderIds.length > 0)
  );
}

export function conversationActiveState(customer = {}) {
  if (!customer || typeof customer !== "object") return "";
  const status = normalizeStateValue(customer.status);
  const salesStatus = normalizeStateValue(customer.salesStatus);
  const conversationState = normalizeStateValue(customer.conversationState);
  const guardrail = normalizeStateValue(customer.guardrailStatus || customer.guardrail);
  const handoffStatus = normalizeStateValue(customer.handoffStatus);
  const handoffReason = normalizeStateValue(customer.handoffReason);
  const followupBlockedReason = normalizeStateValue(customer.followupBlockedReason);
  const lastSalesReplyIntent = normalizeStateValue(customer.lastSalesReplyIntent);

  if (customer.optedOut || status === "opted_out" || followupBlockedReason === "opted_out") return "optedOut";
  if (
    customer.humanRequired ||
    handoffStatus === "human_required" ||
    status === "human_required" ||
    guardrail.includes("human") ||
    Boolean(handoffReason)
  ) {
    return "handoff";
  }
  if (customerHasSubmittedOrder(customer)) return "submittedOrder";
  if (status === "done" || followupBlockedReason === "done" || customer.done) return "done";
  if (customer.pendingOrder) return "pendingOrder";
  if (customer.awaitingPackageBInterest || conversationState === "awaiting_package_interest") return "awaitingPackageInterest";
  if (
    status === "another_date_purchase" ||
    salesStatus === "another_date_purchase" ||
    conversationState === "another_date_purchase" ||
    followupBlockedReason === "another_date_purchase" ||
    lastSalesReplyIntent === "another_date_purchase"
  ) {
    return "anotherDatePurchase";
  }
  if (
    customer.salesConversationClosed ||
    salesStatus === "sales_closed" ||
    conversationState === "sales_closed" ||
    followupBlockedReason === "sales_conversation_closed"
  ) {
    return "salesClosed";
  }
  return "";
}

function normalizeStateValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function requestsCurrentChatPhone(text) {
  const normalized = normalizeReplyText(text);
  if (!normalized) return false;
  return (
    /\b(no|nombor|nomor|number|phone|hp|whatsapp|wasap|ws)\b.*\b(ani|ini|this|same|msg|message|chat|pakai|guna|gunakan|use)\b/i.test(normalized) ||
    /\b(ani|ini|this|same|msg|message|chat|pakai|guna|gunakan|use)\b.*\b(no|nombor|nomor|number|phone|hp|whatsapp|wasap|ws)\b/i.test(normalized)
  );
}

function inferPhoneFromCurrentChatRequest(text, customerId) {
  if (!requestsCurrentChatPhone(text)) return "";
  return phoneFromCustomerId(customerId);
}

function phoneFromCustomerId(customerId) {
  const value = String(customerId || "").trim();
  if (!value || /@lid\b/i.test(value)) return "";
  const left = value.split("@")[0] || "";
  const digits = left.replace(/\D/g, "");
  return digits.length >= 7 ? digits : "";
}

function routeIndicatesPurchaseIntent(routeClassification) {
  return Boolean(
    routeClassification &&
      routeClassification.confidence !== "low" &&
      routeClassification.messageType === "purchase_intent"
  );
}

function hasSalesObjectionLanguage(text) {
  const normalized = normalizeReplyText(text);
  if (!normalized) return false;
  return /\b(mahal|expensive|too much|harga tinggi|over budget|overbudget|tak mampu|tidak mampu|cannot afford|cant afford|can't afford)\b/i.test(normalized) ||
    /\b(not interested|no interest|nda minat|inda minat|tak minat|tidak minat|next time|lain kali|nevermind|never mind|nanti saja|nanti sja|maybe next time)\b/i.test(normalized) ||
    (/\b(payday|gaji|salary|budget|bajet|duit|money)\b/i.test(normalized) &&
      /\b(tunggu|nanti|belum|after|lapas|lepas|baru|cukup|later)\b/i.test(normalized)) ||
    /\b(fikir|pikir|think|thinking|consider|tanya dulu|ask first|confirm dulu|check dulu|liat dulu|lihat dulu|nanti dulu|tunggu dulu)\b/i.test(normalized);
}

function hasStrongOrderEvidence(text, draft = {}, product = null) {
  const body = String(text || "").trim();
  if (!body) return false;
  const normalized = body.toLowerCase();
  if (/\b(full\s*name|nama|name|full\s*address|alamat|address|phone\s*number|phone|contact|nombor|number|order\s*option|pilihan|package|pakej|paket|pkg)\s*[:：]/i.test(body)) {
    return true;
  }
  const phoneMatches = body.match(/\+?\d[\d\s-]{5,}\d/g) || [];
  const hasLikelyPhone = phoneMatches.some((value) => value.replace(/\D/g, "").length >= 7);
  const hasAddressCue = /\b(spg|simpang|jalan|jln|kg|kampung|rumah|house|no\.?|unit|block|blok|lot|mukim|bandar|kb|tutong|temburong|brunei|muara|mentiri|mumong)\b/i.test(body);
  const hasClearOrderIntent = isOrderStartIntent(body) || /\b(confirm|lock|proceed|book|booking)\b/i.test(body);
  const hasExplicitOption =
    Boolean(draft.orderOptionId || draft.orderOptionChoice || draft.addOnChoice || draft.packageId || optionFromDraft(draft, product)) &&
    /\b(package|pakej|paket|pkg|option|pilihan|order|ambil|mau|mahu|nak|beli|buy)\b/i.test(normalized);
  if (hasLikelyPhone && (hasAddressCue || hasClearOrderIntent || hasExplicitOption)) return true;
  if (hasAddressCue && hasClearOrderIntent) return true;
  if (hasExplicitOption && hasClearOrderIntent) return true;
  return false;
}

function isOrderStartIntent(text) {
  const normalized = normalizeReplyText(text);
  if (!normalized) return false;
  if (/\b(harga|price|berapa|how\s*much|caj|charge|delivery|deliver|hantar|sampai|location|alamat|area|stock|instock|in\s*stock)\b/i.test(normalized)) {
    return false;
  }
  return (
    /\b(sya|saya|aku|ku|i|me|kami|kita)\s*(mau|mahu|nak|kan|want|wanna)\s*(order|beli|ambil|buy)\b/i.test(normalized) ||
    /\b(mau|mahu|nak|kan|want|wanna)\s*(order|beli|ambil|buy)\b/i.test(normalized) ||
    /\b(order|beli|ambil|buy)\s*(satu|1|one|dua|2|package|pakej|pkg|combo|unit|set)\b/i.test(normalized) ||
    isQuantityPurchaseRequest(normalized) ||
    /^(order|beli|ambil|buy|checkout|proceed|jadi ambil|confirm order)$/i.test(normalized)
  );
}

function isQuantityPurchaseRequest(text) {
  const normalized = normalizeReplyText(text);
  if (!normalized) return false;
  if (!extractRequestedUnitQuantity(normalized)) return false;
  return /\b(order|beli|ambil|buy|mau|mahu|nak|want|wanna|cuba|mencuba|try)\b/i.test(normalized);
}

function orderOptionsForProduct(product) {
  const explicit = Array.isArray(product?.order_options) ? product.order_options : [];
  if (explicit.length) {
    const packageIds = new Set((product?.packages || []).map((item) => String(item.id || "").toLowerCase()));
    return explicit
      .map((item) => normalizeOrderOption(item, packageIds.has(String(item.id || "").toLowerCase())))
      .filter((item) => item.name);
  }
  return (product?.packages || []).map((item) => normalizeOrderOption(item, true)).filter((item) => item.name);
}

function normalizeOrderOption(item, legacyPackage) {
  const addOns = (item.add_ons || item.addOns || item.addon_choices || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const name = String(item.name || item.label || item.id || "").trim();
  return {
    id: String(item.id || item.name || "").trim(),
    name,
    price: String(item.price || "").trim(),
    quantity: Number(item.quantity || item.total_units || 1) || 1,
    total_units: Number(item.total_units || item.quantity || 1) || 1,
    aliases: Array.isArray(item.aliases) ? item.aliases : [],
    addOns,
    requiresAddOn: Boolean(item.requires_add_on || item.requiresAddOn || addOns.length),
    legacyPackage: Boolean(legacyPackage || /^package\s+[a-z0-9]+$/i.test(name)),
  };
}

function extractRequestedUnitQuantity(text) {
  const normalized = normalizeReplyText(text);
  if (!normalized) return 0;
  const numberMatch =
    normalized.match(/\b(\d{1,2})\s*(?:pcs|pc|unit|units|set)\b/i) ||
    normalized.match(/\b(?:pcs|pc|unit|units|set)\s*(\d{1,2})\b/i);
  if (numberMatch) return Number(numberMatch[1]) || 0;
  const wordToNumber = new Map([
    ["satu", 1],
    ["one", 1],
    ["dua", 2],
    ["two", 2],
    ["tiga", 3],
    ["three", 3],
    ["empat", 4],
    ["four", 4],
    ["lima", 5],
    ["five", 5],
    ["enam", 6],
    ["six", 6],
    ["tujuh", 7],
    ["seven", 7],
    ["lapan", 8],
    ["eight", 8],
    ["sembilan", 9],
    ["nine", 9],
    ["sepuluh", 10],
    ["ten", 10],
  ]);
  const wordMatch =
    normalized.match(/\b(satu|one|dua|two|tiga|three|empat|four|lima|five|enam|six|tujuh|seven|lapan|eight|sembilan|nine|sepuluh|ten)\s*(?:pcs|pc|unit|units|set)\b/i) ||
    normalized.match(/\b(?:pcs|pc|unit|units|set)\s*(satu|one|dua|two|tiga|three|empat|four|lima|five|enam|six|tujuh|seven|lapan|eight|sembilan|nine|sepuluh|ten)\b/i);
  return wordMatch ? wordToNumber.get(wordMatch[1].toLowerCase()) || 0 : 0;
}

function findOrderOptionByQuantity(product, quantity) {
  const requested = Number(quantity);
  if (!requested) return null;
  return orderOptionsForProduct(product).find((option) => {
    const optionQuantity = Number(option.total_units || option.quantity || 0);
    if (optionQuantity === requested) return true;
    const aliases = [option.name, option.id, ...(option.aliases || [])].map((value) => normalizeReplyText(value));
    return aliases.some((alias) => new RegExp(`\\b${requested}\\s*(?:pcs|pc|unit|units|set)\\b`, "i").test(alias));
  }) || null;
}

function extractOrderOptionChoice(text, product) {
  const normalized = text.toLowerCase();
  const normalizedReply = normalizeReplyText(text);
  const labelledOption = fieldValue(text, ["order package", "package", "pakej", "paket", "pkg", "order option", "option", "pilihan"]);
  return orderOptionsForProduct(product).find((item) => {
    const id = String(item.id || "").toLowerCase();
    const name = String(item.name || "").toLowerCase();
    const shortPackage = name.match(/^package\s+([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "";
    const aliases = [name, id, shortPackage, ...(item.aliases || []).map((alias) => String(alias || "").toLowerCase())].filter(Boolean);
    const optionTokens = [id, shortPackage].filter(Boolean);
    const optionPattern = optionTokens.length
      ? new RegExp(`\\b(package|pakej|paket|pkg|option|opsyen|pilihan|order option)\\s*[:\\uFF1A-]?\\s*(?:${optionTokens.map(escapeRegExp).join("|")})\\b`, "i")
      : null;
    return (
      (labelledOption && aliases.some((alias) => normalizeReplyText(labelledOption) === normalizeReplyText(alias))) ||
      (optionPattern && optionPattern.test(text)) ||
      normalized.includes(`order package ${id}`) ||
      normalized.includes(`package ${id}`) ||
      normalized.includes(`pakej ${id}`) ||
      normalized.includes(`paket ${id}`) ||
      normalized.includes(`pkg ${id}`) ||
      normalized.includes(`order option ${id}`) ||
      normalized === id ||
      (shortPackage && normalizedReply === shortPackage) ||
      aliases.some((alias) => alias && alias.length > 1 && normalized.includes(alias))
    );
  });
}

function extractFreeFormOrderDetails(text) {
  const lines = normalizeOrderFormText(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return {};

  const phoneLineIndex = lines.findIndex((line) => extractPhoneNumber(line));
  const phone = phoneLineIndex >= 0 ? extractPhoneNumber(lines[phoneLineIndex]) : "";
  const addressLineIndex = lines.findIndex((line, index) => index !== phoneLineIndex && isLikelyAddressLine(line));
  const nameLineIndex = lines.findIndex((line, index) =>
    index !== phoneLineIndex &&
    index !== addressLineIndex &&
    isLikelyNameLine(line)
  );

  const addressLines = lines.filter((line, index) =>
    index !== phoneLineIndex &&
    index !== nameLineIndex &&
    (index === addressLineIndex || isLikelyAddressLine(line))
  );

  const parsed = {
    name: nameLineIndex >= 0 ? lines[nameLineIndex] : "",
    phone,
    address: addressLines.join(" ").trim(),
  };

  if (lines.length === 1 || (!parsed.name && !parsed.address && lines.some((line) => isLikelyAddressLine(line)))) {
    const mixed = parseMixedLineOrderDetails(lines.join(" "));
    return { ...mixed, phone: parsed.phone || mixed.phone };
  }

  return parsed;
}

function parseMixedLineOrderDetails(line) {
  const original = String(line || "").trim();
  if (!original) return {};
  if (isQuestionLike(normalizeReplyText(original))) return {};
  const phoneMatch = findPhoneMatch(original);
  const phone = phoneMatch?.phone || "";
  const withoutPhone = phoneMatch
    ? `${original.slice(0, phoneMatch.index)} ${original.slice(phoneMatch.index + phoneMatch.raw.length)}`
    : original;
  const cleaned = withoutPhone.replace(/\s+/g, " ").trim();
  const addressMatch = cleaned.match(/\b(no\.?|simpang|spg|jalan|jln|kg|kampong|kampung|stkrj|rumah|house|unit|block|blk|lot|mumong|kiulap|tutong|kb|kuala\s*belait|temburong|brunei|bandar|seria|jerudong|rimba|lambak|berakas|mengkubau|mulaut|sengkurong|lumut|liang)\b/i);
  if (!addressMatch) {
    return { phone };
  }
  const matchedAddressCue = String(addressMatch[1] || "").toLowerCase();
  const hasStrongAddressCue = /\b(no\.?|simpang|spg|jalan|jln|kg|kampong|kampung|stkrj|rumah|house|block|blk|lot|mumong|kiulap|tutong|kb|kuala\s*belait|temburong|brunei|bandar|seria|jerudong|rimba|lambak|berakas|mengkubau|mulaut|sengkurong|lumut|liang)\b/i.test(cleaned);
  if (matchedAddressCue === "unit" && extractRequestedUnitQuantity(original) && !hasStrongAddressCue) {
    return { phone };
  }

  const beforeAddress = cleaned.slice(0, addressMatch.index).replace(/[,\s]+$/g, "").trim();
  let address = cleaned.slice(addressMatch.index).replace(/^[,\s]+/g, "").trim();
  let name = isLikelyNameLine(beforeAddress) ? beforeAddress : "";
  if (!name) {
    const trailingName = address.match(/\s+([a-z][a-z .'-]{1,40})$/i)?.[1]?.trim() || "";
    if (trailingName && isLikelyNameLine(trailingName)) {
      name = trailingName;
      address = address.slice(0, address.length - trailingName.length).trim();
    }
  }

  return {
    name,
    phone,
    address,
  };
}

function extractPhoneNumber(line) {
  return findPhoneMatch(line)?.phone || "";
}

function findPhoneMatch(line) {
  const text = String(line || "");
  const candidates = [];
  const patterns = [
    /\+?673[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g,
    /\b\d{3,4}[\s-]\d{3,4}\b/g,
    /\b\d{7,8}\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[0];
      const digits = raw.replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 11) continue;
      candidates.push({ raw, phone: raw.replace(/\s+/g, " ").trim(), index: match.index || 0, digits });
    }
  }
  return candidates[0] || null;
}

function isLikelyPhoneLine(line) {
  const text = String(line || "").trim();
  if (!text || isLikelyAddressLine(text)) return false;
  const digits = text.replace(/\D/g, "");
  return /^\+?\d[\d\s-]{5,14}$/.test(text) && digits.length >= 7 && digits.length <= 11;
}

function isLikelyNameLine(line) {
  const text = String(line || "").trim();
  if (!text || extractPhoneNumber(text) || isLikelyAddressLine(text)) return false;
  if (/^(package|pakej|paket|pkg|option|opsyen|pilihan)\b/i.test(text)) return false;
  if (/[?]/.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 5 && /^[a-z .'-]+$/i.test(text);
}

function isLikelyAddressLine(line) {
  const text = String(line || "").trim();
  if (!text) return false;
  const hasAddressKeyword = /\b(no\.?|simpang|spg|jalan|jln|kg|kampong|kampung|stkrj|rumah|house|unit|block|blk|lot|mumong|kiulap|tutong|kb|kuala\s*belait|temburong|brunei|bandar|seria|jerudong|rimba|lambak|berakas|mengkubau|mulaut|sengkurong|lumut|liang)\b/i.test(text);
  if (hasAddressKeyword) return true;
  return false;
}

function legacyPackageId(option) {
  const shortPackage = String(option?.name || "").match(/^package\s+([a-z0-9]+)$/i)?.[1] || "";
  return shortPackage || String(option?.id || "");
}

function extractAddOnChoice(text, option) {
  const field = fieldValue(text, ["add-on choice", "addon choice", "add on choice", "add-on", "addon", "combo option", "combo"]);
  if (!option?.addOns?.length) return field;
  const normalized = text.toLowerCase();
  const matched = option.addOns.find((item) => {
    const addOn = item.toLowerCase();
    if (normalized.includes(addOn)) return true;
    const terms = addOn.split(/[^a-z0-9]+/).filter((term) => term.length > 2 && !["unit", "pcs"].includes(term));
    if (!terms.length) return false;
    const needed = Math.min(2, terms.length);
    return terms.filter((term) => normalized.includes(term)).length >= needed;
  });
  return matched || field;
}

function fieldValue(text, labels) {
  for (const line of normalizeOrderFormText(text).split(/\r?\n/)) {
    const cleanLine = line.replace(/^[^a-z0-9]+/i, "").trim();
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = cleanLine.match(new RegExp(`^${escaped}\\s*[:\\uFF1A-]\\s*(.*?)\\s*$`, "i"));
      if (match) return match[1].trim();
    }
  }
  return "";
}

function normalizeOrderFormText(value) {
  return String(value || "")
    .replace(/\\r\\n|\\n|\\r/g, "\n")
    .replace(/\u00a0/g, " ");
}

export function formatAdminOrderMessage(product, orderDraft, customerId) {
  const optionLabel = orderDraft.orderOptionName || orderDraft.packageName;
  const optionPrice = orderDraft.orderOptionPrice || orderDraft.packagePrice;
  return [
    "New WhatsApp order to process:",
    `Customer WhatsApp: ${customerId}`,
    `Product: ${product.name}`,
    optionLabel
      ? `Order option: ${optionLabel}${optionPrice ? ` (${optionPrice})` : ""}`
      : "Order option: not specified",
    ...(orderDraft.addOnChoice ? [`Add-on choice: ${orderDraft.addOnChoice}`] : []),
    `Quantity: ${orderDraft.quantity}`,
    `Name: ${orderDraft.name}`,
    `Phone: ${orderDraft.phone || customerId}`,
    `Address: ${orderDraft.address}`,
    ...(product.shopping_link ? [`Shopping link: ${product.shopping_link}`] : []),
  ].join("\n");
}
