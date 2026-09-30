import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { approvedProductFactRecordsForProduct } from "./conversation.mjs";
import { filterKnowledgeRecordsForRoute, retrieveProductFactRecords } from "./retrieval.mjs";

const catalog = JSON.parse(
  await readFile(new URL("../data/product_catalog.json", import.meta.url), "utf8")
);
const product = catalog.products.find((item) => item.id === "blackhead-remover");

test("product fact retrieval finds feature chunks for Malay product questions", async () => {
  const records = approvedProductFactRecordsForProduct(product);
  const cases = [
    ["Suction kuat tak?", /strong suction|60kpa|deep pore suction/i],
    ["Ada berapa mode?", /3 suction modes|normal|intermediate|strong/i],
    ["Buleh recharge?", /rechargeable|usb/i],
  ];

  for (const [customerMessage, expectedKnowledge] of cases) {
    const hits = await retrieveProductFactRecords({
      records,
      customerMessage,
      productName: product.name,
      topK: 3,
    });
    const combined = hits
      .map((hit) => [hit.summary, hit.extracted_text, hit.embedding_text, hit.brunei_malay_summary].filter(Boolean).join(" "))
      .join("\n");

    assert.ok(hits.length > 0, customerMessage);
    assert.match(combined, expectedKnowledge, customerMessage);
  }
});

test("knowledge route filter keeps general FAQ RAG scoped to general FAQ records", () => {
  const records = [
    { id: "general_pay_end_month", knowledge_type: "general_faq" },
    { id: "blackhead_cod", knowledge_type: "product_fact", product_id: product.id },
  ];

  const filtered = filterKnowledgeRecordsForRoute(records, {
    messageType: "general_faq",
    primaryIntent: "general_pay_end_month",
    confidence: "high",
  }, product);

  assert.deepEqual(filtered.map((record) => record.id), ["general_pay_end_month"]);
});

test("knowledge route filter keeps general FAQ vector-store chunks", () => {
  const records = [
    {
      id: "general_faq_chunk",
      knowledge_type: "vector_store_chunk",
      text: [
        "# Vector Store Knowledge: General FAQ",
        "### FAQ: delivery_area",
        "Scope: general",
        "Customer question example: Ada COD?",
        "Approved answer: Boleh, COD to all Brunei.",
      ].join("\n"),
    },
    {
      id: "product_faq_chunk",
      knowledge_type: "vector_store_chunk",
      text: [
        "# Vector Store Knowledge: Approved Product FAQ",
        "### FAQ: product_price",
        "Scope: product",
        `Product ID: ${product.id}`,
        "Approved answer: Product price is $49.",
      ].join("\n"),
    },
    {
      id: "product_fact_chunk",
      knowledge_type: "vector_store_chunk",
      text: [
        "# Vector Store Knowledge: Extracted Product Image Knowledge",
        "Scope: product",
        `Product ID: ${product.id}`,
        "Approved opening-flow content: Product feature.",
      ].join("\n"),
    },
  ];

  const filtered = filterKnowledgeRecordsForRoute(records, {
    messageType: "general_faq",
    primaryIntent: "delivery_area",
    confidence: "high",
  }, product);

  assert.deepEqual(filtered.map((record) => record.id), ["general_faq_chunk"]);
});

test("knowledge route filter keeps product-question chunks from accepting general FAQ vector chunks", () => {
  const records = [
    {
      id: "general_faq_chunk",
      knowledge_type: "vector_store_chunk",
      text: [
        "# Vector Store Knowledge: General FAQ",
        "### FAQ: delivery_area",
        "Scope: general",
        "Approved answer: Boleh, COD to all Brunei.",
      ].join("\n"),
    },
    {
      id: "active_product_chunk",
      knowledge_type: "vector_store_chunk",
      text: [
        "# Vector Store Knowledge: Product Order Options",
        "Scope: product",
        `Product ID: ${product.id}`,
        "Price: $49",
      ].join("\n"),
    },
  ];

  const filtered = filterKnowledgeRecordsForRoute(records, {
    messageType: "product_question",
    primaryIntent: "product_price",
    confidence: "high",
  }, product);

  assert.deepEqual(filtered.map((record) => record.id), ["active_product_chunk"]);
});

test("knowledge route filter keeps product-question RAG scoped to the active product", () => {
  const records = [
    { id: "general_delivery_fee", knowledge_type: "general_faq" },
    { id: "active_product_price", knowledge_type: "product_fact", product_id: product.id },
    { id: "other_product_price", knowledge_type: "product_fact", product_id: "another-product" },
  ];

  const filtered = filterKnowledgeRecordsForRoute(records, {
    messageType: "product_question",
    primaryIntent: "product_price",
    confidence: "high",
  }, product);

  assert.deepEqual(filtered.map((record) => record.id), ["active_product_price"]);
});

test("knowledge route filter rejects product-question chunks without active product identity", () => {
  const records = [
    { id: "missing_product_id", knowledge_type: "product_fact", text: "Price: $49" },
    { id: "text_active_product", knowledge_type: "product_fact", text: `Product ID: ${product.id}\nPrice: $49` },
    { id: "text_other_product", knowledge_type: "product_fact", text: "Product ID: other-product\nPrice: $39" },
  ];

  const filtered = filterKnowledgeRecordsForRoute(records, {
    messageType: "product_question",
    primaryIntent: "product_price",
    confidence: "high",
  }, product);

  assert.deepEqual(filtered.map((record) => record.id), ["text_active_product"]);
});
