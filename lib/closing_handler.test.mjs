import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAcknowledgementPlan,
  buildPoliteClosePlan,
  buildClarificationPlan,
  personalizeClarificationPlan,
} from "./closing_handler.mjs";

const product = { id: "soil_booster" };

function clarificationPlan(customer = {}) {
  const plan = buildClarificationPlan({
    product, customer, text: "Can we change it to next Friday?",
    routeClassification: { clarificationRequired: true },
    helpers: {
      ambiguousQuestionClarification: () => "",
      textMessage: (body) => ({ type: "text", body }),
      buildUnhandledHandoffPlan: () => ({ messages: [], handoffRequired: true }),
    },
  });
  return { ...plan, routingDecision: { rule: "clarification" } };
}

test("personalized clarification changes wording while preserving routing and clarification state", async () => {
  const original = clarificationPlan();
  const result = await personalizeClarificationPlan(original, {
    generateReply: async () => "What would you like to move to next Friday?",
  });
  assert.equal(result.messages[0].body, "What would you like to move to next Friday?");
  assert.equal(result.customerPatch, original.customerPatch);
  assert.equal(result.routingDecision, original.routingDecision);
  assert.equal(original.messages[0].body, "Boleh clarify sikit maksud kita?");
});

test("generation failure and unusable output keep the safe fallback", async () => {
  const original = clarificationPlan();
  let recorded = false;
  assert.equal(await personalizeClarificationPlan(original, {
    generateReply: async () => { throw new Error("timeout"); },
    onError: async () => { recorded = true; },
  }), original);
  assert.equal(recorded, true);
  for (const reply of ["", null, {}, "a".repeat(401)]) {
    assert.equal(await personalizeClarificationPlan(original, { generateReply: async () => reply }), original);
  }
});

test("ordinary routes and repeated clarification handoffs never call the generator", async () => {
  const generateReply = async () => { assert.fail("Generator must not run"); };
  for (const rule of ["fallback_knowledge", "approved_faq", "opening_flow", "delivery_fallback"]) {
    const plan = { ...clarificationPlan(), routingDecision: { rule } };
    assert.equal(await personalizeClarificationPlan(plan, { generateReply }), plan);
  }
  const repeated = clarificationPlan({ lastClarificationAt: new Date().toISOString(), unclearClarificationCount: 1 });
  assert.equal(repeated.handoffRequired, true);
  assert.equal(await personalizeClarificationPlan(repeated, { generateReply }), repeated);
});

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
