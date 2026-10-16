// Remove source introductions, never the factual sentence that follows them.
export function sanitizeProductKnowledgeReply(reply) {
  const text = String(reply || "").trim()
    .replace(/\b(?:according to|based on|as (?:shown|stated|mentioned) in)\s+(?:the\s+)?(?:provided\s+|approved\s+)?(?:promotional\s+)?(?:poster|image|source|knowledge(?: base)?|extracted text|retrieved (?:text|chunk))\s*[, :]\s*/gi, "")
    .replace(/\b(?:the\s+)?(?:promotional\s+)?(?:poster|image|source|visible text|extracted text|retrieved (?:text|chunk))\s+(?:says?|shows?|states?|mentions?|indicates?|confirms?)\s+(?:that\s+)?/gi, "")
    .replace(/\b(?:dalam|menurut|mengikut|kalau ikut)\s+(?:poster(?: promo)?|imej|gambar|sumber)\s*[, :]\s*/gi, "")
    .replace(/\b(?:poster(?: promo)?|imej|gambar|sumber)\s+(?:tunjuk|menyatakan|menunjukkan|kata)\s+/gi, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map(sentence => sentence.trim())
    .filter(Boolean)
    // Preserve the pre-existing unsupported rapid-result exclusion.
    .filter(sentence => !/\bblackheads?\s*out\s*in\s*5\s*minutes?\b/i.test(sentence))
    .join(" ").trim();
  // An unfamiliar source phrase needs regeneration, not sentence deletion.
  return /\b(poster|promotional image|visible text|extracted(?: text)?|retrieved chunk|vector[ -]store|file[ _-]search|chunk|knowledge base|approved (?:info(?:rmation)?|knowledge|context)|provided (?:info(?:rmation)?|knowledge|context))\b/i.test(text) ? "" : text;
}

export function knowledgeHandoffAnswer(message = "") {
  const malay = /\b(kah|kita|ani|bah|berapa|buleh|boleh|barang|aku|saya|nda|inda|bahannya|untuk)\b/i.test(message);
  return {
    reply: malay ? "Saya forward ke team untuk semak perkara ani ya." : "I'll pass this to our team to check.",
    replyType: "other", handoffRequired: true, handoffReason: "No usable approved knowledge answer.",
    allowProductSpecific: true,
  };
}

export async function resolveKnowledgeReply({ generate, fallback, onDiagnostic = async () => {} }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let answer;
    try { answer = await generate({ repair: attempt > 0 }); }
    catch (error) {
      await onDiagnostic({ attempt: attempt + 1, error: String(error.message || error).slice(0, 500) }).catch(() => {});
      continue;
    }
    const rawReply = String(answer?.reply || "").trim();
    const cleanedReply = sanitizeProductKnowledgeReply(rawReply);
    if (!cleanedReply || rawReply !== cleanedReply) {
      await onDiagnostic({ attempt: attempt + 1, rawReply: rawReply.slice(0, 2000),
        rawModelOutput: !rawReply ? String(answer?.raw || "").slice(0, 2000) : undefined,
        cleanedReply: cleanedReply.slice(0, 2000) }).catch(() => {});
    }
    if (cleanedReply) return { ...answer, reply: cleanedReply };
  }
  return fallback;
}
