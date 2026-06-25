import { readFile } from "node:fs/promises";
import path from "node:path";

const OPENAI_BASE_URL = "https://api.openai.com/v1";

async function openaiFetch(apiKey, endpoint, options = {}) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
    ...(options.headers || {}),
  };

  const response = await fetch(`${OPENAI_BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data?.error?.message || response.statusText;
    throw new Error(`OpenAI ${endpoint} failed: ${message}`);
  }
  return data;
}

export async function createVectorStore(apiKey, name) {
  return openaiFetch(apiKey, "/vector_stores", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function uploadFile(apiKey, filePath) {
  const body = new FormData();
  const bytes = await readFile(filePath);
  body.append("purpose", "assistants");
  body.append("file", new Blob([bytes]), path.basename(filePath));

  return openaiFetch(apiKey, "/files", {
    method: "POST",
    body,
  });
}

export async function attachFileToVectorStore(apiKey, vectorStoreId, fileId) {
  return openaiFetch(apiKey, `/vector_stores/${vectorStoreId}/files`, {
    method: "POST",
    body: JSON.stringify({ file_id: fileId }),
  });
}

export async function getVectorStoreFile(apiKey, vectorStoreId, fileId) {
  return openaiFetch(apiKey, `/vector_stores/${vectorStoreId}/files/${fileId}`);
}

export async function createCustomerServiceResponse({
  apiKey,
  model,
  vectorStoreId,
  businessName,
  supportLanguage,
  customerId,
  customerMessage,
  productName = "",
  productId = "",
  maxResults = 6,
}) {
  const systemPrompt = `
You are the WhatsApp customer service agent for ${businessName}.

Use the file_search tool as your source of truth for product information, reply flows, and SOPs.
Follow these rules:
- Reply in ${supportLanguage}.
- Be concise, warm, and clear. WhatsApp replies should be easy to scan.
- Use only information found by file_search or explicitly present in the provided customer message.
- Do not answer from general world knowledge, assumptions, or likely/common product behavior.
- Active product context: ${productName || "unknown product"}${productId ? ` (${productId})` : ""}.
- Do not answer product-specific details for any product other than the active product.
- If the customer asks product-specific details and file_search returns only another product's information, set handoff_required to true.
- Classify buying intention from meaning and context, not by matching isolated product or package words.
- Set buying_intent to "buying" only when the customer clearly commits to order, reserve, lock, or proceed with a purchase, or is submitting order details.
- Set buying_intent to "not_buying" for questions about price, packages, product information, availability, delivery, or comparisons without a commitment to purchase.
- Set buying_intent to "unclear" when purchase commitment cannot be determined confidently.
- Set reply_type to "faq" when answering a product or general business information question from the knowledge base.
- Set reply_type to "other" for non-FAQ replies, clarification questions, complaints, or human-review responses.
- Do not add a sales question after an FAQ answer; the application sends the approved sales follow-up separately.
- Do not invent prices, stock, shipping timelines, refund eligibility, ingredients, warranty terms, or policy details.
- If the knowledge base does not directly answer the question, do not guess. Set handoff_required to true, reply_type to "other", buying_intent to "unclear", and use a short reply like "Terima kasih kita. Saya akan minta team check dan reply kita sekejap lagi."
- Never provide an answer that is only inferred from similar products, marketing claims, or partial context.
- Never request full card numbers, passwords, OTPs, or unnecessary personal data.
- For refunds, complaints, damaged goods, angry customers, legal threats, account-specific order checks, or anything outside SOP, set handoff_required to true.
- Return only valid JSON with this shape:
  {"reply":"message to send to customer","reply_type":"faq|other","buying_intent":"buying|not_buying|unclear","buying_intent_reason":"brief reason","handoff_required":false,"handoff_reason":""}
`.trim();

  const payload = {
    model,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: systemPrompt }],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Customer WhatsApp ID: ${customerId}\nActive product: ${productName || "unknown"}\nActive product ID: ${productId || "unknown"}\nCustomer message: ${customerMessage}`,
          },
        ],
      },
    ],
    tools: [
      {
        type: "file_search",
        vector_store_ids: [vectorStoreId],
        max_num_results: maxResults,
      },
    ],
  };

  const data = await openaiFetch(apiKey, "/responses", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const text = extractOutputText(data);
  return parseAgentJson(text);
}

export async function createEmbeddings({
  apiKey,
  model = "text-embedding-3-small",
  input,
}) {
  const values = Array.isArray(input) ? input : [input];
  const data = await openaiFetch(apiKey, "/embeddings", {
    method: "POST",
    body: JSON.stringify({
      model,
      input: values.map((value) => String(value || "")),
    }),
  });
  return (data.data || [])
    .sort((a, b) => Number(a.index || 0) - Number(b.index || 0))
    .map((item) => item.embedding);
}

export async function extractProductKnowledgeFromImage({
  apiKey,
  model,
  productName,
  imageDataUrl,
  imageLabel = "product image",
}) {
  const systemPrompt = `
You extract one image-level knowledge chunk from a product image for a WhatsApp sales agent.

Rules:
- Extract only facts visible in the image or clearly written in the image.
- Do not guess missing facts.
- Preserve the meaning of the image, but avoid turning marketing text into stronger claims.
- Do not create medical, cure, guaranteed-result, or permanent-result claims.
- Create exactly one image_chunk that summarizes the whole image as a searchable knowledge source.
- The image_chunk must stay grounded to the image and should mention visible headings, sections, and important text.
- If the image/file label includes words like benefit, feature, price, ingredient, usage, warning, testimonial, use that clue for image_chunk.category only when it matches the image content.
- Use a precise category for the image_chunk:
  specification, ingredient, usage, price, package_option, add_on, feature, benefit_claim, problem_shown, caution, delivery, warranty_refund, stock_timeline, social_proof, other
- Use "benefit_claim" only for marketing benefits written or clearly shown in the image.
- Use "problem_shown" for before-side or problem labels like blackheads, oily T-zone, clogged pores.
- Use "feature" for product capabilities like suction modes, heads, rechargeable, button.
- Use "specification" for measurable facts like volume, size, quantity, material, battery, power.
- Do not create separate fact rows. Put all useful visible content inside image_chunk.summary, image_chunk.extracted_text, and image_chunk.embedding_text.
- Also create Brunei-Malay customer wording for the same knowledge:
  - brunei_malay_summary: a natural Brunei/Malay customer-facing summary grounded only in the image.
  - brunei_malay_search_text: Brunei/Malay search wording and slang customers may use to ask about this image content.
  - brunei_malay_question_examples: example customer questions in Brunei/Malay style.
- Prefer customer-answerable content over vague words, but keep visible marketing/problem text inside the chunk when it helps retrieval.
- Set customer_safe false when the image content is too risky to answer customers without human review.
- Return only valid JSON:
{"image_chunk":{"category":"feature","title":"Product features","summary":"Short customer-safe English summary","extracted_text":"Important visible text from the image","embedding_text":"Searchable English text combining product, image label, category, summary, and visible text","brunei_malay_summary":"Brunei-Malay customer wording grounded to the image","brunei_malay_search_text":"Brunei-Malay/slang search words customers may use","customer_safe":true,"approval_note":"Visible in image","question_examples":["what are the features?","berapa ml?"],"brunei_malay_question_examples":["apa fungsi produk ani?","buleh pakai untuk apa?"]},"facts":[]}
`.trim();

  const data = await openaiFetch(apiKey, "/responses", {
    method: "POST",
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Product: ${productName}\nImage label: ${imageLabel}\nExtract one image_chunk from this image. Do not create separate fact rows.`,
            },
            {
              type: "input_image",
              image_url: imageDataUrl,
            },
          ],
        },
      ],
    }),
  });

  try {
    const parsed = JSON.parse(extractOutputText(data));
    return {
      imageChunk: normalizeImageChunk(parsed.image_chunk),
      facts: [],
    };
  } catch {
    return { imageChunk: null, facts: [] };
  }
}

function normalizeImageChunk(chunk) {
  if (!chunk || typeof chunk !== "object") return null;
  const title = String(chunk.title || "").trim();
  const summary = String(chunk.summary || "").trim();
  const extractedText = String(chunk.extracted_text || "").trim();
  const embeddingText = String(chunk.embedding_text || "").trim();
  const bruneiMalaySummary = String(chunk.brunei_malay_summary || "").trim();
  const bruneiMalaySearchText = String(chunk.brunei_malay_search_text || "").trim();
  if (!title && !summary && !extractedText && !embeddingText) return null;
  return {
    category: normalizeExtractionCategory(chunk.category),
    title: title || "Image knowledge",
    summary,
    extracted_text: extractedText,
    embedding_text: embeddingText || [title, summary, extractedText].filter(Boolean).join("\n"),
    brunei_malay_summary: bruneiMalaySummary,
    brunei_malay_search_text: bruneiMalaySearchText,
    customer_safe: chunk.customer_safe !== false,
    approval_note: String(chunk.approval_note || "").trim(),
    question_examples: Array.isArray(chunk.question_examples)
      ? chunk.question_examples.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    brunei_malay_question_examples: Array.isArray(chunk.brunei_malay_question_examples)
      ? chunk.brunei_malay_question_examples.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
  };
}

function normalizeExtractionCategory(value) {
  const category = String(value || "other").trim().toLowerCase();
  return [
    "specification",
    "ingredient",
    "usage",
    "price",
    "package_option",
    "add_on",
    "feature",
    "benefit_claim",
    "problem_shown",
    "caution",
    "delivery",
    "warranty_refund",
    "stock_timeline",
    "social_proof",
    "other",
  ].includes(category) ? category : "other";
}

export async function selectApprovedFaq({
  apiKey,
  model,
  customerMessage,
  productName,
  faqRecords = [],
}) {
  if (!faqRecords.length) return null;
  const candidateText = faqRecords
    .map((faq) => [
      `FAQ_ID: ${faq.id}`,
      `SCOPE: ${faq.scope}${faq.product_id ? ` (${productName})` : ""}`,
      `TOPIC: ${faq.topic}`,
      "EXAMPLE CUSTOMER QUESTIONS:",
      ...(faq.example_questions || []).map((question) => `- ${question}`),
    ].join("\n"))
    .join("\n\n");

  const systemPrompt = `
You match a WhatsApp customer question to an approved FAQ record.

Choose an FAQ_ID only when the customer's meaning is clearly the same as a listed topic or example.
The approved reply will be sent by the application, so do not write a customer reply.
Do not match messages that are orders, order-detail submissions, opt-outs, complaints, refund/damage issues, or unrelated chat.
Use the product-specific records only for ${productName}; general records apply to any product.
Do not use outside knowledge or infer an answer from a similar FAQ.
If the FAQ does not directly answer the exact customer question, return no_match.
If uncertain, return no_match.

Return only valid JSON:
{"faq_id":"matching id or empty","match":"high|no_match","reason":"short reason"}
`.trim();
  const payload = {
    model,
    input: [
      { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
      {
        role: "user",
        content: [{
          type: "input_text",
          text: `Customer message: ${customerMessage}\n\nApproved FAQ records:\n${candidateText}`,
        }],
      },
    ],
  };
  const data = await openaiFetch(apiKey, "/responses", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const text = extractOutputText(data);
  try {
    const parsed = JSON.parse(text);
    const faqId = String(parsed.faq_id || "").trim();
    const match = String(parsed.match || "").trim().toLowerCase();
    if (match !== "high" || !faqId) return null;
    return {
      faqId,
      reason: String(parsed.reason || "").trim(),
    };
  } catch {
    return null;
  }
}

export async function selectSalesReply({
  apiKey,
  model,
  customerMessage,
  productName,
  salesReplyRecords = [],
}) {
  if (!salesReplyRecords.length) return null;
  const candidateText = salesReplyRecords
    .map((reply) => [
      `SALES_REPLY_ID: ${reply.id}`,
      `SCOPE: ${reply.scope}${reply.product_id ? ` (${productName})` : ""}`,
      `OBJECTION TYPE: ${reply.objection_type || reply.topic || ""}`,
      `INTENT: ${reply.intent || ""}`,
      "EXAMPLE CUSTOMER MESSAGES:",
      ...(reply.example_messages || []).map((message) => `- ${message}`),
    ].join("\n"))
    .join("\n\n");

  const systemPrompt = `
You match a WhatsApp customer message to an approved sales reply record.

Choose a SALES_REPLY_ID only when the customer is showing a clear buying objection, hesitation, concern, or sales-related response that matches a listed record.
The approved reply will be sent by the application, so do not write a customer reply.
Do not match factual product questions, order-detail submissions, order status enquiries, opt-outs, complaints, refund/damage issues, legal/report threats, or unrelated chat.
Use the product-specific records only for ${productName}; general records apply to any product.
Do not use outside knowledge or infer a sales objection from unrelated wording.
If the approved sales reply does not directly fit the exact customer message, return no_match.
If uncertain, return no_match.

Return only valid JSON:
{"sales_reply_id":"matching id or empty","match":"high|no_match","reason":"short reason"}
`.trim();
  const data = await openaiFetch(apiKey, "/responses", {
    method: "POST",
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        {
          role: "user",
          content: [{
            type: "input_text",
            text: `Customer message: ${customerMessage}\n\nApproved sales reply records:\n${candidateText}`,
          }],
        },
      ],
    }),
  });
  const text = extractOutputText(data);
  try {
    const parsed = JSON.parse(text);
    const salesReplyId = String(parsed.sales_reply_id || "").trim();
    const match = String(parsed.match || "").trim().toLowerCase();
    if (match !== "high" || !salesReplyId) return null;
    return {
      salesReplyId,
      reason: String(parsed.reason || "").trim(),
    };
  } catch {
    return null;
  }
}

export async function selectProductFact({
  apiKey,
  model,
  customerMessage,
  productName,
  factRecords = [],
}) {
  if (!factRecords.length) return null;
  const candidateText = factRecords
    .map((fact) => [
      `FACT_ID: ${fact.id}`,
      `KIND: ${fact.kind || "fact"}`,
      `PRODUCT: ${productName}`,
      `CATEGORY: ${fact.category || "other"}`,
      `SOURCE_IMAGE: ${fact.sourceImageUrl || ""}`,
      `SOURCE_FILENAME: ${fact.sourceFilename || ""}`,
      `TITLE: ${fact.title || ""}`,
      `LABEL: ${fact.label}`,
      `VALUE: ${fact.value}`,
      `SUMMARY: ${fact.summary || ""}`,
      `EXTRACTED_TEXT: ${fact.extracted_text || ""}`,
      `BRUNEI_MALAY_SUMMARY: ${fact.brunei_malay_summary || ""}`,
      `BRUNEI_MALAY_SEARCH_TEXT: ${fact.brunei_malay_search_text || ""}`,
      `CUSTOMER_SAFE: ${fact.customer_safe !== false}`,
      "EXAMPLE CUSTOMER QUESTIONS:",
      ...(fact.question_examples || []).map((question) => `- ${question}`),
      "BRUNEI-MALAY EXAMPLE CUSTOMER QUESTIONS:",
      ...(fact.brunei_malay_question_examples || []).map((question) => `- ${question}`),
    ].join("\n"))
    .join("\n\n");

  const systemPrompt = `
You match a WhatsApp customer question to approved product knowledge extracted from product images.

Choose a FACT_ID only when the selected fact or image_chunk directly answers the customer's question.
The approved reply will be sent by the application, so do not write a customer reply.
Use facts only for ${productName}.
The customer may write in Malay/Brunei slang. Treat these as equivalent:
- "fungsi", "untuk apa", "kegunaan", "benefit", "apa produk ani buat" = product function/benefit.
- "cara guna", "cara pakai", "macam mana guna" = usage instructions.
- "kulit sensitif", "sensitive" = sensitive skin suitability.
- "suction", "sedut", "sedutan", "kuat", "KPA" = suction strength or suction feature.
- "mode", "berapa mode", "level", "intensity" = selectable product modes or intensity levels.
- "head", "kepala", "probe" = product heads, tips, probes, or attachments.
- "recharge", "cas", "charge", "bateri", "USB" = charging or rechargeable battery feature.
- "berapa lama nampak hasil" = result timing/duration.
For product function/benefit questions, chunks mentioning product benefits, usage areas, sebum care, pore care, suction, modes, rechargeable charging, attachments, gentle formula, or smoother skin are relevant if they belong to ${productName}.
Do not choose facts marked CUSTOMER_SAFE false.
Do not match buying objections, order submissions, complaints, refund/damage issues, or unrelated chat.
Do not use outside knowledge, assumptions, or similar image content.
Do not match an image_chunk just because it shares one or two words with the customer question.
If the approved product knowledge does not directly contain the answer, return no_match.
If uncertain, return no_match.

Return only valid JSON:
{"fact_id":"matching id or empty","match":"high|no_match","reason":"short reason"}
`.trim();

  const data = await openaiFetch(apiKey, "/responses", {
    method: "POST",
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        {
          role: "user",
          content: [{
            type: "input_text",
            text: `Customer message: ${customerMessage}\n\nApproved product facts:\n${candidateText}`,
          }],
        },
      ],
    }),
  });
  const text = extractOutputText(data);
  try {
    const parsed = JSON.parse(text);
    const factId = String(parsed.fact_id || "").trim();
    const match = String(parsed.match || "").trim().toLowerCase();
    if (match !== "high" || !factId) return null;
    return {
      factId,
      reason: String(parsed.reason || "").trim(),
    };
  } catch {
    return null;
  }
}

export async function rerankProductFacts({
  apiKey,
  model,
  customerMessage,
  productName,
  factRecords = [],
  topK = 5,
}) {
  if (!factRecords.length) return [];
  const candidateText = factRecords
    .map((fact, index) => [
      `RANK_CANDIDATE: ${index + 1}`,
      `FACT_ID: ${fact.id}`,
      `RETRIEVAL: ${fact.retrieval || ""}`,
      `RETRIEVAL_SCORE: ${Number.isFinite(fact.retrieval_score) ? fact.retrieval_score : ""}`,
      `KIND: ${fact.kind || "fact"}`,
      `PRODUCT: ${productName}`,
      `CATEGORY: ${fact.category || "other"}`,
      `SOURCE_FILENAME: ${fact.sourceFilename || ""}`,
      `TITLE: ${fact.title || ""}`,
      `LABEL: ${fact.label || ""}`,
      `VALUE: ${fact.value || ""}`,
      `SUMMARY: ${fact.summary || ""}`,
      `EXTRACTED_TEXT: ${fact.extracted_text || ""}`,
      `EMBEDDING_TEXT: ${fact.embedding_text || ""}`,
      `BRUNEI_MALAY_SUMMARY: ${fact.brunei_malay_summary || ""}`,
      `BRUNEI_MALAY_SEARCH_TEXT: ${fact.brunei_malay_search_text || ""}`,
      `CUSTOMER_SAFE: ${fact.customer_safe !== false}`,
      "EXAMPLE CUSTOMER QUESTIONS:",
      ...(fact.question_examples || []).map((question) => `- ${question}`),
      "BRUNEI-MALAY EXAMPLE CUSTOMER QUESTIONS:",
      ...(fact.brunei_malay_question_examples || []).map((question) => `- ${question}`),
    ].join("\n"))
    .join("\n\n");

  const systemPrompt = `
You are a reranker for product-scoped WhatsApp product knowledge RAG.

Rank only the provided approved product knowledge chunks for ${productName}.
Score each chunk from 0 to 100 for whether it directly answers the customer question.
Use Malay/Brunei meaning equivalence when needed:
- "fungsi", "untuk apa", "kegunaan", "benefit" = product function/benefit.
- "cara guna", "cara pakai", "macam mana guna" = usage instructions.
- "kulit sensitif", "sensitive" = sensitive skin suitability.
- "berapa ml" = volume/specification.
- "suction", "sedut", "sedutan", "kuat", "KPA" = suction strength or suction feature.
- "mode", "berapa mode", "level", "intensity" = selectable product modes or intensity levels.
- "head", "kepala", "probe" = product heads, tips, probes, or attachments.
- "recharge", "cas", "charge", "bateri", "USB" = charging or rechargeable battery feature.
- "berapa lama", "how long", "tahan" = duration/usage lifespan/result timing.
Do not reward chunks from similar topics unless they directly answer the exact question.
Do not reward unsafe chunks or chunks that require guessing beyond the provided text.
If no chunk directly answers, return an empty ranked list.

Return only valid JSON:
{"ranked":[{"fact_id":"id","score":0-100,"direct_answer":true,"reason":"short"}]}
`.trim();

  const data = await openaiFetch(apiKey, "/responses", {
    method: "POST",
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        {
          role: "user",
          content: [{
            type: "input_text",
            text: `Customer message: ${customerMessage}\n\nCandidate product knowledge chunks:\n${candidateText}`,
          }],
        },
      ],
    }),
  });

  try {
    const parsed = JSON.parse(extractOutputText(data));
    const byId = new Map(factRecords.map((fact) => [String(fact.id), fact]));
    return (Array.isArray(parsed.ranked) ? parsed.ranked : [])
      .map((item) => ({
        factId: String(item.fact_id || "").trim(),
        score: Number(item.score),
        directAnswer: item.direct_answer === true,
        reason: String(item.reason || "").trim(),
      }))
      .filter((item) => item.factId && byId.has(item.factId) && item.directAnswer && item.score >= 70)
      .sort((left, right) => right.score - left.score)
      .slice(0, topK)
      .map((item) => ({
        ...byId.get(item.factId),
        rerank_score: item.score,
        rerank_reason: item.reason,
      }));
  } catch {
    return [];
  }
}

export async function createProductFactReply({
  apiKey,
  model,
  customerMessage,
  productName,
  factRecord,
}) {
  if (!factRecord) return "";
  const knowledgeText = [
    `PRODUCT: ${productName}`,
    `CATEGORY: ${factRecord.category || "other"}`,
    `TITLE: ${factRecord.title || factRecord.label || ""}`,
    `SUMMARY: ${factRecord.summary || ""}`,
    `EXTRACTED_TEXT: ${factRecord.extracted_text || ""}`,
    `BRUNEI_MALAY_SUMMARY: ${factRecord.brunei_malay_summary || ""}`,
    `BRUNEI_MALAY_SEARCH_TEXT: ${factRecord.brunei_malay_search_text || ""}`,
    `VALUE: ${factRecord.value || ""}`,
  ].join("\n");
  const systemPrompt = `
You write a short WhatsApp customer reply for a Brunei/Malay sales agent.

Use only the approved product knowledge given.
Rephrase the retrieved product knowledge into a natural customer-facing answer.
Answer the customer's exact question naturally.
Do not mention "image", "poster", "chunk", "visible text", "extracted", or internal system wording.
Never copy the raw summary/extracted text directly. Convert it into a friendly WhatsApp answer.
Do not overclaim beyond the knowledge. Keep claims soft, for example "boleh bantu" instead of guaranteed cure.
Do not say "claim produk", "claimed", or quote marketing claims as if they are guaranteed facts.
Do not repeat aggressive result/time claims such as "blackheads out in 5 minutes"; rewrite as a soft benefit or omit it.
For function/benefit questions, answer with safe wording like "boleh bantu lembutkan sebum dan mudahkan blackhead dibersihkan" instead of promising a fixed result.
Do not use outside knowledge, assumptions, similar products, or marketing guesses.
If the approved product knowledge does not directly answer the exact customer question, do not answer. Set handoff_required to true so the application hands off to a human.
If the customer asks about missing details such as duration, usage lifespan, stock quantity, side effects, warranty, delivery timing, product origin, or anything not present in the knowledge, do not answer. Set handoff_required to true.
Use simple Malay/Brunei style when the customer writes Malay. Keep it concise.
For "Apa fungsi produk ani?" or similar function questions, answer from benefits/features in the knowledge, for example sebum care, softening sebum, clearing pores, blackhead extraction, gentle formula, smoother skin, but only if those are present in the provided knowledge.
For feature/spec questions, answer only from the selected knowledge:
- "suction", "sedut", "sedutan", "kuat", "KPA" = suction strength or suction feature.
- "mode", "berapa mode", "level", "intensity" = selectable modes or intensity levels.
- "head", "kepala", "probe" = heads, tips, probes, or attachments.
- "recharge", "cas", "charge", "bateri", "USB" = charging or rechargeable battery feature.

Return only valid JSON:
{"reply":"customer-facing reply or empty string","handoff_required":false,"handoff_reason":"short reason when human should answer"}
`.trim();

  const data = await openaiFetch(apiKey, "/responses", {
    method: "POST",
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        {
          role: "user",
          content: [{
            type: "input_text",
            text: `Customer message: ${customerMessage}\n\nApproved product knowledge:\n${knowledgeText}`,
          }],
        },
      ],
    }),
  });

  try {
    const parsed = JSON.parse(extractOutputText(data));
    if (parsed.handoff_required) return "";
    return String(parsed.reply || "").trim();
  } catch {
    return "";
  }
}

export async function detectOrderStatusIntent({ apiKey, model, customerMessage }) {
  const systemPrompt = `
You classify whether a WhatsApp customer is asking for the status or delivery progress of an order they have already placed.

Return high only for personal order tracking enquiries, such as asking where their order is, whether their ordered item has arrived, or when their delivery will arrive.
Return no_match for pre-sale questions about general stock availability, whether delivery exists, delivery charges, product details, placing a new order, or unrelated conversation.

Return only valid JSON:
{"intent":"order_status|no_match","confidence":"high|low","reason":"short reason"}
`.trim();
  const data = await openaiFetch(apiKey, "/responses", {
    method: "POST",
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content: [{ type: "input_text", text: `Customer message: ${customerMessage}` }] },
      ],
    }),
  });
  try {
    const parsed = JSON.parse(extractOutputText(data));
    return String(parsed.intent || "").trim() === "order_status" &&
      String(parsed.confidence || "").trim() === "high";
  } catch {
    return false;
  }
}

export async function detectComplaintIntent({ apiKey, model, customerMessage }) {
  const systemPrompt = `
You classify whether a WhatsApp customer message must be handed to a human because it is a complaint or after-sales problem.

Escalate these categories:
- complaint: dissatisfaction, strong frustration, service delay complaint, angry customer.
- refund_return: asks for a refund, return, money back, or cancellation dispute.
- damaged_wrong_item: damaged, faulty, wrong, missing, or unusable item.
- legal_report_threat: threatens a report, police, legal action, or regulator complaint.

Do not escalate ordinary pre-sale questions, price questions, order-status enquiries without dissatisfaction, delivery-fee questions, or polite uncertainty about buying.

Return only valid JSON:
{"category":"complaint|refund_return|damaged_wrong_item|legal_report_threat|no_match","confidence":"high|low","reason":"short reason"}
`.trim();
  const data = await openaiFetch(apiKey, "/responses", {
    method: "POST",
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content: [{ type: "input_text", text: `Customer message: ${customerMessage}` }] },
      ],
    }),
  });
  try {
    const parsed = JSON.parse(extractOutputText(data));
    const category = String(parsed.category || "").trim();
    if (
      String(parsed.confidence || "").trim() !== "high" ||
      !["complaint", "refund_return", "damaged_wrong_item", "legal_report_threat"].includes(category)
    ) {
      return null;
    }
    return { category, reason: String(parsed.reason || "").trim() };
  } catch {
    return null;
  }
}

function extractOutputText(response) {
  if (response.output_text) return response.output_text;

  const chunks = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

function parseAgentJson(text) {
  try {
    const parsed = JSON.parse(text);
    return {
      reply: String(parsed.reply || "").trim(),
      replyType: normalizeReplyType(parsed.reply_type),
      buyingIntent: normalizeBuyingIntent(parsed.buying_intent),
      buyingIntentReason: String(parsed.buying_intent_reason || "").trim(),
      handoffRequired: Boolean(parsed.handoff_required),
      handoffReason: String(parsed.handoff_reason || "").trim(),
      raw: text,
    };
  } catch {
    return {
      reply: "Terima kasih kita. Saya akan minta team check dan reply kita sekejap lagi.",
      replyType: "other",
      buyingIntent: "unclear",
      buyingIntentReason: "Model returned non-JSON output.",
      handoffRequired: true,
      handoffReason: "Model returned non-JSON output.",
      raw: text,
    };
  }
}

function normalizeBuyingIntent(value) {
  const intent = String(value || "").trim().toLowerCase();
  return ["buying", "not_buying", "unclear"].includes(intent) ? intent : "unclear";
}

function normalizeReplyType(value) {
  return String(value || "").trim().toLowerCase() === "faq" ? "faq" : "other";
}
