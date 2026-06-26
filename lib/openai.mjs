import { readFile } from "node:fs/promises";
import path from "node:path";
import { sanitizeImageKnowledgeChunk } from "./knowledge_sanitizer.mjs";

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
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      const preview = text.replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`OpenAI ${endpoint} returned non-JSON response: ${preview}`);
    }
  }
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

export async function listVectorStoreFiles(apiKey, vectorStoreId) {
  const files = [];
  let after = "";
  do {
    const query = new URLSearchParams({ limit: "100" });
    if (after) query.set("after", after);
    const data = await openaiFetch(apiKey, `/vector_stores/${vectorStoreId}/files?${query.toString()}`);
    const batch = Array.isArray(data.data) ? data.data : [];
    files.push(...batch);
    after = data.has_more && batch.length ? batch.at(-1).id : "";
  } while (after);
  return files;
}

export async function deleteVectorStoreFile(apiKey, vectorStoreId, fileId) {
  return openaiFetch(apiKey, `/vector_stores/${vectorStoreId}/files/${fileId}`, {
    method: "DELETE",
  });
}

export async function deleteUploadedFile(apiKey, fileId) {
  return openaiFetch(apiKey, `/files/${fileId}`, {
    method: "DELETE",
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
You are a WhatsApp customer service agent for ${businessName}, serving Brunei customers.
You are fluent in English and Brunei-Malay.

Reply in the same language as the customer. Use natural Brunei-Malay when the customer writes Malay.
Reply like a human: understand the customer's emotion and intent first, then answer warmly and naturally.
Keep WhatsApp replies concise, clear, and easy to scan.

Use only approved knowledge provided by the system:
- local approved FAQ replies that the application has already checked before this call
- local approved sales replies that the application has already checked before this call
- OpenAI vector-store knowledge containing approved general FAQ, approved product FAQ, and approved extracted product image knowledge

Strict source rules:
- Use file_search as the source of truth for approved embedded vector-store knowledge.
- Use only information found by file_search or explicitly present in the provided customer message.
- Do not invent answers.
- Do not use world knowledge.
- Do not answer from SOP, reply flows, sales scripts, generic SOPs, or unapproved notes.
- Do not answer from assumptions, likely/common product behavior, similar products, marketing guesses, or partial context.
- Active product context: ${productName || "unknown product"}${productId ? ` (${productId})` : ""}.
- Do not answer product-specific details for any product other than the active product.
- If the customer asks product-specific details and file_search returns only another product's information, set handoff_required to true.
- For product answers, rephrase the approved knowledge into a short human WhatsApp reply.
- Do not mention vector store, file_search, file search, image chunk, retrieved chunk, extracted text, visible text, source, or internal system wording.
- Classify buying intention from meaning and context, not by matching isolated product or package words.
- Set buying_intent to "buying" only when the customer clearly commits to order, reserve, lock, or proceed with a purchase, or is submitting order details.
- Set buying_intent to "not_buying" for questions about price, packages, product information, availability, delivery, or comparisons without a commitment to purchase.
- Set buying_intent to "unclear" when purchase commitment cannot be determined confidently.
- Set reply_type to "faq" when answering a product or general business information question from the knowledge base.
- Set reply_type to "other" for non-FAQ replies, clarification questions, complaints, or human-review responses.
- Do not add a sales question after an FAQ answer; the application sends the approved sales follow-up separately.
- Do not invent prices, stock, shipping timelines, refund eligibility, ingredients, warranty terms, or policy details.
- If the knowledge base does not directly answer the question, do not guess. Set handoff_required to true, reply_type to "other", buying_intent to "unclear", and use a short reply like "Terima kasih kita. Saya akan minta team check dan reply kita sekejap lagi."
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
- Do not use product catalog knowledge, other images, brand knowledge, common sense, or likely customer questions to fill missing details.
- Preserve the meaning of the image, but avoid turning marketing text into stronger claims.
- Do not create medical, cure, guaranteed-result, or permanent-result claims.
- Create exactly one image_chunk that summarizes the whole image as a searchable knowledge source.
- The image_chunk must stay grounded to this image only and should mention visible headings, sections, and important text.
- If the image/file label includes words like benefit, feature, price, ingredient, usage, warning, testimonial, use that clue for image_chunk.category only when it matches the visible image content.
- Use a precise category for image_chunk.category:
  specification, ingredient, usage, price, package_option, add_on, feature, benefit_claim, problem_shown, caution, delivery, warranty_refund, stock_timeline, social_proof, other
- Use "benefit_claim" only for marketing benefits written or clearly shown in the image.
- Use "problem_shown" for before-side or problem labels like blackheads, oily T-zone, clogged pores.
- Use "feature" for product capabilities like suction modes, heads, rechargeable, button.
- Use "specification" for measurable facts like volume, size, quantity, material, battery, power.
- Do not create separate fact rows. Put all useful visible content inside image_chunk.summary, image_chunk.extracted_text, and image_chunk.embedding_text.

English fields:
- summary: customer-safe English summary of only visible image content.
- extracted_text: important visible text copied from the image.
- embedding_text: searchable English text using only the product name, image label, category, summary, and visible text.

Brunei-Malay fields:
- brunei_malay_summary: strict Brunei-Malay translation or very light paraphrase of summary + extracted_text only.
- brunei_malay_search_text: Brunei-Malay equivalents of words/facts already present in summary, extracted_text, or embedding_text only.
- Use natural Brunei-Malay wording where possible. Keep English only for brand names, prices, model names, units, exact visible product terms, or words Brunei customers normally use as-is.

Strict grounding rules:
- Do not create broad customer-search keywords, likely FAQ topics, sales keywords, or question examples for image chunks.
- Do not add price, promo, package, discount, COD, delivery, refund, warranty, side-effect, sensitive-skin, review, stock, or origin wording unless that topic is visibly present in the image.
- If a topic is not visible in the image, it must not appear in brunei_malay_summary or brunei_malay_search_text.
- Prefer customer-answerable content over vague words, but keep visible marketing/problem text inside the chunk when it helps retrieval.
- Set customer_safe false when the image content is too risky to answer customers without human review.
- Return only valid JSON:
{"image_chunk":{"category":"feature","title":"Product features","summary":"Short customer-safe English summary","extracted_text":"Important visible text from the image","embedding_text":"Searchable English text combining product, image label, category, summary, and visible text only","brunei_malay_summary":"Strict Brunei-Malay translation/paraphrase of visible image content only","brunei_malay_search_text":"Brunei-Malay equivalents of visible words/facts only","customer_safe":true,"approval_note":"Visible in image"},"facts":[]}
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
  return sanitizeImageKnowledgeChunk({
    category: normalizeExtractionCategory(chunk.category),
    title: title || "Image knowledge",
    summary,
    extracted_text: extractedText,
    embedding_text: embeddingText || [title, summary, extractedText].filter(Boolean).join("\n"),
    brunei_malay_summary: bruneiMalaySummary,
    brunei_malay_search_text: bruneiMalaySearchText,
    customer_safe: chunk.customer_safe !== false,
    approval_note: String(chunk.approval_note || "").trim(),
  });
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
