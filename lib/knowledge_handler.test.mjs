import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFallbackKnowledgePlan,
  buildPrimaryKnowledgePlan,
} from "./knowledge_handler.mjs";

const product = { id: "soil", name: "Soil Activator" };
const customer = { id: "6731234567", productId: product.id };
const helpers = {
  findApprovedFaqLocalMatch: () => ({
    id: "soil_price",
    approved_reply: "Package A: B$49",
  }),
  productPriceFaq: () => null,
  normalizeReplyText: (value) => String(value || "").toLowerCase(),
  routeAllowsStandardReply: () => false,
  findStandardReply: () => null,
  findFaqAnswer: () => "",
  knowledgeAnswerPatch: (item) => ({ productId: item.id, awaitingPackageBInterest: true }),
  knowledgeAnswerMessages: (reply) => [{ type: "text", body: reply }],
  ragAnswerConversationPlan: (ragAnswer) => ({
    customerPatch: { productId: product.id },
    messages: [{ type: "text", body: ragAnswer.reply }],
    handoffRequired: Boolean(ragAnswer.handoffRequired),
    handoffReason: ragAnswer.handoffReason || "",
  }),
  textMessage: (body) => ({ type: "text", body }),
};

test("primary knowledge handler returns approved FAQ plan", () => {
  const plan = buildPrimaryKnowledgePlan({
    catalog: { products: [product] },
    product,
    text: "harga?",
    customer,
    allowLocalKnowledge: true,
    pendingOrderAnswerInterrupt: false,
    orderDraft: {},
    helpers,
  });

  assert.equal(plan.handoffRequired, false);
  assert.equal(plan.customerPatch.lastApprovedFaqId, "soil_price");
  assert.equal(plan.messages[0].body, "Package A: B$49");
});

test("fallback knowledge handler returns RAG plan after local FAQ misses", () => {
  const plan = buildFallbackKnowledgePlan({
    product,
    text: "boleh guna untuk akar?",
    customer,
    allowLocalKnowledge: true,
    pendingOrderAnswerInterrupt: false,
    productSpecificQuestion: true,
    orderDraft: {},
    ragAnswer: {
      reply: "Boleh, sesuai untuk akar.",
      allowProductSpecific: true,
      handoffRequired: false,
    },
    helpers: {
      ...helpers,
      findFaqAnswer: () => "",
    },
  });

  assert.equal(plan.handoffRequired, false);
  assert.equal(plan.messages[0].body, "Boleh, sesuai untuk akar.");
});
