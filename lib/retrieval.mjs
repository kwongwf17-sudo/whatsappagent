import crypto from "node:crypto";

const embeddingCache = new Map();
const STOPWORDS = new Set([
  "a",
  "ada",
  "and",
  "apa",
  "atau",
  "bagi",
  "buleh",
  "boleh",
  "can",
  "dan",
  "di",
  "do",
  "for",
  "if",
  "in",
  "is",
  "it",
  "kah",
  "kan",
  "kat",
  "ke",
  "kita",
  "mana",
  "mau",
  "nak",
  "of",
  "on",
  "or",
  "saya",
  "the",
  "to",
  "untuk",
  "ya",
]);

export async function retrieveFaqRecords({
  records,
  customerMessage,
  productName,
  embedTexts,
  topK = 8,
}) {
  return retrieveRecords({
    records,
    customerMessage,
    embedTexts,
    topK,
    toText: (record) => [
      `FAQ_ID: ${record.id}`,
      `SCOPE: ${record.scope || "general"}${record.product_id ? ` (${productName})` : ""}`,
      `TOPIC: ${record.topic || ""}`,
      "EXAMPLE CUSTOMER QUESTIONS:",
      ...(record.example_questions || []).map((question) => `- ${question}`),
      `APPROVED_REPLY: ${record.approved_reply || ""}`,
    ].join("\n"),
  });
}

export async function retrieveSalesReplyRecords({
  records,
  customerMessage,
  productName,
  embedTexts,
  topK = 8,
}) {
  return retrieveRecords({
    records,
    customerMessage,
    embedTexts,
    topK,
    toText: (record) => [
      `SALES_REPLY_ID: ${record.id}`,
      `SCOPE: ${record.scope || "general"}${record.product_id ? ` (${productName})` : ""}`,
      `SALES_INTENT: ${record.sales_intent || record.intent_key || ""}`,
      `REPEAT_ACTION: ${record.repeat_action || "openai_acknowledge"}`,
      `OBJECTION TYPE: ${record.objection_type || record.topic || ""}`,
      `INTENT: ${record.intent || ""}`,
      "EXAMPLE CUSTOMER MESSAGES:",
      ...(record.example_messages || []).map((message) => `- ${message}`),
      `APPROVED_REPLY: ${record.approved_reply || ""}`,
      ...(record.followup_prompt ? [`FOLLOWUP_PROMPT: ${record.followup_prompt}`] : []),
    ].join("\n"),
  });
}

export async function retrieveProductFactRecords({
  records,
  customerMessage,
  productName,
  embedTexts,
  topK = 8,
}) {
  return retrieveRecords({
    records,
    customerMessage,
    embedTexts,
    topK,
    toText: (record) => [
      `FACT_ID: ${record.id}`,
      `KIND: ${record.kind || "fact"}`,
      `PRODUCT: ${productName || record.product_name || ""}`,
      `CATEGORY: ${record.category || "other"}`,
      `SOURCE_IMAGE: ${record.sourceImageUrl || ""}`,
      `SOURCE_LABEL: ${record.sourceLabel || record.sourceSlot || ""}`,
      `SOURCE_FILENAME: ${record.sourceFilename || ""}`,
      `TITLE: ${record.title || ""}`,
      `LABEL: ${record.label || ""}`,
      `VALUE: ${record.value || ""}`,
      `SUMMARY: ${record.summary || ""}`,
      `EXTRACTED_TEXT: ${record.extracted_text || ""}`,
      `EMBEDDING_TEXT: ${record.embedding_text || ""}`,
      `BRUNEI_MALAY_SUMMARY: ${record.brunei_malay_summary || ""}`,
      `BRUNEI_MALAY_SEARCH_TEXT: ${record.brunei_malay_search_text || ""}`,
      `BILINGUAL_SEARCH_TERMS: ${bilingualSearchTerms(record)}`,
      `CONFIDENCE: ${record.confidence || ""}`,
      `CUSTOMER_SAFE: ${record.customer_safe !== false}`,
      `APPROVAL_NOTE: ${record.approval_note || ""}`,
      "EXAMPLE CUSTOMER QUESTIONS:",
      ...(record.question_examples || []).map((question) => `- ${question}`),
      "BRUNEI-MALAY EXAMPLE CUSTOMER QUESTIONS:",
      ...(record.brunei_malay_question_examples || []).map((question) => `- ${question}`),
      `APPROVED_REPLY: ${record.approved_reply || `${record.label}: ${record.value}`}`,
    ].join("\n"),
  });
}

async function retrieveRecords({
  records,
  customerMessage,
  embedTexts,
  toText,
  topK,
}) {
  const activeRecords = (records || []).filter((record) => record && record.active !== false);
  if (!activeRecords.length) return [];

  const chunks = activeRecords.map((record) => ({
    record,
    text: toText(record),
  }));

  if (embedTexts) {
    try {
      return await retrieveWithEmbeddings(chunks, expandSearchText(customerMessage), embedTexts, topK);
    } catch {
      // Local token retrieval keeps the agent working when embeddings/network are unavailable.
    }
  }

  return retrieveWithTokens(chunks, expandSearchText(customerMessage), topK);
}

function expandSearchText(value) {
  const text = String(value || "");
  const normalized = normalize(text);
  const expansions = [];
  const rules = [
    [/\b(fungsi|function|untuk\s*apa|buat\s*apa|kegunaan|benefit|manfaat|kebaikan)\b/i, "fungsi function kegunaan benefit manfaat untuk apa buat apa bantu helps softening sebum clear pores blackhead extraction gentle formula"],
    [/\b(cara\s*guna|macam\s*mana\s*guna|cara\s*pakai|pakai|apply|use|usage)\b/i, "cara guna cara pakai how to use usage instruction apply pakai"],
    [/\b(sensitif|sensitive|kulit\s*sensitive|gentle|lembut)\b/i, "kulit sensitif sensitive skin gentle formula sesuai kulit sensitif"],
    [/\b(suction|sedut|sedutan|kuat|kpa)\b/i, "suction sedut sedutan kuat strong suction deep pore suction kpa"],
    [/\b(mode|modes|level|intensity|normal|intermediate|strong|berapa\s*mode)\b/i, "mode modes level intensity normal intermediate strong suction mode berapa mode"],
    [/\b(head|heads|kepala|probe)\b/i, "head heads kepala suction head probe head different areas"],
    [/\b(recharge|rechargeable|charging|charge|cas|bateri|battery|usb)\b/i, "recharge rechargeable charging charge cas bateri battery usb usb-c"],
    [/\b(side\s*effect|kesan|allergy|alergi|iritasi|pedih)\b/i, "side effect kesan sampingan allergy sensitive irritation"],
    [/\b(berapa\s*lama|hasil|result|nampak|visible|tahan|last)\b/i, "berapa lama hasil result visible results how long duration tahan"],
    [/\b(original|ori|authentic|genuine)\b/i, "original ori authentic genuine"],
    [/\b(review|testimoni|testimonial|customer)\b/i, "review testimonial testimoni customer"],
    [/\b(harga|price|promo|promosi|package|pakej|combo|discount|diskaun|buy\s*1|free\s*1)\b/i, "harga price promo promosi package pakej combo discount diskaun buy 1 free 1"],
    [/\b(ml|milliliter|isi|volume|botol)\b/i, "ml milliliter volume isi botol bottle"],
    [/\b(cod|delivery|hantar|perhantaran|penghantaran|runner|self\s*collect|pickup)\b/i, "cod delivery hantar perhantaran penghantaran runner self collect pickup barang sampai baru bayar"],
  ];
  for (const [pattern, terms] of rules) {
    if (pattern.test(normalized)) expansions.push(terms);
  }
  return [text, ...expansions].join("\n");
}

function bilingualSearchTerms(record) {
  const text = normalize([
    record.category,
    record.title,
    record.label,
    record.value,
    record.summary,
    record.extracted_text,
    record.embedding_text,
    record.brunei_malay_summary,
    record.brunei_malay_search_text,
  ].filter(Boolean).join(" "));
  const terms = [];
  if (/\b(soften|sebum|clear\s*pores|blackhead|benefit|gentle|visible\s*results|formula)\b/i.test(text)) {
    terms.push("fungsi produk ani untuk apa kegunaan benefit manfaat bantu lembutkan sebum bantu bersihkan pori bantu mudahkan blackhead dibersihkan kulit nampak lebih smooth gentle formula kulit sensitif");
  }
  if (/\b(suction|sedut|strong|kpa|mode|normal|intermediate|head|probe|recharge|usb|charging|battery)\b/i.test(text)) {
    terms.push("suction sedut sedutan kuat kpa mode berapa mode normal intermediate strong kepala head probe recharge cas bateri usb usb-c");
  }
  if (/\b(1\s*unit|combo|price|promo|\$|b\$|add[-\s]?on)\b/i.test(text)) {
    terms.push("harga berapa promo promosi pakej package combo diskaun discount buy 1 free 1");
  }
  if (/\b(ml|volume|150)\b/i.test(text)) {
    terms.push("berapa ml isi botol volume berapa banyak");
  }
  if (/\b(cod|delivery|barang\s*sampai|runner)\b/i.test(text)) {
    terms.push("cod delivery hantar runner barang sampai baru bayar bayar masa barang sampai");
  }
  return terms.join(" | ");
}

async function retrieveWithEmbeddings(chunks, customerMessage, embedTexts, topK) {
  const missing = chunks.filter((chunk) => !embeddingCache.has(cacheKey(chunk.text)));
  if (missing.length) {
    const embeddings = await embedTexts(missing.map((chunk) => chunk.text));
    embeddings.forEach((embedding, index) => {
      if (Array.isArray(embedding)) embeddingCache.set(cacheKey(missing[index].text), embedding);
    });
  }

  const [queryEmbedding] = await embedTexts([customerMessage]);
  if (!Array.isArray(queryEmbedding)) throw new Error("Missing query embedding.");

  return chunks
    .map((chunk) => ({
      record: chunk.record,
      score: cosineSimilarity(queryEmbedding, embeddingCache.get(cacheKey(chunk.text))),
      retrieval: "embedding",
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ record, score, retrieval }) => ({ ...record, retrieval_score: score, retrieval }));
}

function retrieveWithTokens(chunks, customerMessage, topK) {
  const queryTerms = terms(customerMessage);
  if (!queryTerms.length) return chunks.slice(0, topK).map((chunk) => ({ ...chunk.record, retrieval_score: 0, retrieval: "token" }));

  return chunks
    .map((chunk) => {
      const docTerms = terms(chunk.text);
      const docSet = new Set(docTerms);
      const overlap = queryTerms.filter((term) => docSet.has(term)).length;
      const phraseBoost = normalize(chunk.text).includes(normalize(customerMessage)) ? 1 : 0;
      const score = overlap / Math.sqrt(Math.max(queryTerms.length, 1) * Math.max(docSet.size, 1)) + phraseBoost;
      return { record: chunk.record, score, retrieval: "token" };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ record, score, retrieval }) => ({ ...record, retrieval_score: score, retrieval }));
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return Number.NaN;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    magA += a[index] * a[index];
    magB += b[index] * b[index];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function terms(value) {
  return normalize(value)
    .split(/[^a-z0-9$]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1 && !STOPWORDS.has(term));
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function cacheKey(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}
