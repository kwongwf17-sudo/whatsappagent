const TOPIC_RULES = [
  {
    name: "price",
    evidence:
      /(?:\bb\$|\$|\bprice\b|\bharga\b|\bpackage\b|\bpakej\b|\bcombo\b|\bdiscount\b|\bdiskaun\b|\bbuy\s*1\b|\bfree\s*1\b|\b\d+\s*unit\s*=|\bharga\s*asal\b)/i,
    unsupported:
      /(?:\bprice\b|\bharga\b|\bpromo(?:si)?\b|\bpackage\b|\bpakej\b|\bcombo\b|\bdiscount\b|\bdiskaun\b|\bbuy\s*1\b|\bfree\s*1\b|\bunit\s*=|\badd[-\s]?on\b)/i,
    categories: new Set([]),
  },
  {
    name: "generic_function_question",
    evidence: /(?:\bfunction\b|\bfunctions\b|\bfungsi\b|\bbenefit\b|\bbenefits\b|\bkey\s*functions\b|\bwhy\s*choose\b)/i,
    unsupported: /(?:\bapa\s*fungsi\b|\buntuk\s*apa\b|\bkegunaan\b|\bbenefit\b|\bmanfaat\b|\bbuleh\s*bantu\s*apa\b|\bproduk\s*ani\b)/i,
    categories: new Set([]),
  },
  {
    name: "suction",
    evidence: /(?:\bsuction\b|\bsedut\b|\bsedutan\b|\bKPA\b|\bdeep\s*pore\s*suction\b)/i,
    unsupported: /(?:\bsuction\b|\bsedut\b|\bsedutan\b|\bKPA\b)/i,
    categories: new Set([]),
  },
  {
    name: "mode",
    evidence: /(?:\bmode\b|\bmodes\b|\bnormal\b|\bintermediate\b|\bstrong\b|\bintensity\b|\blevel\b)/i,
    unsupported: /(?:\bmode\b|\bmodes\b|\bnormal\b|\bintermediate\b|\bstrong\b|\bintensity\b|\blevel\b)/i,
    categories: new Set([]),
  },
  {
    name: "head",
    evidence: /(?:\bhead\b|\bheads\b|\bprobe\b|\bkepala\b|\blarge\s*round\b|\bsmall\s*round\b|\boval\b)/i,
    unsupported: /(?:\bhead\b|\bheads\b|\bprobe\b|\bkepala\b)/i,
    categories: new Set([]),
  },
  {
    name: "charging",
    evidence: /(?:\bUSB\b|\brecharge(?:able)?\b|\bcharging\b|\bbattery\b|\bcas\b)/i,
    unsupported: /(?:\bUSB\b|\brecharge(?:able)?\b|\bcharging\b|\bbattery\b|\bcas\b)/i,
    categories: new Set([]),
  },
  {
    name: "button",
    evidence: /(?:\bbutton\b|\bbutang\b|\blong\s*press\b|\bshort\s*press\b|\bpower\s*on\b|\bpower\s*off\b)/i,
    unsupported: /(?:\bbutton\b|\bbutang\b|\blong\s*press\b|\bshort\s*press\b|\bpower\s*on\b|\bpower\s*off\b)/i,
    categories: new Set([]),
  },
  {
    name: "delivery",
    evidence:
      /(?:\bcod\b|\bdelivery\b|\bhantar\b|\bpenghantaran\b|\bperhantaran\b|\brunner\b|\bself\s*collect\b|\bpickup\b|\bbarang\s*sampai\s*baru\s*bayar\b)/i,
    unsupported:
      /(?:\bcod\b|\bdelivery\b|\bhantar\b|\bpenghantaran\b|\bperhantaran\b|\brunner\b|\bself\s*collect\b|\bpickup\b|\bbarang\s*sampai\s*baru\s*bayar\b)/i,
    categories: new Set([]),
  },
  {
    name: "refund",
    evidence: /(?:\brefund\b|\bwarranty\b|\brosak\b|\breturn\b|\btukar\b|\bguarantee\b)/i,
    unsupported: /(?:\brefund\b|\bwarranty\b|\brosak\b|\breturn\b|\btukar\b|\bguarantee\b)/i,
    categories: new Set([]),
  },
  {
    name: "sensitive",
    evidence: /(?:\bsensitive\b|\bsensitif\b|\bgentle\b|\bsafe\s*for\s*all\s*skin\s*types\b|\bkulit\s*sensitif\b)/i,
    unsupported: /(?:\bsensitive\b|\bsensitif\b|\bgentle\b|\bkulit\s*sensitif\b|\bsuitable\s*for\s*sensitive\s*skin\b)/i,
    categories: new Set([]),
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
