import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildConversationPlan } from "./conversation.mjs";

const catalog = JSON.parse(
  await readFile(new URL("../data/product_catalog.json", import.meta.url), "utf8")
);
const faqLibrary = JSON.parse(
  await readFile(new URL("../data/general_faqs.json", import.meta.url), "utf8")
);
const storedOrders = JSON.parse(
  await readFile(new URL("../data/order_parser_regression_cases.json", import.meta.url), "utf8")
).orders;

const product = catalog.products.find((item) => item.id === "blackhead-remover");
const ilsoProduct = catalog.products.find((item) => item.id === "p08-ilso-super-melting-sebum-softener");

const salesReplyLibrary = {
  sales_replies: [
    {
      id: "sales_too_expensive",
      sales_intent: "too_expensive",
      scope: "business",
      example_messages: ["mahal", "tak mampu", "nda mampu"],
      approved_reply: "Faham kita. Harga ani memang ikut promo/package yang ada sekarang ya.",
      active: true,
    },
  ],
};

function bodies(plan) {
  return (plan.messages || []).filter((message) => message.type === "text").map((message) => message.body);
}

function assertGoodCustomerReply(plan, label) {
  assert.equal(plan.messages.some((message) => message.type === "text" && String(message.body || "").trim()), true, label);
  assert.doesNotMatch(bodies(plan).join("\n"), /\bundefined\b|\bnull\b|\[object Object\]/i, label);
}

test("quality: new ad customer gets opening flow before any normal answer", async () => {
  const plan = await buildConversationPlan({
    catalog,
    faqLibrary,
    customer: { id: "quality_new_ad", productId: "" },
    customerMessage: "Harga berapa?",
    source: {
      productId: product.id,
      productNameMatch: true,
      adContextProductMatch: true,
    },
    routeClassification: {
      messageType: "general_faq",
      primaryIntent: "price",
      confidence: "high",
    },
    ragAnswer: {
      reply: "Package A: B$39.",
      replyType: "faq",
      handoffRequired: false,
      allowProductSpecific: true,
    },
  });

  assert.equal(plan.handoffRequired, false);
  assert.equal(plan.customerPatch.productId, product.id);
  assert.deepEqual(plan.messages.slice(0, product.opening_flow.length), product.opening_flow);
  assert.match(bodies(plan).join("\n"), /Package A: B\$39/);
  assertGoodCustomerReply(plan, "new ad opening");
});

test("quality: new product-name customer gets correct product opening flow", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "quality_new_product_name", productId: "" },
    customerMessage: `${ilsoProduct.name} macam mana pakai?`,
    ragAnswer: {
      reply: "Pakai atas kawasan berminyak, tunggu sekejap, kemudian lap bersih.",
      replyType: "faq",
      handoffRequired: false,
      handoffReason: "",
      allowProductSpecific: true,
    },
    routeClassification: {
      messageType: "product_question",
      confidence: "high",
    },
  });

  assert.equal(plan.handoffRequired, false);
  assert.equal(plan.customerPatch.productId, ilsoProduct.id);
  assert.deepEqual(plan.messages.slice(0, ilsoProduct.opening_flow.length), ilsoProduct.opening_flow);
  assert.match(bodies(plan).at(-1), /Pakai atas kawasan berminyak/);
});

test("quality: active customer receives FAQ answer without repeated opening flow", async () => {
  const plan = await buildConversationPlan({
    catalog,
    faqLibrary,
    customer: {
      id: "quality_active_faq",
      productId: product.id,
      openingFlowHistory: { [product.id]: "2026-07-23T10:00:00.000Z" },
    },
    customerMessage: "Package B berapa?",
    routeClassification: {
      messageType: "general_faq",
      primaryIntent: "price",
      confidence: "high",
    },
    ragAnswer: {
      reply: "Package B: B$70.",
      replyType: "faq",
      handoffRequired: false,
      allowProductSpecific: true,
    },
  });

  assert.equal(plan.handoffRequired, false);
  assert.notDeepEqual(plan.messages.slice(0, product.opening_flow.length), product.opening_flow);
  assert.match(bodies(plan)[0], /Package B: B\$70/);
  assertGoodCustomerReply(plan, "active FAQ");
});

test("quality: sales objection uses approved reply and does not open order", async () => {
  const plan = await buildConversationPlan({
    catalog,
    salesReplyLibrary,
    customer: {
      id: "quality_sales_objection",
      productId: product.id,
      awaitingPackageBInterest: true,
    },
    customerMessage: "Mahal, nda mampu dulu",
  });

  assert.equal(plan.handoffRequired, false);
  assert.equal(plan.order, undefined);
  assert.equal(plan.customerPatch.pendingOrder, undefined);
  assert.equal(bodies(plan)[0], "Faham kita. Harga ani memang ikut promo/package yang ada sekarang ya.");
});

test("quality: buying intent starts order collection from sales state", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: {
      id: "quality_buying_intent",
      productId: product.id,
      awaitingPackageBInterest: true,
    },
    customerMessage: "ada, mau ambil package B",
  });

  assert.equal(plan.handoffRequired, false);
  assert.equal(plan.order, undefined);
  assert.equal(plan.customerPatch.pendingOrder.productId, product.id);
  assert.match(bodies(plan)[0], /Full name|nama penuh/i);
  assert.match(bodies(plan)[0], /Phone number/i);
});

test("quality: partial free-form order asks only for missing order option", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "quality_partial_order", productId: product.id },
    customerMessage: "Ali\nKg Ayer\n6731234567",
  });

  assert.equal(plan.handoffRequired, false);
  assert.equal(plan.order, undefined);
  assert.equal(plan.customerPatch.pendingOrder.draft.name, "Ali");
  assert.equal(plan.customerPatch.pendingOrder.draft.phone, "6731234567");
  assert.match(bodies(plan)[0], /tinggal pilih order option/i);
  assert.doesNotMatch(bodies(plan)[0], /Full name|Phone number/i);
});

test("quality: complete order details create order handoff", async () => {
  const order = storedOrders[0];
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "quality_complete_order", productId: order.productId },
    customerMessage: order.rawMessage,
  });

  assert.equal(plan.handoffRequired, true);
  assert.equal(plan.handoffReason, "Customer submitted complete order details.");
  assert.equal(plan.order.name, order.name);
  assert.equal(plan.order.phone, order.phone);
  assert.match(plan.adminMessage, /New WhatsApp order to process/i);
});

test("quality: pending order can answer FAQ then continue missing-detail reminder", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: {
      id: "quality_pending_order_faq",
      productId: product.id,
      pendingOrder: {
        productId: product.id,
        draft: {
          orderOptionId: "package-a",
          orderOptionName: "Package A",
          quantity: 1,
        },
      },
    },
    customerMessage: "Yg promosi bli satu dpt 1 kh ni",
    ragAnswer: {
      reply: "Awu kita, promo ani buy 1 free 1 masih ikut package yang kita pilih.",
      replyType: "faq",
      handoffRequired: false,
      handoffReason: "",
    },
    routeClassification: {
      messageType: "general_faq",
      confidence: "high",
    },
  });

  assert.equal(plan.handoffRequired, false);
  assert.equal(bodies(plan)[0], "Awu kita, promo ani buy 1 free 1 masih ikut package yang kita pilih.");
  assert.match(bodies(plan)[1], /Untuk order kita tadi/);
  assert.match(bodies(plan)[1], /nama penuh/i);
  assert.doesNotMatch(bodies(plan)[1], /Order option/i);
});

test("quality: complaint or handoff state blocks automated sales reply", async () => {
  for (const customer of [
    { id: "quality_open_complaint", productId: product.id, complaintStatus: "open" },
    { id: "quality_handoff_required", productId: product.id, handoffStatus: "human_required" },
  ]) {
    const plan = await buildConversationPlan({
      catalog,
      salesReplyLibrary,
      customer,
      customerMessage: "Mahal, nda mampu",
      routeClassification: {
        messageType: "sales_reply",
        confidence: "high",
      },
    });

    assert.equal(plan.handoffRequired, true, customer.id);
    assert.equal(plan.messages.length, 0, customer.id);
    assert.notEqual(plan.customerPatch.lastSalesReplyId, "sales_too_expensive", customer.id);
  }
});

test("quality: RAG fallback can answer product-specific question", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "quality_rag_answer", productId: ilsoProduct.id },
    customerMessage: "Sensitive skin boleh pakai?",
    ragAnswer: {
      reply: "Boleh kita, formula gentle dan sesuai untuk sensitive skin.",
      replyType: "faq",
      handoffRequired: false,
      handoffReason: "",
      allowProductSpecific: true,
    },
    routeClassification: {
      messageType: "product_question",
      confidence: "high",
    },
  });

  assert.equal(plan.handoffRequired, false);
  assert.equal(bodies(plan)[0], "Boleh kita, formula gentle dan sesuai untuk sensitive skin.");
});

test("quality: uncertain RAG reply escalates instead of pretending certainty", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "quality_rag_handoff", productId: product.id },
    customerMessage: "Lps terima blh kh",
    ragAnswer: {
      reply: "Boleh kita clarify sikit, saya check-kan dulu dengan team kami ya.",
      replyType: "other",
      handoffRequired: false,
      handoffReason: "",
      allowProductSpecific: true,
    },
  });

  assert.equal(plan.handoffRequired, true);
  assert.equal(plan.customerPatch.handoffStatus, "human_required");
  assert.equal(plan.customerPatch.handoffReason, "AI reply requires team follow-up.");
});

test("quality: submitted-order customer is not asked to fill order form again", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: {
      id: "quality_submitted_order",
      productId: product.id,
      status: "order_submitted",
      followupBlockedReason: "order_submitted",
      orderIds: ["order_123"],
      pendingOrder: {
        productId: product.id,
        draft: {
          orderOptionName: "Package B",
        },
      },
      awaitingPackageBInterest: true,
    },
    customerMessage: "Package A",
    routeClassification: {
      messageType: "purchase_intent",
      confidence: "high",
    },
  });

  assert.equal(plan.order, undefined);
  assert.equal(plan.customerPatch.pendingOrder, undefined);
  assert.doesNotMatch(bodies(plan).join("\n"), /Full name|Phone number|Full address/i);
});
