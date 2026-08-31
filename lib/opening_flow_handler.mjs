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
  const fuzzy = fuzzyTermConfidence(value, normalizedText);
  if (fuzzy >= 0.78) {
    return candidate(product, Math.min(confidenceForTermKind(term.kind, "word", sourceLabel), fuzzy), fuzzyMatchSource(term.kind, sourceLabel), term.value);
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

function fuzzyMatchSource(kind = "", sourceLabel = "") {
  return sourceLabel === "ad_metadata" ? "ad_metadata_fuzzy" : `fuzzy_${kind || "term"}`;
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
    source.adBody,
    source.adId,
    source.sourceUrl,
    source.referralBody,
    source.referralHeadline,
    source.ctaPayload,
    source.ref,
  ].filter(Boolean).join(" ");
}

function normalizeProductText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fuzzyTermConfidence(term = "", normalizedText = "") {
  const termTokens = significantProductTokens(term);
  const textTokens = significantProductTokens(normalizedText);
  if (termTokens.length < 2 || textTokens.length < 2) return 0;
  let total = 0;
  let matched = 0;
  let missed = 0;
  for (const token of termTokens) {
    const best = textTokens.reduce((score, candidateToken) => Math.max(score, tokenSimilarity(token, candidateToken)), 0);
    if (best < 0.72) {
      missed += 1;
      if (missed > (termTokens.length >= 3 ? 1 : 0)) return 0;
      continue;
    }
    total += best;
    matched += 1;
  }
  if (matched < Math.min(2, termTokens.length)) return 0;
  const average = total / matched;
  return average * (1 - missed * 0.05);
}

function significantProductTokens(value = "") {
  return normalizeProductText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !PRODUCT_STOP_WORDS.has(token));
}

const PRODUCT_STOP_WORDS = new Set([
  "price",
  "harga",
  "harganya",
  "berapa",
  "brapa",
  "brpe",
]);

function tokenSimilarity(left = "", right = "") {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left))) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  const distance = levenshteinDistance(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

function levenshteinDistance(left = "", right = "") {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j += 1) {
      current[j + 1] = Math.min(
        current[j] + 1,
        previous[j + 1] + 1,
        previous[j] + (left[i] === right[j] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

export function applyOpeningFlowDecision(plan, decision, { customer = {}, source = {} } = {}) {
  if (!decision?.shouldSend) return plan;
  const openingMessages = decision.messages || [];
  return {
    ...plan,
    customerPatch: {
      productId: decision.productId,
      source: { ...(customer.source || {}), ...source },
      awaitingPackageBInterest: false,
      ...(plan.customerPatch?.awaitingProductClarification === false ? { awaitingProductClarification: false } : {}),
      ...(plan.customerPatch?.productClarificationReason === "" ? { productClarificationReason: "" } : {}),
      ...openingFlowSentPatch(customer, decision.product),
    },
    order: undefined,
    adminMessage: "",
    messages: openingMessages,
    handoffRequired: false,
    handoffReason: "",
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
