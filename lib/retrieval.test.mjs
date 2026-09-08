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
