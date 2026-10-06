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

test("opening flow handler sends only opening messages and records per-product history", () => {
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
  assert.deepEqual(plan.messages.map((message) => message.body), ["Opening flow"]);
  assert.ok(plan.customerPatch.openingFlowsSent[product.id].sentAt);
});

test("opening flow handler allows same-product ad re-entry even when opening flow was already sent", () => {
  const productResolution = resolveProduct({
    catalog,
    text: "Price?",
    source: {
      adBody: "Limited promo for Soil Activator",
      sourceUrl: "https://fb.me/soil",
    },
    fallbackProductId: "",
    findProductMatch,
  });
  const decision = getOpeningFlowDecision({
    customer: {
      id: "customer_same_product_reentry",
      productId: product.id,
      awaitingPackageBInterest: true,
      openingFlowsSent: {
        [product.id]: { sentAt: "2026-10-01T00:00:00.000Z" },
      },
    },
    productResolution,
    customerMessage: "Price?",
    isFirstEligibleInbound: false,
    helpers,
  });

  assert.equal(productResolution.product.id, product.id);
  assert.equal(productResolution.matchSource.startsWith("ad_metadata"), true);
  assert.equal(decision.shouldSend, true);
  assert.equal(decision.productId, product.id);
});

test("opening flow handler still blocks same-product ad re-entry during pending order", () => {
  const productResolution = resolveProduct({
    catalog,
    text: "Price?",
    source: {
      adBody: "Limited promo for Soil Activator",
      sourceUrl: "https://fb.me/soil",
    },
    fallbackProductId: "",
    findProductMatch,
  });
  const decision = getOpeningFlowDecision({
    customer: {
      id: "customer_same_product_pending_order",
      productId: product.id,
      pendingOrder: { productId: product.id },
    },
    productResolution,
    customerMessage: "Price?",
    isFirstEligibleInbound: false,
    helpers,
  });

  assert.equal(decision.shouldSend, false);
  assert.equal(decision.reason, "active_state");
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

test("product resolution uses Baileys ad body and CTA source clues", () => {
  const resolution = resolveProduct({
    catalog,
    text: "Price?",
    source: {
      adBody: "Limited promo for Soil Activator",
      ctaPayload: "soil activator campaign",
      ref: "soil-activator",
    },
    fallbackProductId: "",
    findProductMatch,
  });

  assert.equal(resolution.product.id, product.id);
  assert.equal(resolution.matched, true);
  assert.match(resolution.matchSource, /^ad_metadata/);
  assert.equal(resolution.confidence >= 0.75, true);
});

test("product resolution prioritizes exact SKU code over noisy ad words", () => {
  const resolution = resolveProduct({
    catalog: {
      products: [
        {
          id: "ss86-surah-yasin",
          name: "SS86 SURAH YASIN",
          opening_flow: [textMessage("SS86 opening")],
        },
        {
          id: "ss87-spearker-quran",
          name: "SS87 SPEARKER QURAN",
          opening_flow: [textMessage("SS87 opening")],
        },
      ],
    },
    text: "Hello! Can I get more info on SS87(A) 22/9 ?",
    source: {
      skuPrefix: "SS",
      productId: "ss86-surah-yasin",
      adBody: "Cuba SS87 - SPEAKER QURAN 30 JUZ MUROTTAL. Ada surah yasin dan ayat Quran.",
    },
    fallbackProductId: "",
    findProductMatch,
  });

  assert.equal(resolution.product.id, "ss87-spearker-quran");
  assert.equal(resolution.matched, true);
  assert.equal(resolution.matchSource, "exact_source_sku");
  assert.equal(resolution.confidence, 0.998);
});

test("product resolution prioritizes exact product SKU from ad source without account prefix", () => {
  const resolution = resolveProduct({
    catalog: {
      products: [
        {
          id: "surah-yasin",
          name: "SURAH YASIN",
          sku_code: "SS86",
          opening_flow: [textMessage("SS86 opening")],
        },
        {
          id: "speaker-quran",
          name: "SPEAKER QURAN",
          sku_code: "SS87",
          opening_flow: [textMessage("SS87 opening")],
        },
      ],
    },
    text: "Hello! Can I get more info?",
    source: {
      productId: "surah-yasin",
      adBody: "SS87(A) 22/9 speaker quran promo. Ada surah yasin dan ayat Quran.",
    },
    fallbackProductId: "",
    findProductMatch,
  });

  assert.equal(resolution.product.id, "speaker-quran");
  assert.equal(resolution.matched, true);
  assert.equal(resolution.matchSource, "exact_source_sku");
  assert.equal(resolution.confidence, 0.998);
});

test("product resolution detects exact product SKU with letter suffix from ad source", () => {
  const resolution = resolveProduct({
    catalog: {
      products: [
        {
          id: "py1-pussy",
          name: "PY1 PUSSY",
          sku_code: "PY1",
          opening_flow: [textMessage("PY1 opening")],
        },
        {
          id: "py1s-pussy",
          name: "PY1S PUSSY",
          sku_code: "PY1S",
          opening_flow: [textMessage("PY1S opening")],
        },
      ],
    },
    text: "Hello! Can I get more info on PY1S 22/9?",
    source: {},
    fallbackProductId: "",
    findProductMatch,
  });

  assert.equal(resolution.product.id, "py1s-pussy");
  assert.equal(resolution.matched, true);
  assert.equal(resolution.matchSource, "exact_source_sku");
});

test("product resolution refuses fuzzy lock when configured SKU prefix has no product match", () => {
  const resolution = resolveProduct({
    catalog: {
      products: [
        { id: "ss86-surah-yasin", name: "SS86 SURAH YASIN" },
        { id: "ss87-spearker-quran", name: "SS87 SPEARKER QURAN" },
      ],
    },
    text: "Hello! Can I get more info on SS99(A) 22/9 ?",
    source: {
      skuPrefix: "SS",
      adBody: "SS99 Quran speaker promo with surah yasin wording",
    },
    fallbackProductId: "",
    findProductMatch,
  });

  assert.equal(resolution.matched, false);
  assert.equal(resolution.matchSource, "unmatched_sku_prefix");
});

test("product resolution handles common typed product-name typos conservatively", () => {
  const typoProduct = {
    id: "peel-off-brow-gel",
    name: "PEEL-OFF BROW GEL",
    aliases: ["peel-off brow gel"],
  };
  const resolution = resolveProduct({
    catalog: { products: [typoProduct] },
    text: "PEEL BROWN GELL",
    source: {},
    fallbackProductId: "",
    findProductMatch,
  });
  const vague = resolveProduct({
    catalog: { products: [typoProduct] },
    text: "gel",
    source: {},
    fallbackProductId: "",
    findProductMatch,
  });

  assert.equal(resolution.product.id, typoProduct.id);
  assert.equal(resolution.matched, true);
  assert.equal(resolution.matchSource, "fuzzy_name");
  assert.equal(vague.matched, false);
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
