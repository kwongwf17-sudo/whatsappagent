import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEarlySalesPlan,
  buildMatchedSalesPlan,
} from "./sales_handler.mjs";

const product = { id: "soil_booster", name: "Soil Booster" };

const helpers = {
  findSalesReplyExactMatch: () => null,
  hasSalesObjectionLanguage: () => false,
  orderFormMessages: () => [{ type: "text", body: "order form" }],
  salesConversationClosedPatch: () => ({ salesClosed: false }),
  salesReplyFromMatch: (match) => ({ id: match.salesReplyId, approved_reply: match.approvedReply }),
  salesReplyPlan: (_customer, planProduct, reply) => ({
    customerPatch: { productId: planProduct.id, lastSalesReplyId: reply.id },
    messages: [{ type: "text", body: reply.approved_reply }],
    handoffRequired: false,
  }),
  textMessage: (body) => ({ type: "text", body }),
};

test("early sales handler starts order when FAQ sales prompt gets interest", () => {
  const plan = buildEarlySalesPlan({
    product,
    customer: { awaitingPackageBInterest: true },
    faqSalesResponse: "interested",
    helpers,
  });

  assert.equal(plan.customerPatch.productId, product.id);
  assert.equal(plan.customerPatch.awaitingPackageBInterest, false);
  assert.equal(plan.customerPatch.pendingOrder.productId, product.id);
  assert.deepEqual(plan.messages, [{ type: "text", body: "order form" }]);
});

test("matched sales handler returns approved sales reply plan", () => {
  const plan = buildMatchedSalesPlan({
    product,
    salesReplyMatch: { salesReplyId: "too_expensive", approvedReply: "Promo price masih available ya." },
    helpers,
  });

  assert.deepEqual(plan, {
    customerPatch: { productId: product.id, lastSalesReplyId: "too_expensive" },
    messages: [{ type: "text", body: "Promo price masih available ya." }],
    handoffRequired: false,
  });
});
