# Knowledge reply cleanup

`lib/knowledge_reply.mjs` replaces whole-sentence deletion with removal of recognised source introductions. English and Malay source prefixes are removed while the supported factual clause remains. Refund wording such as “claim within 30 days” is retained. The pre-existing rapid blackhead-result exclusion remains.

Unrecognised internal-source wording or an empty reply triggers one generation retry using the same selected knowledge. The normal answer prompt is unchanged; a recovery instruction applies only to that retry. There is no second search, wider retrieval, threshold change or additional knowledge source. Valid replies do not incur a retry.

If generation is still unusable, retrieval has no usable winner, or the RAG path errors, a short English/Malay customer-facing acknowledgement enters the existing handoff plan. Existing complaint/order/sales handoff behaviour outside this RAG path is not changed.

Cleanup diagnostics use the existing audit log, bounded to 2,000 characters each for the generated reply and cleaned reply. Empty parsed replies also record bounded raw model output. No request headers, credentials or complete knowledge documents are logged.

The shared cleaner is also used by the existing sales-education path, which retains its original approved-reply fallback. No database schema, background service, transport or account setting changes are required.
