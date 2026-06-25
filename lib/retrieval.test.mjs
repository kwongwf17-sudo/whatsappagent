import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { approvedProductFactRecordsForProduct } from "./conversation.mjs";
import { retrieveProductFactRecords } from "./retrieval.mjs";

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
