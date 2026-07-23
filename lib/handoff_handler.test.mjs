import assert from "node:assert/strict";
import test from "node:test";
import { buildUnhandledHandoffPlan } from "./handoff_handler.mjs";

test("unhandled handoff plan marks customer for human review", () => {
  assert.deepEqual(buildUnhandledHandoffPlan({ product: { id: "soil_booster" } }), {
    customerPatch: {
      productId: "soil_booster",
      awaitingPackageBInterest: false,
      handoffStatus: "human_required",
      handoffReason: "No matching sales response, FAQ, or RAG answer.",
      handoffSeverity: "normal",
    },
    messages: [],
    handoffRequired: true,
    handoffReason: "No matching sales response, FAQ, or RAG answer.",
    handoffSeverity: "normal",
  });
});

test("unhandled handoff plan supports severity", () => {
  const plan = buildUnhandledHandoffPlan({
    product: { id: "soil_booster" },
    reason: "Routing rule failed: order.",
    severity: "high",
  });

  assert.equal(plan.handoffSeverity, "high");
  assert.equal(plan.customerPatch.handoffSeverity, "high");
});
