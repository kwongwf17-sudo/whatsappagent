import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAcknowledgementPlan,
  buildPoliteClosePlan,
} from "./closing_handler.mjs";

const product = { id: "soil_booster" };

test("acknowledgement during pending order asks only for missing details", () => {
  const plan = buildAcknowledgementPlan({
    product,
    customer: {
      pendingOrder: { productId: product.id, name: "Ali" },
    },
    text: "ok",
    activeState: "pendingOrder",
    orderDraft: { name: "Ali" },
    helpers: {
      incompleteOrderMessages: () => [{ type: "text", body: "Need phone and address" }],
      isNeutralAcknowledgement: () => true,
      pendingOrderPatch: (_productId, pendingOrder, orderDraft) => ({ ...pendingOrder, ...orderDraft }),
      salesConversationClosedPatch: () => ({ salesClosed: false }),
    },
  });

  assert.deepEqual(plan, {
    customerPatch: {
      salesClosed: false,
      productId: product.id,
      awaitingPackageBInterest: false,
      expectedNextAction: null,
      pendingOrder: { productId: product.id, name: "Ali" },
    },
    messages: [{ type: "text", body: "Need phone and address" }],
    handoffRequired: false,
  });
});

test("polite close handler returns configured close reply", () => {
  const plan = buildPoliteClosePlan({
    product,
    text: "thank you",
    closeReply: "Sama-sama.",
    helpers: {
      isPoliteClose: () => true,
      textMessage: (body) => ({ type: "text", body }),
    },
  });

  assert.deepEqual(plan, {
    customerPatch: { productId: product.id },
    messages: [{ type: "text", body: "Sama-sama." }],
    handoffRequired: false,
  });
});

test("acknowledgement preserves package-interest state", () => {
  const plan = buildAcknowledgementPlan({
    product,
    customer: { awaitingPackageBInterest: true },
    text: "ok tq",
    activeState: "awaitingPackageInterest",
    helpers: {
      isNeutralAcknowledgement: () => true,
    },
  });

  assert.deepEqual(plan, {
    customerPatch: { productId: product.id },
    messages: [],
    handoffRequired: false,
  });
});
