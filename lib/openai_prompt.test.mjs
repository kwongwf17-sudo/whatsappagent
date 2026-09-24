import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCustomerMessageRoute,
  classifySalesReplyExpectedAction,
  selectKnowledgeSalesFollowup,
  selectSalesReply,
  suggestTemplateImprovement,
} from "./openai.mjs";

function mockOpenAi(outputText, onRequest) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    onRequest?.(url, options);
    return new Response(JSON.stringify({ output_text: outputText }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function inputTextFromRequest(options) {
  const body = JSON.parse(String(options.body || "{}"));
  return body.input
    .flatMap((message) => message.content || [])
    .map((content) => content.text || "")
    .join("\n\n");
}

test("route classifier prompt explicitly uses context for short ambiguous replies", async () => {
  let requestText = "";
  const restore = mockOpenAi(
    JSON.stringify({
      message_type: "sales_reply",
      primary_intent: "thinking_first",
      related_product: "",
      clarification_required: false,
      human_support_required: false,
      confidence: "high",
      reason: "Short reply answers package offer.",
    }),
    (_url, options) => {
      requestText = inputTextFromRequest(options);
    }
  );

  try {
    const route = await classifyCustomerMessageRoute({
      apiKey: "test",
      model: "test-model",
      customerMessage: "belum lagi",
      normalizedCustomerMessage: "belum lagi",
      productName: "BLACK SESAME PUFF",
      conversationContext: [
        { direction: "outbound", body: "Would you be interested in getting PACKAGE B?" },
      ],
      salesIntents: [{ id: "thinking_first", label: "Thinking first" }],
    });

    assert.equal(route.messageType, "sales_reply");
    assert.equal(route.primaryIntent, "thinking_first");
    assert.match(requestText, /Never classify the latest customer message in isolation/i);
    assert.match(requestText, /First infer whether the customer message is standalone/i);
    assert.match(requestText, /For short, ambiguous, acknowledgement-style, or context-dependent replies/i);
    assert.match(requestText, /Would you be interested in getting PACKAGE B/i);
  } finally {
    restore();
  }
});

test("route classifier prompt includes FAQ examples as primary-intent clues", async () => {
  let requestText = "";
  const restore = mockOpenAi(
    JSON.stringify({
      message_type: "general_faq",
      primary_intent: "general_stock_arrival_time",
      related_product: "",
      clarification_required: false,
      human_support_required: false,
      confidence: "high",
      reason: "Customer asks when item arrives after ordering.",
    }),
    (_url, options) => {
      requestText = inputTextFromRequest(options);
    }
  );

  try {
    const route = await classifyCustomerMessageRoute({
      apiKey: "test",
      model: "test-model",
      customerMessage: "if order today, bila sampai roughly?",
      normalizedCustomerMessage: "if order today bila sampai roughly",
      productName: "BLACK SESAME PUFF",
      faqTopics: [
        {
          id: "general_stock_arrival_time",
          label: "How many days new stock takes to arrive",
          exampleQuestions: [
            "Berapa hari barang baru sampai?",
            "Stock sampai berapa hari?",
            "Bila dapat hantar?",
          ],
        },
      ],
    });

    assert.equal(route.messageType, "general_faq");
    assert.equal(route.primaryIntent, "general_stock_arrival_time");
    assert.match(requestText, /Use FAQ_TOPIC labels and example customer questions as meaning clues/i);
    assert.match(requestText, /Example customer questions:/);
    assert.match(requestText, /Bila dapat hantar/i);
  } finally {
    restore();
  }
});

test("route classifier prompt passes awaiting package-interest state for contextual buying replies", async () => {
  let requestText = "";
  const restore = mockOpenAi(
    JSON.stringify({
      message_type: "purchase_intent",
      primary_intent: "",
      related_product: "",
      clarification_required: false,
      human_support_required: false,
      confidence: "high",
      reason: "Customer accepts the latest package interest question.",
    }),
    (_url, options) => {
      requestText = inputTextFromRequest(options);
    }
  );

  try {
    const route = await classifyCustomerMessageRoute({
      apiKey: "test",
      model: "test-model",
      customerMessage: "Saya mau",
      normalizedCustomerMessage: "saya mau",
      productName: "PY1-PUSSY",
      activeState: "awaitingPackageInterest",
      conversationContext: [
        { direction: "outbound", body: "You want order 1 pcs with lubricant?" },
      ],
    });

    assert.equal(route.messageType, "purchase_intent");
    assert.equal(route.confidence, "high");
    assert.match(requestText, /Active state: awaitingPackageInterest/i);
    assert.match(requestText, /Never classify the latest customer message in isolation/i);
    assert.match(requestText, /do not let it override the immediate previous bot\/team message/i);
    assert.match(requestText, /immediate previous message or recent context clearly asked/i);
    assert.match(requestText, /You want order 1 pcs with lubricant/i);
  } finally {
    restore();
  }
});

test("sales selector prompt uses recent context and treats examples as guidance", async () => {
  let requestText = "";
  const restore = mockOpenAi(
    JSON.stringify({
      sales_reply_id: "sales_thinking_first",
      match: "high",
      reason: "Short reply means not ready yet in context.",
    }),
    (_url, options) => {
      requestText = inputTextFromRequest(options);
    }
  );

  try {
    const selected = await selectSalesReply({
      apiKey: "test",
      model: "test-model",
      customerMessage: "belum lagi",
      normalizedCustomerMessage: "belum lagi",
      productName: "BLACK SESAME PUFF",
      activeState: "awaitingPackageInterest",
      routePrimaryIntent: "thinking_first",
      routeReason: "Customer gives a short hesitation after a package offer.",
      conversationContext: [
        { direction: "outbound", body: "Ada kita rasa minat nak ambil Package B?" },
      ],
      salesReplyRecords: [
        {
          id: "sales_thinking_first",
          sales_intent: "thinking_first",
          scope: "general",
          objection_type: "Thinking first",
          intent: "Customer wants to think first or decide later.",
          example_messages: ["fikir dulu", "tanya dulu"],
        },
      ],
    });

    assert.deepEqual(selected, {
      salesReplyId: "sales_thinking_first",
      reason: "Short reply means not ready yet in context.",
    });
    assert.match(requestText, /Recent conversation:/);
    assert.match(requestText, /Active state: awaitingPackageInterest/i);
    assert.match(requestText, /Route classifier sales-intent hint: thinking_first/i);
    assert.match(requestText, /Use active state and route classifier intent as context hints only/i);
    assert.match(requestText, /Ada kita rasa minat nak ambil Package B/i);
    assert.match(requestText, /Examples guide the meaning but do not limit matching/i);
    assert.match(requestText, /closest clearly-supported approved SALES_REPLY_ID/i);
  } finally {
    restore();
  }
});

test("sales reply expected-action classifier judges the outbound approved reply", async () => {
  let requestText = "";
  const restore = mockOpenAi(
    JSON.stringify({
      expects_action: true,
      expected_action_type: "package_interest_confirmation",
      confidence: "high",
      reason: "Reply offers to lock promo if ready.",
    }),
    (_url, options) => {
      requestText = inputTextFromRequest(options);
    }
  );

  try {
    const selected = await classifySalesReplyExpectedAction({
      apiKey: "test",
      model: "test-model",
      approvedReply: "Boleh kita, harga ani memang promo sudah ya. Kalau kita ready, saya boleh bantu lock harga promo ani dulu.",
      salesIntent: "price_objection_negotiation",
      objectionType: "Price objection / negotiation",
      afterReply: "WAIT_FOR_CUSTOMER",
      productName: "PY1-PUSSY",
      customerMessage: "Buleh diskaun sikit?",
      activeState: "awaitingPackageInterest",
      conversationContext: [
        { direction: "outbound", body: "You want order 1 pcs with lubricant?" },
        { direction: "inbound", body: "Buleh diskaun sikit?" },
      ],
    });

    assert.deepEqual(selected, {
      expectsAction: true,
      expectedActionType: "package_interest_confirmation",
      confidence: "high",
      reason: "Reply offers to lock promo if ready.",
    });
    assert.match(requestText, /approved outbound sales reply/i);
    assert.match(requestText, /This is not customer intent classification/i);
    assert.match(requestText, /After-reply setting: WAIT_FOR_CUSTOMER/i);
    assert.match(requestText, /saya boleh bantu lock harga promo/i);
    assert.match(requestText, /Do not invent action expectation from active state alone/i);
  } finally {
    restore();
  }
});

test("knowledge sales follow-up selector uses answer, latest message, state, and configured fallback", async () => {
  let requestText = "";
  const restore = mockOpenAi(
    JSON.stringify({
      action: "contextual",
      follow_up: "Kita tunggu gaji kah?",
      reason: "Customer previously mentioned salary timing.",
    }),
    (_url, options) => {
      requestText = inputTextFromRequest(options);
    }
  );

  try {
    const selected = await selectKnowledgeSalesFollowup({
      apiKey: "test",
      model: "test-model",
      customerMessage: "until when the promo?",
      answer: "Promo sampai esok saja ya.",
      productName: "PY1-PUSSY",
      activeState: "awaitingPackageInterest",
      configuredFollowup: "Ada kita rasa minat nak ambil Package B?",
      conversationContext: [
        { direction: "inbound", body: "i see" },
        { direction: "outbound", body: "Are you waiting salary?" },
      ],
    });

    assert.deepEqual(selected, {
      action: "contextual",
      followUp: "Kita tunggu gaji kah?",
      reason: "Customer previously mentioned salary timing.",
    });
    assert.match(requestText, /FAQ\/product answer being sent: Promo sampai esok saja ya/i);
    assert.match(requestText, /Active state: awaitingPackageInterest/i);
    assert.match(requestText, /Configured FAQ Sales Follow-Up: Ada kita rasa minat nak ambil Package B/i);
    assert.match(requestText, /immediate previous bot\/team message/i);
    assert.match(requestText, /Do not ask more than one follow-up question/i);
  } finally {
    restore();
  }
});

test("template suggestion prompt is FAQ-only and includes existing topics", async () => {
  let requestText = "";
  const restore = mockOpenAi(
    JSON.stringify({
      type: "product_faq",
      existing_topic_id: "py1_battery_life",
      topic: "Battery life",
      reason: "Reusable product question covered by existing topic.",
    }),
    (_url, options) => {
      requestText = inputTextFromRequest(options);
    }
  );

  try {
    const suggestion = await suggestTemplateImprovement({
      apiKey: "test",
      model: "test-model",
      customerMessage: "battery tahan berapa jam?",
      adminReply: "Battery tahan around 6 jam ya.",
      productName: "PY1-PUSSY",
      productId: "py1-pussy",
      existingGeneralFaqs: [
        { id: "general_delivery_fee", topic: "Delivery fee", exampleQuestions: ["Delivery ada caj?"] },
      ],
      existingProductFaqs: [
        { id: "py1_battery_life", topic: "Battery life", exampleQuestions: ["Battery tahan lama kah?"] },
      ],
    });

    assert.equal(suggestion.type, "faq");
    assert.equal(suggestion.scope, "product");
    assert.equal(suggestion.existingTopicId, "py1_battery_life");
    assert.match(requestText, /Do not create sales replies/i);
    assert.match(requestText, /Existing General FAQ topics:/i);
    assert.match(requestText, /Existing Product FAQ topics for the active product:/i);
    assert.match(requestText, /py1_battery_life/i);
    assert.match(requestText, /New topic wording must be short, clean, reusable, and professional/i);
  } finally {
    restore();
  }
});
