export function resolveProduct({ catalog, text = "", source = {}, fallbackProductId = "", findProductMatch }) {
  const enabledProducts = (catalog.products || []).filter((product) => product.openingFlowEnabled !== false);
  const products = enabledProducts.length ? enabledProducts : (catalog.products || []);
  const bySourceProductId = (catalog.products || []).find((product) => product.id === source.productId);
  if (bySourceProductId) {
    return productResolution(bySourceProductId, true, "source_product_id", 1, [
      candidate(bySourceProductId, 1, "source_product_id", String(source.productId || "")),
    ]);
  }

  const sourceCandidates = rankProductCandidates(products, sourceText(source), "ad_metadata");
  if (sourceCandidates[0]?.confidence >= 0.75 && !hasAmbiguousTopCandidates(sourceCandidates)) {
    return productResolution(sourceCandidates[0].product, true, sourceCandidates[0].matchSource, sourceCandidates[0].confidence, sourceCandidates);
  }

  if (typeof findProductMatch === "function") {
    const bySource = findProductMatch({ products }, "", source);
    if (bySource) return productResolution(bySource, true, "ad_metadata", 0.75, [
      candidate(bySource, 0.75, "ad_metadata", sourceText(source)),
    ]);
  }

  const byFallback = (catalog.products || []).find((product) => product.id === fallbackProductId);
  if (byFallback) {
    return productResolution(byFallback, true, "existing_customer_product", 0.9, [
      candidate(byFallback, 0.9, "existing_customer_product", String(fallbackProductId || "")),
    ]);
  }

  const textCandidates = rankProductCandidates(products, text, "message_text");
  if (hasAmbiguousTopCandidates(textCandidates)) {
    const fallback = (catalog.products || []).find((p) => p.id === catalog.default_product_id) || products[0] || null;
    return productResolution(fallback, false, "ambiguous_product", 0, textCandidates);
  }
  if (textCandidates[0]?.confidence >= 0.75 && !hasAmbiguousTopCandidates(textCandidates)) {
    return productResolution(textCandidates[0].product, true, textCandidates[0].matchSource, textCandidates[0].confidence, textCandidates);
  }

  if (typeof findProductMatch === "function") {
    const byText = findProductMatch({ products }, text, {});
    if (byText) return productResolution(byText, true, "message_text", 0.5, [
      candidate(byText, 0.5, "message_text", String(text || "")),
    ]);
  }

  const fallback = (catalog.products || []).find((p) => p.id === catalog.default_product_id) || products[0] || null;
  return productResolution(fallback, false, textCandidates.length ? "ambiguous_product" : "default_fallback", 0, textCandidates);
}

export function getOpeningFlowDecision({
  customer = {},
  productResolution = null,
  customerMessage = "",
  source = {},
  isFirstEligibleInbound = false,
  helpers = {},
}) {
  const product = productResolution?.product || null;
  const text = String(customerMessage || "").trim();
  if (!product?.id || !text) return noOpeningFlowDecision(product, "missing_product_or_message");
  if (helpers.conversationActiveState(customer)) return noOpeningFlowDecision(product, "active_state");
  if (hasOpeningFlowAlreadySent(customer, product)) return noOpeningFlowDecision(product, "already_sent");
  if (!productResolution?.matched || productResolution.matchSource === "default_fallback") {
    return noOpeningFlowDecision(product, "no_confident_product_context");
  }
  if (productResolution.matchSource === "ambiguous_product" || Number(productResolution.confidence || 0) < 0.75) {
    return noOpeningFlowDecision(product, "no_confident_product_context");
  }

  const productMentioned =
    helpers.isProductNameMessage(product, text) ||
    helpers.isProductMentionedInText(product, text);
  const sourceContext =
    ["source_product_id", "ad_metadata"].includes(productResolution.matchSource) ||
    String(productResolution.matchSource || "").startsWith("ad_metadata");
  if (!isFirstEligibleInbound && !productMentioned && !sourceContext && !source.productNameMatch) {
    return noOpeningFlowDecision(product, "not_first_or_explicit_context");
  }

  return {
    shouldSend: true,
    productId: product.id,
    reason: isFirstEligibleInbound ? "first_inbound_with_product_context" : productResolution.matchSource,
    product,
    messages: product.opening_flow || [helpers.textMessage(helpers.productIntro(product))],
  };
}

export function rankProductCandidates(products = [], text = "", sourceLabel = "message_text") {
  const normalizedText = normalizeProductText(text);
  if (!normalizedText) return [];
  return products
    .map((product) => bestProductCandidate(product, normalizedText, sourceLabel))
    .filter(Boolean)
    .sort((left, right) => right.confidence - left.confidence || left.product.id.localeCompare(right.product.id));
}

function bestProductCandidate(product = {}, normalizedText = "", sourceLabel = "message_text") {
  const terms = productDetectionTerms(product);
  const scored = terms
    .map((term) => scoreTermMatch(product, term, normalizedText, sourceLabel))
    .filter(Boolean)
    .sort((left, right) => right.confidence - left.confidence);
  return scored[0] || null;
}

function scoreTermMatch(product = {}, term = {}, normalizedText = "", sourceLabel = "message_text") {
  const value = normalizeProductText(term.value);
  if (!value || value.length < 2) return null;
  if (normalizedText === value) {
    return candidate(product, confidenceForTermKind(term.kind, "exact", sourceLabel), exactMatchSource(term.kind, sourceLabel), term.value);
  }
  if (new RegExp(`(^|\\b)${escapeRegExp(value)}(\\b|$)`, "i").test(normalizedText)) {
    return candidate(product, confidenceForTermKind(term.kind, "word", sourceLabel), wordMatchSource(term.kind, sourceLabel), term.value);
  }
  if (value.length >= 4 && normalizedText.includes(value)) {
    return candidate(product, confidenceForTermKind(term.kind, "substring", sourceLabel), substringMatchSource(term.kind, sourceLabel), term.value);
  }
  return null;
}

function confidenceForTermKind(kind = "", matchType = "", sourceLabel = "") {
  if (sourceLabel === "ad_metadata") {
    if (matchType === "exact") return 0.88;
    if (matchType === "word") return 0.82;
    return 0.5;
  }
  if (kind === "sku" && matchType === "exact") return 0.99;
  if (kind === "name" && matchType === "exact") return 0.97;
  if (kind === "alias" && matchType === "exact") return 0.94;
  if (matchType === "word") return 0.75;
  return 0.5;
}

function exactMatchSource(kind = "", sourceLabel = "") {
  if (sourceLabel === "ad_metadata") return "ad_metadata_phrase";
  if (kind === "sku") return "exact_sku";
  if (kind === "name") return "exact_product_name";
  if (kind === "alias") return "exact_alias";
  return "exact_product_term";
}

function wordMatchSource(kind = "", sourceLabel = "") {
  return sourceLabel === "ad_metadata" ? "ad_metadata_phrase" : `word_boundary_${kind || "term"}`;
}

function substringMatchSource(kind = "", sourceLabel = "") {
  return sourceLabel === "ad_metadata" ? "ad_metadata_substring" : `substring_${kind || "term"}`;
}

function hasAmbiguousTopCandidates(candidates = []) {
  if (candidates.length < 2) return false;
  return Math.abs(Number(candidates[0].confidence || 0) - Number(candidates[1].confidence || 0)) < 0.08;
}

function productResolution(product, matched, matchSource, confidence, candidates = []) {
  return {
    product,
    matched,
    confidence,
    matchSource,
    candidates: candidates.map((item) => ({
      productId: item.product?.id || "",
      productName: item.product?.name || "",
      confidence: item.confidence,
      matchSource: item.matchSource,
      matchedTerm: item.matchedTerm,
    })),
  };
}

function candidate(product, confidence, matchSource, matchedTerm = "") {
  return { product, confidence, matchSource, matchedTerm };
}

function productDetectionTerms(product = {}) {
  return [
    { kind: "name", value: product.name },
    { kind: "sku", value: product.id },
    { kind: "sku", value: product.sku_code },
    { kind: "sku", value: product.skuCode },
    ...(product.aliases || []).map((value) => ({ kind: "alias", value })),
    ...(product.ad_keywords || []).map((value) => ({ kind: "ad_keyword", value })),
  ]
    .filter((item) => item.value)
    .flatMap((item) => productDetectionTermVariants(item.value).map((value) => ({ ...item, value })));
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
  return [...new Set(variants.filter(Boolean))];
}

function sourceText(source = {}) {
  return [
    source.adTitle,
    source.adId,
    source.sourceUrl,
    source.referralBody,
    source.referralHeadline,
  ].filter(Boolean).join(" ");
}

function normalizeProductText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyOpeningFlowDecision(plan, decision, { customer = {}, source = {} } = {}) {
  if (!decision?.shouldSend) return plan;
  const openingMessages = decision.messages || [];
  const isFallbackHandoff =
    plan.handoffRequired &&
    !plan.adminMessage &&
    !(plan.messages || []).length &&
    plan.handoffReason === "No matching sales response, FAQ, or RAG answer.";
  return {
    ...plan,
    customerPatch: {
      ...(plan.customerPatch || {}),
      productId: decision.productId,
      source: { ...(customer.source || {}), ...source },
      awaitingPackageBInterest: plan.customerPatch?.awaitingPackageBInterest ?? false,
      ...(isFallbackHandoff ? { handoffStatus: "", handoffReason: "" } : {}),
      ...openingFlowSentPatch(customer, decision.product),
    },
    messages: [...openingMessages, ...(plan.messages || [])],
    handoffRequired: isFallbackHandoff ? false : plan.handoffRequired,
    handoffReason: isFallbackHandoff ? "" : plan.handoffReason,
  };
}

function noOpeningFlowDecision(product = null, reason = "") {
  return {
    shouldSend: false,
    productId: product?.id || "",
    reason,
    product,
    messages: [],
  };
}

export function hasOpeningFlowAlreadySent(customer = {}, product = null) {
  if (!customer || !product?.id) return false;
  const productId = String(product.id);
  const sentMap = customer.openingFlowsSent && typeof customer.openingFlowsSent === "object"
    ? customer.openingFlowsSent
    : {};
  if (sentMap[productId]?.sentAt || sentMap[productId] === true) return true;
  if (String(customer.openingFlowProductId || "") === productId && customer.openingFlowSentAt) return true;
  return (
    customer.conversationState === "opening_flow_sent" &&
    String(customer.openingFlowProductId || customer.productId || "") === productId
  );
}

function openingFlowSentPatch(customer = {}, product = null, sentAt = new Date().toISOString()) {
  if (!product?.id) return {};
  return {
    openingFlowsSent: {
      ...(customer.openingFlowsSent && typeof customer.openingFlowsSent === "object" ? customer.openingFlowsSent : {}),
      [product.id]: { sentAt },
    },
    openingFlowSentAt: sentAt,
    openingFlowProductId: product.id,
  };
}
