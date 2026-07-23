import assert from "node:assert/strict";
import test from "node:test";
import {
  ROUTING_PHASE,
  attachRoutingDecision,
  evaluateDecisionRules,
  isRuleEligible,
  validateDecisionRules,
} from "./decision_engine.mjs";

function withoutDurations(trace) {
  return trace.map(({ durationMs, ...item }) => item);
}

test("decision engine returns the first matching rule plan", () => {
  const result = evaluateDecisionRules([
    { name: "miss", category: "knowledge", priority: 10, resolve: () => null },
    { name: "hit", category: "sales", priority: 20, description: "Matched rule", resolve: ({ text }) => ({ messages: [{ type: "text", body: text }] }) },
    { name: "later", resolve: () => ({ messages: [] }) },
  ], { text: "hello" });

  assert.equal(result.rule, "hit");
  assert.equal(result.category, "sales");
  assert.equal(result.priority, 20);
  assert.equal(result.description, "Matched rule");
  assert.deepEqual(result.plan, { messages: [{ type: "text", body: "hello" }] });
  assert.deepEqual(withoutDurations(result.trace), [
    {
      name: "miss",
      category: "knowledge",
      priority: 10,
      phase: 10,
      description: "",
      eligible: true,
      matched: false,
      skippedReason: "",
      errorCode: "",
    },
    {
      name: "hit",
      category: "sales",
      priority: 20,
      phase: 20,
      description: "Matched rule",
      eligible: true,
      matched: true,
      skippedReason: "",
      errorCode: "",
    },
  ]);
  assert.ok(result.trace.every((item) => Number.isFinite(item.durationMs)));
});

test("decision engine returns null plan when no rules match", () => {
  const result = evaluateDecisionRules([{ name: "miss", resolve: () => null }]);
  assert.deepEqual({ ...result, trace: withoutDurations(result.trace) }, {
    rule: "",
    name: "",
    category: "",
    priority: null,
    phase: null,
    description: "",
    plan: null,
    trace: [
      { name: "miss", category: "", priority: null, phase: null, description: "", eligible: true, matched: false, skippedReason: "", errorCode: "" },
    ],
  });
  assert.ok(result.trace[0].durationMs >= 0);
});

test("decision engine ignores invalid rule entries", () => {
  const result = evaluateDecisionRules([
    null,
    { name: "invalid" },
    { name: "hit", resolve: () => ({ handoffRequired: false }) },
  ]);

  assert.deepEqual({ ...result, trace: withoutDurations(result.trace) }, {
    name: "hit",
    rule: "hit",
    category: "",
    priority: null,
    phase: null,
    description: "",
    plan: { handoffRequired: false },
    trace: [
      { name: "hit", category: "", priority: null, phase: null, description: "", eligible: true, matched: true, skippedReason: "", errorCode: "" },
    ],
  });
  assert.ok(result.trace[0].durationMs >= 0);
});

test("decision engine records state-based rule skips", () => {
  const result = evaluateDecisionRules([
    {
      name: "sales",
      category: "sales",
      blockedStates: ["pendingOrder"],
      resolve: () => ({ messages: [{ type: "text", body: "sales" }] }),
    },
    {
      name: "knowledge",
      category: "knowledge",
      resolve: () => ({ messages: [{ type: "text", body: "faq" }] }),
    },
  ], { activeState: "pendingOrder" });

  assert.equal(result.rule, "knowledge");
  assert.deepEqual(withoutDurations(result.trace), [
    {
      name: "sales",
      category: "sales",
      priority: null,
      phase: null,
      description: "",
      eligible: false,
      matched: false,
      skippedReason: "blocked_state:pendingOrder",
      errorCode: "",
    },
    {
      name: "knowledge",
      category: "knowledge",
      priority: null,
      phase: null,
      description: "",
      eligible: true,
      matched: true,
      skippedReason: "",
      errorCode: "",
    },
  ]);
  assert.ok(result.trace.every((item) => item.durationMs >= 0));
});

test("decision engine continues after noncritical rule errors", () => {
  const result = evaluateDecisionRules([
    {
      name: "knowledge_broken",
      category: "knowledge",
      resolve: () => {
        const error = new Error("Vector timeout");
        error.code = "VECTOR_TIMEOUT";
        throw error;
      },
    },
    {
      name: "fallback",
      category: "knowledge",
      resolve: () => ({ messages: [{ type: "text", body: "fallback" }], handoffRequired: false }),
    },
  ]);

  assert.equal(result.rule, "fallback");
  assert.equal(result.trace[0].errorCode, "VECTOR_TIMEOUT");
  assert.equal(result.trace[0].matched, false);
  assert.equal(result.trace[1].matched, true);
});

test("decision engine converts critical rule errors into handoff plans", () => {
  const result = evaluateDecisionRules([
    {
      name: "order",
      category: "order",
      resolve: () => {
        throw new TypeError("Order parser failed");
      },
    },
    {
      name: "later",
      category: "knowledge",
      resolve: () => ({ handoffRequired: false }),
    },
  ], {
    buildErrorHandoffPlan: (_error, metadata) => ({
      messages: [],
      handoffRequired: true,
      handoffReason: `Rule failed: ${metadata.name}`,
    }),
  });

  assert.equal(result.rule, "order");
  assert.equal(result.errorCode, "TypeError");
  assert.equal(result.plan.handoffRequired, true);
  assert.equal(result.plan.handoffReason, "Rule failed: order");
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].errorCode, "TypeError");
});

test("rule eligibility supports allowed and blocked states", () => {
  assert.deepEqual(isRuleEligible({ allowedStates: [""] }, { activeState: "pendingOrder" }), {
    eligible: false,
    skippedReason: "state_not_allowed:pendingOrder",
  });
  assert.deepEqual(isRuleEligible({ blockedStates: ["handoff"] }, { activeState: "handoff" }), {
    eligible: false,
    skippedReason: "blocked_state:handoff",
  });
  assert.deepEqual(isRuleEligible({ allowedStates: ["pendingOrder"] }, { activeState: "pendingOrder" }), {
    eligible: true,
    skippedReason: "",
  });
});

test("routing diagnostics are attached without changing plan behavior", () => {
  const plan = attachRoutingDecision(
    { messages: [], handoffRequired: false },
    {
      rule: "primary_knowledge",
      category: "knowledge",
      priority: ROUTING_PHASE.KNOWLEDGE,
      description: "Answer approved knowledge.",
      trace: [
        { name: "early_sales", category: "sales", priority: ROUTING_PHASE.SALES, phase: ROUTING_PHASE.SALES, eligible: true, matched: false },
        { name: "primary_knowledge", category: "knowledge", priority: ROUTING_PHASE.KNOWLEDGE, phase: ROUTING_PHASE.KNOWLEDGE, eligible: true, matched: true },
      ],
    },
    {
      product: { id: "soil_booster" },
      activeState: "pendingOrder",
      routeClassification: {
        messageType: "general_faq",
        primaryIntent: "delivery_fee",
        confidence: "high",
      },
    }
  );

  assert.deepEqual(plan.messages, []);
  assert.equal(plan.routingDecision.rule, "primary_knowledge");
  assert.equal(plan.routingDecision.category, "knowledge");
  assert.equal(plan.routingDecision.priority, ROUTING_PHASE.KNOWLEDGE);
  assert.equal(plan.routingDecision.phase, ROUTING_PHASE.KNOWLEDGE);
  assert.equal(plan.routingDecision.description, "Answer approved knowledge.");
  assert.equal(plan.routingDecision.productId, "soil_booster");
  assert.equal(plan.routingDecision.messageType, "general_faq");
  assert.equal(plan.routingDecision.primaryIntent, "delivery_fee");
  assert.equal(plan.routingDecision.confidence, "high");
  assert.equal(plan.routingDecision.activeState, "pendingOrder");
  assert.equal(plan.routingDecision.handoffRequired, false);
  assert.deepEqual(plan.routingDecision.trace, [
    { rule: "early_sales", category: "sales", priority: ROUTING_PHASE.SALES, phase: ROUTING_PHASE.SALES, eligible: true, matched: false, durationMs: 0, skippedReason: "", errorCode: "" },
    { rule: "primary_knowledge", category: "knowledge", priority: ROUTING_PHASE.KNOWLEDGE, phase: ROUTING_PHASE.KNOWLEDGE, eligible: true, matched: true, durationMs: 0, skippedReason: "", errorCode: "" },
  ]);
  assert.deepEqual(plan.customerPatch.lastRoutingDecision, plan.routingDecision);
});

test("decision rule validation rejects invalid rule definitions", () => {
  assert.throws(
    () => validateDecisionRules([
      { name: "dup", category: "sales", priority: ROUTING_PHASE.SALES, resolve: () => null },
      { name: "dup", category: "bad", priority: 123 },
    ]),
    /Duplicate decision rule name[\s\S]*missing resolver[\s\S]*invalid category[\s\S]*invalid routing phase/
  );
});

test("decision rule validation accepts named routing phases", () => {
  assert.equal(validateDecisionRules([
    { name: "sales", category: "sales", priority: ROUTING_PHASE.SALES, resolve: () => null },
    { name: "knowledge", category: "knowledge", priority: ROUTING_PHASE.KNOWLEDGE, resolve: () => ({}) },
  ]), true);
});
