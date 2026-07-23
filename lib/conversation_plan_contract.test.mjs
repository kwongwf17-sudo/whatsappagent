import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConversationPlan } from "./conversation_plan_contract.mjs";

test("conversation plan contract supplies standard defaults", () => {
  assert.deepEqual(normalizeConversationPlan({ messages: [] }), {
    customerPatch: {},
    messages: [],
    handoffRequired: false,
    handoffReason: "",
  });
});

test("conversation plan contract validates message shapes", () => {
  assert.throws(
    () => normalizeConversationPlan({ messages: [{ type: "text", body: "" }] }),
    /requires body/
  );
  assert.throws(
    () => normalizeConversationPlan({ messages: [{ type: "image" }] }),
    /requires url/
  );
  assert.throws(
    () => normalizeConversationPlan({ messages: [{ type: "unknown", body: "hi" }] }),
    /invalid type/
  );
});

test("conversation plan contract validates patch and handoff shape", () => {
  assert.throws(
    () => normalizeConversationPlan({ customerPatch: [], messages: [] }),
    /customerPatch/
  );
  assert.throws(
    () => normalizeConversationPlan({ messages: [], handoffRequired: true }),
    /handoff requires/
  );
});

test("conversation plan contract accepts handoff with admin message", () => {
  const plan = normalizeConversationPlan({
    messages: [],
    adminMessage: "Order submitted.",
    handoffRequired: true,
  });

  assert.equal(plan.handoffRequired, true);
  assert.equal(plan.handoffReason, "");
  assert.equal(plan.adminMessage, "Order submitted.");
});
