const TOPIC_RULES = [
  {
    name: "price",
    evidence:
      /(?:\bb\$|\$|\bprice\b|\bharga\b|\bpackage\b|\bpakej\b|\bcombo\b|\bdiscount\b|\bdiskaun\b|\bbuy\s*1\b|\bfree\s*1\b|\b\d+\s*unit\s*=|\bharga\s*asal\b)/i,
    unsupported:
      /(?:\bprice\b|\bharga\b|\bpromo(?:si)?\b|\bpackage\b|\bpakej\b|\bcombo\b|\bdiscount\b|\bdiskaun\b|\bbuy\s*1\b|\bfree\s*1\b|\bunit\s*=|\badd[-\s]?on\b)/i,
    categories: new Set(["price", "package_option", "add_on"]),
  },
  {
    name: "delivery",
    evidence:
      /(?:\bcod\b|\bdelivery\b|\bhantar\b|\bpenghantaran\b|\bperhantaran\b|\brunner\b|\bself\s*collect\b|\bpickup\b|\bbarang\s*sampai\s*baru\s*bayar\b)/i,
    unsupported:
      /(?:\bcod\b|\bdelivery\b|\bhantar\b|\bpenghantaran\b|\bperhantaran\b|\brunner\b|\bself\s*collect\b|\bpickup\b|\bbarang\s*sampai\s*baru\s*bayar\b)/i,
    categories: new Set(["delivery"]),
  },
  {
    name: "refund",
    evidence: /(?:\brefund\b|\bwarranty\b|\brosak\b|\breturn\b|\btukar\b|\bguarantee\b)/i,
    unsupported: /(?:\brefund\b|\bwarranty\b|\brosak\b|\breturn\b|\btukar\b|\bguarantee\b)/i,
    categories: new Set(["warranty_refund"]),
  },
];

export function sanitizeImageKnowledgeChunk(chunk) {
  if (!chunk || typeof chunk !== "object") return chunk;
  const sourceText = sourceEvidenceText(chunk);
  const unsupportedRules = TOPIC_RULES.filter((rule) => !hasTopicEvidence(rule, chunk, sourceText));
  if (!unsupportedRules.length) return chunk;
  return {
    ...chunk,
    brunei_malay_summary: sanitizeBruneiMalaySummary(chunk.brunei_malay_summary, unsupportedRules),
    brunei_malay_search_text: sanitizeBruneiMalaySearchText(chunk.brunei_malay_search_text, unsupportedRules),
    brunei_malay_question_examples: sanitizeQuestionExamples(chunk.brunei_malay_question_examples, unsupportedRules),
    question_examples: sanitizeQuestionExamples(chunk.question_examples, unsupportedRules),
  };
}

function sourceEvidenceText(chunk) {
  return [
    chunk.category,
    chunk.title,
    chunk.summary,
    chunk.extracted_text,
    chunk.embedding_text,
    chunk.sourceLabel,
    chunk.sourceFilename,
  ].filter(Boolean).join(" ");
}

function hasTopicEvidence(rule, chunk, sourceText) {
  const category = String(chunk.category || "").toLowerCase();
  return rule.categories.has(category) || rule.evidence.test(sourceText);
}

function sanitizeBruneiMalaySummary(value, unsupportedRules) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !unsupportedRules.some((rule) => rule.unsupported.test(sentence)))
    .join(" ")
    .trim();
}

function sanitizeBruneiMalaySearchText(value, unsupportedRules) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text
    .split(/\s*\|\s*/)
    .map((segment) => segment.trim())
    .filter((segment) => segment && !unsupportedRules.some((rule) => rule.unsupported.test(segment)))
    .join(" | ")
    .trim();
}

function sanitizeQuestionExamples(value, unsupportedRules) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter((item) => item && !unsupportedRules.some((rule) => rule.unsupported.test(item)));
}
