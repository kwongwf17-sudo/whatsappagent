import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeImageKnowledgeChunk } from "./knowledge_sanitizer.mjs";

test("benefit image chunks do not keep invented price or promo search terms", () => {
  const sanitized = sanitizeImageKnowledgeChunk({
    category: "benefit_claim",
    title: "Before and after blackhead remover results",
    summary: "Promotional before-and-after image showing cleaner pores and smoother look.",
    extracted_text: "See The Difference\nCleaner pores. Smoother look.",
    embedding_text: "benefit_claim promo image cleaner pores smoother look",
    brunei_malay_summary:
      "Bantu sedut dan bersihkan blackhead/minyak di pori supaya hidung nampak lebih bersih. Info gambar ada menunjukkan harga atau promo produk.",
    brunei_malay_search_text:
      "apa fungsi produk ani blackhead remover | berapa harga harga promo promosi pakej package combo add on discount diskaun buy 1 free 1",
    brunei_malay_question_examples: ["Apa fungsi produk ani?", "Berapa harga?", "Ada promo kah?"],
  });

  assert.equal(
    sanitized.brunei_malay_summary,
    "Bantu sedut dan bersihkan blackhead/minyak di pori supaya hidung nampak lebih bersih."
  );
  assert.equal(sanitized.brunei_malay_search_text, "apa fungsi produk ani blackhead remover");
  assert.deepEqual(sanitized.brunei_malay_question_examples, ["Apa fungsi produk ani?"]);
});

test("real price image chunks keep price search terms", () => {
  const sanitized = sanitizeImageKnowledgeChunk({
    category: "price",
    title: "Blackhead Remover price photo",
    summary: "Price poster with package deals.",
    extracted_text: "PACKAGE A 2 UNIT = B$39; COD TO ALL BRUNEI",
    brunei_malay_search_text:
      "apa fungsi produk ani blackhead remover | berapa harga harga promo promosi pakej package combo add on discount diskaun buy 1 free 1 | cod ada barang sampai baru bayar",
    brunei_malay_question_examples: ["Berapa harga?", "COD ada?"],
  });

  assert.match(sanitized.brunei_malay_search_text, /berapa harga/);
  assert.match(sanitized.brunei_malay_search_text, /cod ada/);
  assert.deepEqual(sanitized.brunei_malay_question_examples, ["Berapa harga?", "COD ada?"]);
});
