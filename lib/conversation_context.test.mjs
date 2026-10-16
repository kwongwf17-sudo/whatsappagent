import assert from "node:assert/strict";
import test from "node:test";
import { customerConversationContext, formatConversationContext } from "./conversation_context.mjs";

test("customer context includes retained bot questions and manual replies but excludes internal and cross-account messages", () => {
  const base = { businessAccountId: "A", to: "c", direction: "outbound", createdAt: "2026-10-16T00:00:00Z" };
  const context = customerConversationContext([
    { ...base, from: "ai_agent", body: "Kita tunggu gaji kah?" },
    { ...base, channel: "business_admin", body: "Mahu proceed?" },
    { ...base, channel: "admin", body: "Internal alert" },
    { ...base, channel: "business_admin", to: "admin", body: "Private admin" },
    { ...base, businessAccountId: "B", channel: "customer", body: "Other account" },
    { ...base, to: "other", channel: "customer", body: "Other customer" },
    { ...base, from: "c", to: "agent", direction: "inbound", channel: "customer", body: "Awu" },
  ], "c", "A");
  assert.deepEqual(context.map(m => [m.role, m.direction, m.text]), [
    ["agent", "outbound", "Kita tunggu gaji kah?"],
    ["agent", "outbound", "Mahu proceed?"],
    ["customer", "inbound", "Awu"],
  ]);
  assert.equal(formatConversationContext(context), "agent: Kita tunggu gaji kah?\nagent: Mahu proceed?\ncustomer: Awu");
});

test("context formatter preserves either existing roles or inbound/outbound directions", () => {
  assert.equal(formatConversationContext([
    { role: "agent", text: "Mahu order?" }, { direction: "inbound", body: "Buleh" },
  ]), "agent: Mahu order?\ncustomer: Buleh");
});
