// Identity evidence is restricted to WhatsApp contact metadata, never message text.
export function identityPhone(value = "") {
  const text = String(value || "").trim();
  if (!/^\+?\d{5,18}(?:@(s\.whatsapp\.net|c\.us))?$/.test(text)) return "";
  return text.replace(/@.*$/, "").replace(/^\+/, "");
}

export function customerIdentity(customerId, source = {}) {
  const id = String(customerId || "").trim();
  const phone = identityPhone(source.phone) || identityPhone(source.senderPn) ||
    identityPhone(source.remoteJidAlt) || identityPhone(source.participantAlt) || identityPhone(id);
  const aliases = new Set([id]);
  if (phone) {
    aliases.add(phone);
    aliases.add(`${phone}@s.whatsapp.net`);
    aliases.add(`${phone}@c.us`);
  }
  // Only accept the LID of the actual chat, not an unrelated participant.
  for (const value of [source.remoteJid, source.linkedId]) {
    if (/^\d+@lid$/.test(String(value || ""))) aliases.add(value);
  }
  return { id, phone, aliases: [...aliases].filter(Boolean) };
}

export function storedCustomerPhone(customer = {}) {
  return identityPhone(customer.phone) || customerIdentity(customer.id, customer.source).phone;
}

export function mergeCustomerState(target, duplicate, now = new Date()) {
  if (!target || !duplicate || target.id === duplicate.id) throw new Error("Two distinct existing customers are required.");
  if (!target.businessAccountId || target.businessAccountId !== duplicate.businessAccountId) throw new Error("Cannot merge customers across business accounts.");
  const phone = storedCustomerPhone(target);
  if (!phone || phone !== storedCustomerPhone(duplicate)) throw new Error("Merge requires the same verified phone number.");
  if (target.productId && duplicate.productId && target.productId !== duplicate.productId) throw new Error("Customers have different products; manual review required.");
  for (const field of ["pendingOrder", "pendingUpsell", "pendingOpeningFlow"]) {
    if (target[field] && duplicate[field] && JSON.stringify(target[field]) !== JSON.stringify(duplicate[field])) {
      throw new Error(`Conflicting ${field}; manual review required.`);
    }
  }
  const earliest = (...values) => values.filter(v => Number.isFinite(Date.parse(v))).sort((a,b) => Date.parse(a)-Date.parse(b))[0] || "";
  const latest = (...values) => values.filter(v => Number.isFinite(Date.parse(v))).sort((a,b) => Date.parse(b)-Date.parse(a))[0] || "";
  const followupsSent = { ...target.followupsSent };
  for (const [key, at] of Object.entries(duplicate.followupsSent || {})) followupsSent[key] = earliest(followupsSent[key], at);
  const openingFlowsSent = { ...duplicate.openingFlowsSent, ...target.openingFlowsSent };
  for (const key of Object.keys(openingFlowsSent)) {
    const a=target.openingFlowsSent?.[key], b=duplicate.openingFlowsSent?.[key];
    openingFlowsSent[key] = { ...(b || {}), ...(a || {}), sentAt: earliest(a?.sentAt,b?.sentAt) };
  }
  const merged = {
    ...duplicate, ...target, id: target.id, phone,
    firstSeenAt: earliest(target.firstSeenAt, duplicate.firstSeenAt),
    lastMessageAt: latest(target.lastMessageAt,duplicate.lastMessageAt),
    lastInboundAt: latest(Number(target.inboundCount || 0)>0 ? target.lastInboundAt : '',Number(duplicate.inboundCount || 0)>0 ? duplicate.lastInboundAt : ''),
    openingFlowSentAt: earliest(target.openingFlowSentAt,duplicate.openingFlowSentAt),
    followupsSent, openingFlowsSent,
    orderIds: [...new Set([...(target.orderIds || []),...(duplicate.orderIds || [])])],
    inboundCount: Number(target.inboundCount || 0) + Number(duplicate.inboundCount || 0),
    optedOut: Boolean(target.optedOut || duplicate.optedOut),
    followupBlocked: Boolean(target.followupBlocked || duplicate.followupBlocked || target.optedOut || duplicate.optedOut),
    followupBlockedReason: target.optedOut || duplicate.optedOut ? "opted_out" : target.followupBlockedReason || duplicate.followupBlockedReason || "",
    identityAliases: [...new Set([...(target.identityAliases || []),...(duplicate.identityAliases || []),target.id,duplicate.id])],
    version: Math.max(Number(target.version || 0),Number(duplicate.version || 0)) + 1,
    updatedAt: now.toISOString(),
    identityMergedAt: now.toISOString(),
  };
  for (const field of ["done", "salesConversationClosed"]) merged[field] = Boolean(target[field] || duplicate[field]);
  for (const field of ["pendingOrder","pendingUpsell","pendingOpeningFlow"]) merged[field] = target[field] || duplicate[field] || null;
  const handoff = [target,duplicate].find(c => c.handoffStatus === "human_required" || c.humanRequired);
  if (handoff) {
    merged.handoffStatus = "human_required";
    merged.humanRequired = true;
    merged.handoffReason = handoff.handoffReason || "";
  }
  return merged;
}

// Rewrite references only, keeping message bodies and original transport evidence intact.
export function rekeyCustomerReferences(value, accountId, oldId, newId, inheritedAccount = "") {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(v => rekeyCustomerReferences(v,accountId,oldId,newId,inheritedAccount));
  const scope = value.businessAccountId || value.accountId || inheritedAccount;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = scope === accountId && ["customerId","from","to"].includes(key) && item === oldId
      ? newId : key === "source" || key === "leadSource" ? item : rekeyCustomerReferences(item,accountId,oldId,newId,scope);
  }
  return result;
}
