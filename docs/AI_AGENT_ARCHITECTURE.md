# WhatsApp AI Agent Architecture

This document explains the current AI agent process flow, knowledge base structure, retrieval rules, handoff behavior, and continuous-learning loop.

## Main Files

- `server.mjs`
  - HTTP server, WhatsApp webhook, admin dashboard routes, demo routes, manual reply, handoff, product image ingestion, and orchestration.
- `lib/conversation.mjs`
  - Core conversation decision engine: active product resolution, FAQ matching, sales replies, product knowledge matching, order detection, and handoff.
- `lib/retrieval.mjs`
  - Retrieval engine for approved FAQs, sales replies, and product image knowledge. Uses embeddings when available, with token fallback.
- `lib/openai.mjs`
  - OpenAI calls and prompts for image extraction, FAQ matching, sales reply matching, product knowledge selection, and customer-facing answer rewriting.
- `data/product_catalog.json`
  - Product catalog and product-scoped knowledge: products, opening flow, product FAQs, product sales replies, order options, and extracted image knowledge.
- `lib/store.mjs`
  - JSON/SQLite-backed persistence layer for customers, orders, complaints, outbox messages, and audit logs.

## High-Level Flow

```text
Customer WhatsApp message
  -> Save inbound message
  -> Load or create customer
  -> Resolve active product
  -> Handle fixed opening flow if first product/ad message
  -> Handle opt-out, complaint, or order-status guards
  -> Search approved local FAQ
  -> Search approved product image knowledge
  -> Search approved sales replies
  -> Detect order/order form details
  -> If no approved answer, handoff to human
```

Global OpenAI/vector-store RAG is not used for chat answers anymore. General/business FAQs are local-only.

## Active Product Resolution

Every chat is anchored to one active product.

The product is resolved from:

1. `source.productId`, such as a WhatsApp ad/referral or Customer Demo selected product.
2. A product-name-only first message.
3. The stored `customer.productId`.
4. The catalog default product only if no other product context exists.

Once a customer has an active product, that product is treated as a hard boundary. A later message mentioning another product name should not override the stored product unless a new product source is explicitly supplied.

## Opening Flow

For a new product enquiry:

```text
Customer sends product name / ad enquiry
  -> Resolve product
  -> Save customer.productId
  -> Send that product's opening_flow
  -> Skip FAQ/RAG/product knowledge retrieval for this first opening message
```

This keeps the first response fast and prevents product image summaries from being sent before the sales flow.

## Knowledge Base Types

### General FAQ

Target storage:

```text
data/general_faqs.json
```

Used only for business-level questions such as:

- delivery
- location
- payment
- COD
- stock arrival
- pickup/self-collect, if a local FAQ exists

General FAQ is local-only. If no local FAQ matches, the agent hands off.

### Product FAQ

Stored in:

```text
data/product_catalog.json -> products[].approved_faqs
```

Used only for the active product. Product FAQ is best for stable, approved answers such as:

- usage instructions
- side effects
- original/authenticity
- stock rules
- customer reviews/testimonials
- warranty
- result timing
- product-specific policies

Product FAQ does not use global OpenAI RAG. The system may use OpenAI only to select the best approved FAQ record from the active product's local FAQ list. The customer receives the saved approved reply.

### Product Image Knowledge

Stored in:

```text
data/product_catalog.json -> products[].extracted_knowledge.approvedImages
```

Each approved image chunk can contain:

- `summary`
- `extracted_text`
- `embedding_text`
- `brunei_malay_summary`
- `brunei_malay_search_text`
- `question_examples`
- `brunei_malay_question_examples`

Image knowledge is product-scoped. A P08 chat can only retrieve P08 approved image chunks. It cannot retrieve Blackhead Remover chunks.

### OpenAI Vector Store Knowledge

The OpenAI vector store is generated from approved live data only:

- `general-faq.md` from `data/general_faqs.json`
- `product-faq.md` from `data/product_catalog.json -> products[].approved_faqs`
- `product-image-knowledge.md` from `data/product_catalog.json -> products[].extracted_knowledge.approvedImages`

It must not contain sales replies, SOPs, reply flows, or old static markdown files from `knowledge/`.

### Sales Replies

Stored independently in:

```text
data/sales_replies.json
```

Sales replies are for objections or hesitation, not factual product questions.

Each sales reply has a scope:

- `business`: applies across products when intentionally business-wide.
- `product`: applies only to the matching `productId`.

Sales replies are no longer stored under `product_catalog.json`. The product catalog should describe products and product assets, not become a mixed sales-reply database.

## Product Knowledge Retrieval Flow

For product-specific questions:

```text
Customer question
  -> Active product already resolved
  -> Try exact/local approved FAQ and sales reply matching first
  -> If local knowledge cannot answer, use OpenAI file-search RAG
  -> Retrieve only similar chunks from generated vector-store knowledge
  -> OpenAI rewrites the retrieved approved chunk into a customer-facing WhatsApp reply
  -> If no direct chunk exists, handoff to human
```

The agent must not send raw image summaries to customers.

OpenAI is instructed to:

- use only the retrieved approved product knowledge
- rephrase into a natural customer-facing reply
- avoid internal words like `image`, `poster`, `chunk`, `visible text`, `extracted`
- reply in Malay/Brunei style if the customer writes Malay
- handoff if the retrieved knowledge does not directly answer the question

## Brunei-Malay Knowledge Support

When product images are extracted, the system now stores Brunei-Malay customer wording together with the original English knowledge.

Example English image content:

```text
SOFTEN SEBUM | CLEAR PORES | BLACKHEAD EXTRACTION | GENTLE FORMULA
```

Stored Brunei-Malay search wording:

```text
apa fungsi produk ani
untuk apa
kegunaan
bantu lembutkan sebum
bersihkan pori
mudahkan blackhead dibersihkan
kulit sensitif
```

This helps customer questions like:

```text
Apa fungsi produk ani?
Sesuai untuk kulit sensitif kah?
```

retrieve the correct English image chunk.

## General FAQ Flow

For business/general questions:

```text
Customer asks delivery/location/payment/COD/etc.
  -> Search local General FAQ
  -> Search local approved FAQ semantic match
  -> If no local answer, handoff
```

There is no global OpenAI RAG fallback for business/general FAQ.

## Handoff Flow

The agent hands off when:

- no approved FAQ/product knowledge/sales reply matches
- the question asks for missing facts
- the customer complains
- the message is risky or requires human judgment
- the product knowledge is not directly available

The customer receives:

```text
Terima kasih kita. Saya akan minta team check dan reply kita sekejap lagi.
```

The customer is marked:

```text
handoffStatus: "human_required"
```

## Continuous Learning

When a human sends a manual reply from the admin dashboard to a customer in handoff:

```text
Manual human reply
  -> Find latest inbound customer question
  -> Save question + manual answer as approved FAQ
  -> Scope it to active product unless it is a general business question
  -> Persist product_catalog.json
  -> Clear handoff status
  -> Record audit log
```

This turns resolved handoff questions into approved local knowledge for future similar questions.

Learning is conservative:

- It only learns from customers currently marked `human_required`.
- It skips risky/order/complaint-style questions such as address/order forms, refund complaints, damaged goods, and angry complaint messages.
- If learning fails, the manual reply still sends and the learning error is logged separately.

## Order Flow

The agent can detect order details from customer messages.

When the customer submits complete order information:

```text
Customer order details
  -> Parse name, phone, address, package/order option, add-on choice
  -> Create order record
  -> Mark human required for admin processing
  -> Send configured order-submitted customer messages
```

Order records are stored through `store.addOrder`.

## Admin Dashboard

The admin dashboard includes:

- Dashboard summary
- Chat Inbox
- Analytics
- FAQ Library
- Sales Replies
- Product Flow
- Compliance
- Customer Demo
- Profile
- Handoff and conversations

Manual replies are sent through:

```text
POST /admin/manual-reply
```

That endpoint also powers the continuous-learning loop.

## Production WABA Notes

For production WhatsApp Business API usage:

- Webhooks enter through `server.mjs`.
- Outbound messages go through Graph API when `DEMO_MODE=false`.
- The app must be hosted on an always-on server.
- SQLite can be used for an early test run, but the server must stay running.
- Approved WhatsApp templates are needed for messages outside the 24-hour customer service window.

## Current Safety Rules

- Product-specific questions cannot use other products' knowledge.
- Global OpenAI RAG is not used for chat answers.
- General FAQ is local-only.
- Product image chunks are active-product-only.
- Raw image summaries should not be sent to customers.
- Missing knowledge leads to handoff, not guessing.
- Manual human answers can become approved local FAQ for future use.


