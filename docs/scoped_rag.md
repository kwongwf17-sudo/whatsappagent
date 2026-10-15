# Scoped top-three RAG staging change

This branch starts from production commit `db878f7`. Deploy it only to `whatsappagent-staging` until testing is complete; production and its follow-up worker remain on their existing commit.

Both knowledge-answer and sales-education paths use the same strict pipeline:

1. Search the selected account's vector store with `business_account_id` and `knowledge_scope` attribute filters. Product questions and product education also require the active `product_id`. General FAQ queries use the separate general scope. A product question without a resolved product does not search.
2. Request at most three results, using OpenAI's returned search score and `score_threshold: 0.5`. Check the score and metadata again locally, preserve descending search-score order, and never widen the candidate pool or lower the threshold.
3. AI reranks only those candidates and selects one valid retrieved ID. Invalid/empty output or a request failure does not fall back to the first search result.
4. Only the selected record is supplied to answer generation. The generator does not perform another file search. Approved FAQ routing, sales-reply selection, customer matching, follow-up scheduling, deletion and stage history retain their existing entry paths.

Search relevance scores are not calibrated answer-confidence percentages. No separate minimum reranker score is applied; the specified 0.5 cutoff applies to the initial search results.

The ingester writes separate files for each product and knowledge type, with account/product/scope attributes. General FAQs are stored separately. `knowledge-manifest.json` records file attributes and is not itself indexed. Manual `--knowledge-dir` uploads must include a valid manifest; mixed-product files cannot be assigned one product's metadata.

Use `node ingest_knowledge.mjs --account-id demo --new-store` to build an isolated knowledge store and switch the staging demo account only after all uploaded files finish indexing. Existing stores are not cleared by this option. Normal ingestion still follows its existing replace/append behavior; all accounts must be re-indexed with scoped metadata before this retrieval change is enabled for them. Earlier production files contain product IDs in their text rather than metadata and are not compatible with strict prefiltering.

The staging demo copy of SHAWN PY1 includes the original opening blocks, product FAQs, order options, approved image knowledge and six referenced persisted images. Other demo products remain available to test product isolation. Demo conversations use the logged-in demo account's content and knowledge settings while storing test customers under the existing `__demo__` namespace.

Diagnostics: `/health` reports the source commit and retrieval policy; `approved_knowledge_rag_selection` audit entries show scope, qualifying candidate IDs/scores and the winner without storing the retrieved document text.

## Routing corrections

The existing classifier now receives each active FAQ's scope and an approved-answer excerpt capped at 240 characters. Its output schema is unchanged. Instructions distinguish product packaging/guarantee information from business delivery policies and actual after-sales action requests. The separate complaint classifier uses the same distinction.

The immediate refund guard requires a clear action request instead of the refund/return noun alone. Other messages continue through the existing classifier and complaint fallback. The delivery guard requires delivery evidence and a change/availability request; recent team delivery context can resolve short replies, and a known order can support a home-availability message. A pending purchase alone does not establish delivery context. Time words plus generic negation are insufficient.

These corrections do not add model calls, alter conversation-planner inputs, change the RAG candidate/threshold/source limits, change storage schemas, or modify customer journeys and follow-up scheduling. The extra FAQ excerpts modestly increase the existing classifier's input tokens. Language consistency and silent empty-result handoffs are separate remaining issues.
