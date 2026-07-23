import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOpeningFlowDecision,
  getOpeningFlowDecision,
  rankProductCandidates,
  resolveProduct,
} from "./opening_flow_handler.mjs";
import {
  conversationActiveState,
  findProductMatch,
  isProductNameMessage,
  productIntro,
  textMessage,
} from "./conversation.mjs";

const product = {
  id: "soil-activator",
  name: "Soil Activator",
  aliases: ["soil activator"],
  opening_flow: [textMessage("Opening flow")],
};
const fallbackProduct = {
  id: "root-booster",
  name: "Root Booster",
  aliases: ["root booster"],
  opening_flow: [textMessage("Root opening")],
};
const catalog = {
  default_product_id: fallbackProduct.id,
  products: [product, fallbackProduct],
};
const helpers = {
  conversationActiveState,
  isProductNameMessage,
  isProductMentionedInText: (item, text) =>
    [item.name, ...(item.aliases || [])].some((term) => String(text).toLowerCase().includes(String(term).toLowerCase())),
  productIntro,
  textMessage,
};

test("opening flow handler rejects default fallback as product context", () => {
  const productResolution = resolveProduct({
    catalog,
    text: "hello",
    source: {},
    fallbackProductId: "",
    findProductMatch,
  });
  const decision = getOpeningFlowDecision({
    customer: { id: "customer_1" },
    productResolution,
    customerMessage: "hello",
    isFirstEligibleInbound: true,
    helpers,
  });

  assert.equal(productResolution.matchSource, "default_fallback");
  assert.equal(decision.shouldSend, false);
  assert.equal(decision.reason, "no_confident_product_context");
});

test("opening flow handler prepends messages and records per-product history", () => {
  const productResolution = resolveProduct({
    catalog,
    text: "soil activator price?",
    source: {},
    fallbackProductId: "",
    findProductMatch,
  });
  const decision = getOpeningFlowDecision({
    customer: { id: "customer_2" },
    productResolution,
    customerMessage: "soil activator price?",
    isFirstEligibleInbound: true,
    helpers,
  });
  const plan = applyOpeningFlowDecision(
    {
      customerPatch: { productId: product.id },
      messages: [textMessage("Price answer")],
      handoffRequired: false,
    },
    decision,
    { customer: {}, source: {} }
  );

  assert.equal(decision.shouldSend, true);
  assert.deepEqual(plan.messages.map((message) => message.body), ["Opening flow", "Price answer"]);
  assert.ok(plan.customerPatch.openingFlowsSent[product.id].sentAt);
});

test("product resolution returns ranked confidence candidates", () => {
  const resolution = resolveProduct({
    catalog,
    text: "soil activator",
    source: {},
    fallbackProductId: "",
    findProductMatch,
  });

  assert.equal(resolution.product.id, product.id);
  assert.equal(resolution.matched, true);
  assert.equal(resolution.matchSource, "exact_sku");
  assert.equal(resolution.confidence, 0.99);
  assert.equal(resolution.candidates[0].productId, product.id);
});

test("product resolution refuses ambiguous close candidates", () => {
  const ambiguousCatalog = {
    products: [
      { id: "soil-activator", name: "Soil Activator", aliases: ["soil"] },
      { id: "soil-booster", name: "Soil Booster", aliases: ["soil"] },
    ],
  };
  const resolution = resolveProduct({
    catalog: ambiguousCatalog,
    text: "soil",
    source: {},
    fallbackProductId: "",
    findProductMatch,
  });

  assert.equal(resolution.matched, false);
  assert.equal(resolution.matchSource, "ambiguous_product");
  assert.equal(resolution.confidence, 0);
  assert.equal(resolution.candidates.length, 2);
});

test("opening flow refuses low-confidence substring product resolution", () => {
  const candidates = rankProductCandidates([product], "soil activatorx");
  assert.equal(candidates[0].confidence, 0.5);

  const decision = getOpeningFlowDecision({
    customer: { id: "customer_low_confidence_product" },
    productResolution: {
      product,
      matched: true,
      confidence: 0.5,
      matchSource: "substring_name",
      candidates,
    },
    customerMessage: "soil activatorx",
    isFirstEligibleInbound: true,
    helpers,
  });

  assert.equal(decision.shouldSend, false);
  assert.equal(decision.reason, "no_confident_product_context");
});
