import assert from "node:assert/strict";
import test from "node:test";
import { classifyCustomerMessageRoute, selectSalesReply } from "./openai.mjs";

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
    assert.match(requestText, /First infer whether the customer message is standalone/i);
    assert.match(requestText, /For short or ambiguous replies, use recent context/i);
    assert.match(requestText, /Would you be interested in getting PACKAGE B/i);
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
    assert.match(requestText, /Ada kita rasa minat nak ambil Package B/i);
    assert.match(requestText, /Examples guide the meaning but do not limit matching/i);
    assert.match(requestText, /closest clearly-supported approved SALES_REPLY_ID/i);
  } finally {
    restore();
  }
});
