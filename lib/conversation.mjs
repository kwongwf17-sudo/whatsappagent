import { readFile } from "node:fs/promises";
import { sanitizeImageKnowledgeChunk } from "./knowledge_sanitizer.mjs";

const DELIVERY_KEYWORDS = /\b(delivery|deliver|address|send)\b/i;
const DEFAULT_SALES_PROMPT = "Ada minat nak beli Package B?";
const DEFAULT_ORDER_CLOSING_MESSAGES = [
  "Sorry Dear our stock just finish , I will take order again, will take around 15-18 days for arrived brunei new stock 🥰 But i will try my best to get it quick for you ya.",
  "REMINDER ✨: \n-Order after 1 hour cannot be canceled. \n-Brg Sampai baru byr runner",
  "Terima kasih❤️",
];

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
  conversationContext = [],
}) {
  const product = findProduct(catalog, customerMessage, source, customer.productId);
  const text = customerMessage.trim();
  const productNameOpening = isProductNameMessage(product, text);
  const productSpecificQuestion = isProductSpecificQuestion(text);
  const faqSalesResponse = classifyFaqSalesPromptResponse(customer, text);

  if (faqSalesResponse === "interested") {
    return {
      customerPatch: {
        productId: product.id,
        awaitingPackageBInterest: false,
        pendingOrder: { productId: product.id, startedAt: new Date().toISOString() },
      },
      messages: orderFormMessages(product),
      handoffRequired: false,
    };
  }

  if (faqSalesResponse === "not_interested") {
    return {
      customerPatch: { productId: product.id, awaitingPackageBInterest: false },
      messages: [textMessage("bah, terima kasih.")],
      handoffRequired: false,
    };
  }

  if (isLikelyAdOpening(source, text) || source.productNameMatch || productNameOpening) {
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

  const earlyOrderDraft = mergePendingOrderDraft(customer, extractOrderDetails(text, product), text, product);
  if (earlyOrderDraft.isComplete || hasOrderFormFields(earlyOrderDraft) || isOrderStartIntent(text) || ragAnswer?.buyingIntent === "buying") {
    if (earlyOrderDraft.isComplete) {
      return {
        customerPatch: {
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
        productId: product.id,
        awaitingPackageBInterest: false,
        pendingOrder: pendingOrderPatch(product.id, customer.pendingOrder, earlyOrderDraft),
      },
      messages: incompleteOrderMessages(product, earlyOrderDraft),
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

  const salesReply = findSalesReplyExactMatch(catalog, product, text, { salesReplyLibrary });

  if (salesReply) {
    return {
      customerPatch: {
        productId: product.id,
        awaitingPackageBInterest: Boolean(salesReply.followup_prompt),
        lastSalesReplyId: salesReply.id,
      },
      messages: salesReplyMessages(salesReply),
      handoffRequired: false,
    };
  }

  const approvedFaq = ragAnswer
    ? findApprovedFaqExactMatch(catalog, product, text, { faqLibrary })
    : findApprovedFaqLocalMatch(catalog, product, text, { faqLibrary, customer, conversationContext });

  if (approvedFaq) {
    return {
      customerPatch: {
        productId: product.id,
        ...faqSalesPromptPatch(product, customer),
        lastApprovedFaqId: approvedFaq.id,
      },
      messages: faqReplyMessages(approvedFaq.approved_reply, product, customer),
      handoffRequired: false,
    };
  }

  const productPriceReply = productPriceFaq(product, normalizeReplyText(text));
  if (productPriceReply) {
    return {
      customerPatch: {
        productId: product.id,
        ...faqSalesPromptPatch(product, customer),
        lastApprovedFaqId: productPriceReply.id,
      },
      messages: faqReplyMessages(productPriceReply.approved_reply, product, customer),
      handoffRequired: false,
    };
  }

  const standardReply = findStandardReply(catalog, product, text);

  if (standardReply) {
    return {
      customerPatch: {
        productId: product.id,
        ...(standardReply.type === "faq"
          ? faqSalesPromptPatch(product, customer)
          : { awaitingPackageBInterest: false }),
      },
      messages:
        standardReply.type === "faq"
          ? faqReplyMessages(standardReply.reply, product, customer)
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

  const orderDraft = mergePendingOrderDraft(customer, extractOrderDetails(text, product), text, product);
  if (orderDraft.isComplete || orderDraft.hasNewDetails || hasOrderFormFields(orderDraft) || isOrderStartIntent(text) || ragAnswer?.buyingIntent === "buying") {
    if (orderDraft.isComplete) {
      return {
        customerPatch: {
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
        productId: product.id,
        awaitingPackageBInterest: false,
        pendingOrder: pendingOrderPatch(product.id, customer.pendingOrder, orderDraft),
      },
      messages: incompleteOrderMessages(product, orderDraft),
      handoffRequired: false,
    };

    return {
      customerPatch: {
        productId: product.id,
        awaitingPackageBInterest: false,
        pendingOrder: { productId: product.id, startedAt: new Date().toISOString() },
      },
      messages: [
        textMessage(
          "Noted and thank you."
        ),
        textMessage(
          "Can you help me fill up this details for hold promo? 🥰 \n\n✅ Full name : \n🏠 Full address : \n📱 Phone number : \n\nOrder Package :"
        ),
      ],
      handoffRequired: false,
    };
  }

  if (approvedFaqMatch?.approvedReply) {
    return {
      customerPatch: {
        productId: product.id,
        ...faqSalesPromptPatch(product, customer),
        lastApprovedFaqId: approvedFaqMatch.faqId,
      },
      messages: faqReplyMessages(approvedFaqMatch.approvedReply, product, customer),
      handoffRequired: false,
    };
  }

  if (salesReplyMatch?.approvedReply) {
    return {
      customerPatch: {
        productId: product.id,
        awaitingPackageBInterest: Boolean(salesReplyMatch.followupPrompt),
        lastSalesReplyId: salesReplyMatch.salesReplyId,
      },
      messages: [
        textMessage(salesReplyMatch.approvedReply),
        ...(salesReplyMatch.followupPrompt ? [textMessage(salesReplyMatch.followupPrompt)] : []),
      ],
      handoffRequired: false,
    };
  }

  const faqAnswer = findFaqAnswer(product, text);
  if (faqAnswer) {
    return {
      customerPatch: { productId: product.id, ...faqSalesPromptPatch(product, customer) },
      messages: faqReplyMessages(faqAnswer, product, customer),
      handoffRequired: false,
    };
  }

  if (ragAnswer?.reply && (!productSpecificQuestion || ragAnswer.allowProductSpecific)) {
    const shouldUseFaqPrompt = ragAnswer.replyType === "faq" && !ragAnswer.handoffRequired;
    return {
      customerPatch: {
        productId: product.id,
        ...(shouldUseFaqPrompt ? faqSalesPromptPatch(product, customer) : { awaitingPackageBInterest: false }),
      },
      messages:
        shouldUseFaqPrompt
          ? faqReplyMessages(ragAnswer.reply, product, customer)
          : [textMessage(ragAnswer.reply)],
      handoffRequired: ragAnswer.handoffRequired,
      handoffReason: ragAnswer.handoffReason,
    };
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
    messages: [
      textMessage(
        "Terima kasih kita. Saya akan minta team check dan reply kita sekejap lagi."
      ),
    ],
    handoffRequired: true,
    handoffReason: "No matching sales response, FAQ, or RAG answer.",
  };
}

export function usesFixedOpeningFlow(customer, customerMessage, source = {}) {
  const text = String(customerMessage || "").trim();
  return isLikelyAdOpening(source, text) || Boolean(source.productNameMatch);
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
  return (
    salesReplyRecordsForProduct(catalog, product, options).find((item) =>
      (item.example_messages || []).some((message) => salesReplyExampleMatches(normalizedText, message))
    ) || null
  );
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

function legacyStandardSalesReply(product, item, index) {
  const examples = item.customer_messages || item.triggers || [];
  const label = examples[0] || item.reply || `sales response ${index + 1}`;
  return {
    id: `${product.id}_legacy_sales_${safeIdSegment(label)}_${index + 1}`,
    objection_type: label,
    intent: `Customer gives this sales response or hesitation: ${label}`,
    example_messages: examples,
    approved_reply: item.reply || "",
    followup_prompt: "",
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
  if (shouldSendFaqSalesPrompt(product, customer)) {
    messages.push(textMessage(salesPromptForProduct(product)));
  }
  return messages;
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

function faqSalesPromptPatch(product, customer) {
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

function salesReplyMessages(salesReply) {
  return [
    textMessage(salesReply.approved_reply),
    ...(salesReply.followup_prompt ? [textMessage(salesReply.followup_prompt)] : []),
  ];
}

function orderFormMessages(product) {
  return [
    textMessage("Noted and thank you."),
    textMessage(orderFormText(product)),
  ];
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
  if (!orderDraft.hasAnyDetails) {
    return [
      textMessage("Noted and thank you."),
      textMessage(orderFormText(product)),
    ];
  }
  const missing = missingOrderFields(product, orderDraft);
  if (!missing.length) {
    return [
      textMessage("Noted and thank you."),
      textMessage(orderFormText(product)),
    ];
  }
  return [textMessage(missingOrderReply(product, orderDraft, missing))];
}

function missingOrderReply(product, orderDraft, missing) {
  const first = missing[0];
  if (missing.length === 1) {
    if (first === "name") return "Noted kita, tinggal full name saja lagi 😊\nBoleh share nama penuh kita?";
    if (first === "phone") return "Noted kita, tinggal phone number saja lagi 😊\nBoleh share phone number kita?";
    if (first === "address") return "Noted kita, tinggal full address saja lagi 😊\nBoleh share alamat penuh untuk delivery?";
    if (first === "orderOption") {
      const options = orderOptionsForProduct(product).map((option) => option.name).filter(Boolean).join(" / ");
      return `Noted kita, tinggal pilih order option saja lagi 😊\nKita mau yang mana${options ? `: ${options}` : ""}?`;
    }
    if (first === "addOnChoice") {
      const option = optionFromDraft(orderDraft, product);
      const addOns = option?.addOns?.length ? option.addOns.join(" / ") : "add-on choice";
      return `Noted kita, untuk ${orderDraft.orderOptionName || "combo"} ani tinggal pilih add-on saja lagi 😊\nKita mau ${addOns}?`;
    }
  }

  const labels = missing.map((field) => {
    if (field === "name") return "full name";
    if (field === "phone") return "phone number";
    if (field === "address") return "full address";
    if (field === "orderOption") return "order option";
    if (field === "addOnChoice") return "add-on choice";
    return field;
  });
  return [
    `Noted kita, masih kurang ${labels.join(", ")} saja lagi 😊`,
    "Boleh share detail ani untuk kami hold promo?",
    "",
    ...missingOrderFormLines(product, missing),
  ].join("\n");
}

function missingOrderFormLines(product, missing) {
  const lines = [];
  if (missing.includes("name")) lines.push("✅ Full name :");
  if (missing.includes("address")) lines.push("🏠 Full address :");
  if (missing.includes("phone")) lines.push("📱 Phone number :");
  if (missing.includes("orderOption")) {
    const options = orderOptionsForProduct(product).map((option) => option.name).filter(Boolean).join(" / ");
    lines.push(options ? `Order option : ${options}` : "Order option :");
  }
  if (missing.includes("addOnChoice")) lines.push("Add-on choice :");
  return lines;
}

function salesPromptForProduct(product) {
  const lastText = [...(product?.opening_flow || [])].reverse().find((message) => message?.type === "text")?.body;
  const hasFlexibleOptions = Array.isArray(product?.order_options) && product.order_options.length > 0 && !(product?.packages || []).length;
  return String(product?.sales_prompt || product?.package_question || (hasFlexibleOptions ? lastText : "") || DEFAULT_SALES_PROMPT).trim() || DEFAULT_SALES_PROMPT;
}

function orderFormText(product) {
  const options = orderOptionsForProduct(product);
  const optionNames = options.map((option) => option.name).filter(Boolean).join(" / ");
  const requiresAddOn = options.some((option) => option.requiresAddOn);
  return [
    "Can you help me fill up this details for hold promo? 🥰",
    "",
    "✅ Full name :",
    "🏠 Full address :",
    "📱 Phone number :",
    optionNames ? `Order option : ${optionNames}` : "Order option :",
    ...(requiresAddOn ? ["Add-on choice :"] : []),
  ].join("\n");
}

function normalizeReplyText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[?!.,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractOrderDetails(text, product) {
  const normalizedText = normalizeOrderFormText(text);
  const availableOptions = orderOptionsForProduct(product);
  let orderOptionChoice = extractOrderOptionChoice(normalizedText, product);
  const freeForm = extractFreeFormOrderDetails(normalizedText);
  const name = fieldValue(normalizedText, ["full name", "name", "nama"]) || freeForm.name;
  const phone = fieldValue(normalizedText, ["phone number", "phone", "tel", "mobile", "whatsapp"]) || freeForm.phone;
  const address = fieldValue(normalizedText, ["full address", "delivery address", "address", "alamat"]) || freeForm.address;
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
    name,
    phone,
    address,
    hasAnyDetails: Boolean(
      orderOptionChoice ||
        addOnChoice ||
        name ||
        phone ||
        address ||
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
  const inferred = !hasLabelledField && previousMissing.length === 1
    ? inferSingleMissingField(previousMissing[0], plainText, previous, product)
    : {};
  const hasInferredDetail = Object.keys(inferred).length > 0;
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
    name: currentDraft.name || previous.name || "",
    phone: currentDraft.phone || previous.phone || "",
    address: currentDraft.address || previous.address || "",
    ...inferred,
  };
  const option = optionFromDraft(merged, product);
  if (option) {
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
    name: orderDraft.name || "",
    phone: orderDraft.phone || "",
    address: orderDraft.address || "",
  };
}

function normalizeStoredOrderDraft(draft = {}) {
  const normalized = storedOrderDraft(draft);
  normalized.hasAnyDetails = Boolean(
    normalized.packageId ||
      normalized.orderOptionId ||
      normalized.addOnChoice ||
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
    /^(order|beli|ambil|buy|checkout|proceed|jadi ambil|confirm order)$/i.test(normalized)
  );
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

function extractOrderOptionChoice(text, product) {
  const normalized = text.toLowerCase();
  const normalizedReply = normalizeReplyText(text);
  const labelledOption = fieldValue(text, ["order package", "package", "pakej", "pkg", "order option", "option", "pilihan"]);
  return orderOptionsForProduct(product).find((item) => {
    const id = String(item.id || "").toLowerCase();
    const name = String(item.name || "").toLowerCase();
    const shortPackage = name.match(/^package\s+([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "";
    const aliases = [name, id, shortPackage, ...(item.aliases || []).map((alias) => String(alias || "").toLowerCase())].filter(Boolean);
    const optionPattern = id
      ? new RegExp(`\\b(package|pakej|pkg|option|opsyen|pilihan|order option)\\s*[:\\uFF1A-]?\\s*${escapeRegExp(id)}\\b`, "i")
      : null;
    return (
      (labelledOption && aliases.some((alias) => normalizeReplyText(labelledOption) === normalizeReplyText(alias))) ||
      (optionPattern && optionPattern.test(text)) ||
      normalized.includes(`order package ${id}`) ||
      normalized.includes(`package ${id}`) ||
      normalized.includes(`pakej ${id}`) ||
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
  if (lines.length < 2) return {};

  const phoneLineIndex = lines.findIndex((line) => isLikelyPhoneLine(line));
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

  return {
    name: nameLineIndex >= 0 ? lines[nameLineIndex] : "",
    phone,
    address: addressLines.join(" ").trim(),
  };
}

function extractPhoneNumber(line) {
  const compact = String(line || "").replace(/[^\d+]/g, "");
  const match = compact.match(/(?:\+?673)?\d{7,8}/);
  return match ? match[0] : "";
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
