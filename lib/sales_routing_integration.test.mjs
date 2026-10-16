import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { buildConversationPlan, findSalesReplyExactMatch } from "./conversation.mjs";

const catalog = JSON.parse(await readFile(new URL("../data/product_catalog.json", import.meta.url), "utf8"));
const product = catalog.products[0];
const library = { sales_replies: [
  { id: "price", sales_intent: "too_expensive", approved_reply: "Price concern", active: true, scope: "business" },
  { id: "payday", sales_intent: "payday_only_pay", approved_reply: "Payday arrangement", active: true, scope: "business" },
  { id: "date", sales_intent: "another_date_purchase", approved_reply: "Future date arrangement", active: true, scope: "business" },
] };
const base = { catalog, salesReplyLibrary: library, customer: { productId: product.id },
  productResolution: { product, matched: true, confidence: 1, matchSource: "existing_customer_product" },
  openingFlowDecision: { shouldSend: false } };

test("salary obstacle uses payday while explicit future purchase dates retain date matching", () => {
  for (const text of ["Awu, tunggu gaji", "Budget belum cukup", "Tunggu payday"]) {
    assert.equal(findSalesReplyExactMatch(catalog, product, text, { salesReplyLibrary: library }).id, "payday");
  }
  for (const text of ["25/7 baru beli", "Next month saya order", "Tunggu gaji 25/7"]) {
    assert.equal(findSalesReplyExactMatch(catalog, product, text, { salesReplyLibrary: library }).id, "date");
  }
});

test("early sales preserves the prepared reply and existing expected-action state contract", async () => {
  const plan = await buildConversationPlan({ ...base, customerMessage: "Mahal",
    salesReplyMatch: { salesReplyId: "price", salesIntent: "too_expensive", approvedReply: "Prepared alternate. Proceed?", expectsPackageInterest: true },
    routeClassification: { messageType: "sales_reply", confidence: "high" },
  });
  assert.equal(plan.messages[0].body, "Prepared alternate. Proceed?");
  assert.equal(plan.customerPatch.expectedNextAction.type, "package_interest_confirmation");
  assert.equal(plan.customerPatch.awaitingPackageBInterest, true);
});

test("a factual question alongside an objection reaches its approved answer", async () => {
  const plan = await buildConversationPlan({ ...base, customerMessage: "Mahal, berapa lama jaminan?",
    routeClassification: { messageType: "product_question", confidence: "high" },
    ragAnswer: { reply: "The approved guarantee is 30 days.", replyType: "faq", allowProductSpecific: true, handoffRequired: false },
  });
  assert.match(plan.messages[0].body, /30 days/);
  assert.notEqual(plan.routingDecision.rule, "early_sales");
});

test("all configured repeat actions and instructions survive the prepared-sales path", async () => {
  for (const action of ["openai_acknowledge", "handoff", "opt_out"]) {
    const plan = await buildConversationPlan({ ...base,
      customer: { productId: product.id, lastSalesReplyId: "price", lastSalesReplyIntent: "too_expensive" },
      customerMessage: "Masih mahal", routeClassification: { messageType: "sales_reply", confidence: "high" },
      salesReplyMatch: { salesReplyId: "price", salesIntent: "too_expensive", approvedReply: "Prepared",
        repeatAction: action, sameIntentAgainInstruction: "Ask which concern remains." },
    });
    assert.equal(plan.repeatedSalesReply.action, action);
    assert.equal(plan.repeatedSalesReply.instruction, "Ask which concern remains.");
  }
});
