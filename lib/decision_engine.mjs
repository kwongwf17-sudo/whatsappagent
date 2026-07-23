export const ROUTING_PHASE = Object.freeze({
  COMPLIANCE: 100,
  RESTRICTED_STATE: 200,
  ACTIVE_ORDER: 300,
  ACKNOWLEDGEMENT: 400,
  KNOWLEDGE: 500,
  SALES: 600,
  CLARIFICATION: 800,
  FALLBACK: 900,
});

const VALID_RULE_CATEGORIES = new Set([
  "compliance",
  "restricted_state",
  "order",
  "closing",
  "knowledge",
  "sales",
  "clarification",
  "handoff",
]);

export function evaluateDecisionRules(rules = [], context = {}) {
  const trace = [];
  for (const rule of rules) {
    if (!rule || typeof rule.resolve !== "function") continue;
    const metadata = decisionRuleMetadata(rule);
    const startedAt = Date.now();
    const eligibility = isRuleEligible(rule, context);
    if (!eligibility.eligible) {
      trace.push({
        ...metadata,
        eligible: false,
        matched: false,
        durationMs: Date.now() - startedAt,
        skippedReason: eligibility.skippedReason,
        errorCode: "",
      });
      continue;
    }

    try {
      const plan = rule.resolve(context);
      trace.push({
        ...metadata,
        eligible: true,
        matched: Boolean(plan),
        durationMs: Date.now() - startedAt,
        skippedReason: "",
        errorCode: "",
      });
      if (plan) {
        return {
          ...metadata,
          rule: metadata.name,
          plan,
          trace,
        };
      }
    } catch (error) {
      const errorCode = normalizeRuleErrorCode(error);
      trace.push({
        ...metadata,
        eligible: true,
        matched: false,
        durationMs: Date.now() - startedAt,
        skippedReason: "",
        errorCode,
      });
      if (!shouldContinueAfterRuleError(rule)) {
        return {
          ...metadata,
          rule: metadata.name,
          plan: typeof context.buildErrorHandoffPlan === "function"
            ? context.buildErrorHandoffPlan(error, metadata)
            : null,
          trace,
          errorCode,
        };
      }
    }
  }
  return {
    rule: "",
    name: "",
    category: "",
    priority: null,
    phase: null,
    description: "",
    plan: null,
    trace,
  };
}

export function validateDecisionRules(rules = []) {
  const errors = [];
  const names = new Set();

  for (const [index, rule] of rules.entries()) {
    const label = rule?.name || `rule[${index}]`;
    if (!rule || typeof rule !== "object") {
      errors.push(`${label} must be an object.`);
      continue;
    }
    if (!rule.name) {
      errors.push(`${label} is missing name.`);
    } else if (names.has(rule.name)) {
      errors.push(`Duplicate decision rule name: ${rule.name}.`);
    } else {
      names.add(rule.name);
    }
    if (typeof rule.resolve !== "function") {
      errors.push(`${label} is missing resolver.`);
    }
    if (!VALID_RULE_CATEGORIES.has(String(rule.category || ""))) {
      errors.push(`${label} has invalid category.`);
    }
    if (!Object.values(ROUTING_PHASE).includes(rule.priority)) {
      errors.push(`${label} has invalid routing phase.`);
    }
  }

  if (errors.length) {
    throw new Error(`Invalid decision rules:\n${errors.map((item) => `- ${item}`).join("\n")}`);
  }

  return true;
}

export function attachRoutingDecision(plan = null, decision = {}, context = {}) {
  if (!plan) return plan;
  const routingDecision = {
    rule: decision.rule || "handoff",
    category: String(decision.category || "handoff"),
    priority: Number.isFinite(decision.priority) ? decision.priority : null,
    phase: Number.isFinite(decision.phase)
      ? decision.phase
      : (Number.isFinite(decision.priority) ? decision.priority : null),
    description: String(decision.description || ""),
    errorCode: String(decision.errorCode || ""),
    messageType: String(context.routeClassification?.messageType || ""),
    primaryIntent: String(context.routeClassification?.primaryIntent || ""),
    confidence: String(context.routeClassification?.confidence || ""),
    activeState: String(context.activeState || ""),
    productId: String(context.product?.id || ""),
    handoffRequired: Boolean(plan.handoffRequired),
    trace: compactDecisionTrace(decision.trace),
  };
  return {
    ...plan,
    customerPatch: {
      ...(plan.customerPatch || {}),
      lastRoutingDecision: routingDecision,
    },
    routingDecision,
  };
}

export function isRuleEligible(rule = {}, context = {}) {
  const activeState = String(context.activeState || "");
  const allowedStates = Array.isArray(rule.allowedStates) ? rule.allowedStates.map(String) : null;
  const blockedStates = Array.isArray(rule.blockedStates) ? rule.blockedStates.map(String) : [];

  if (blockedStates.includes(activeState)) {
    return {
      eligible: false,
      skippedReason: `blocked_state:${activeState || "idle"}`,
    };
  }

  if (allowedStates && !allowedStates.includes(activeState)) {
    return {
      eligible: false,
      skippedReason: `state_not_allowed:${activeState || "idle"}`,
    };
  }

  return {
    eligible: true,
    skippedReason: "",
  };
}

function decisionRuleMetadata(rule = {}) {
  const priority = Number.isFinite(rule.priority) ? rule.priority : null;
  return {
    name: String(rule.name || ""),
    category: String(rule.category || ""),
    priority,
    phase: Number.isFinite(rule.phase) ? rule.phase : priority,
    description: String(rule.description || ""),
  };
}

function compactDecisionTrace(trace = []) {
  return Array.isArray(trace)
    ? trace.map((item) => ({
        rule: String(item.name || item.rule || ""),
        category: String(item.category || ""),
        priority: Number.isFinite(item.priority) ? item.priority : null,
        phase: Number.isFinite(item.phase) ? item.phase : null,
        eligible: item.eligible !== false,
        matched: Boolean(item.matched),
        durationMs: Number.isFinite(item.durationMs) ? item.durationMs : 0,
        skippedReason: String(item.skippedReason || ""),
        errorCode: String(item.errorCode || ""),
      }))
    : [];
}

function normalizeRuleErrorCode(error) {
  return String(error?.code || error?.name || "RULE_EXCEPTION").trim() || "RULE_EXCEPTION";
}

function shouldContinueAfterRuleError(rule = {}) {
  if (rule.errorStrategy === "continue") return true;
  if (rule.errorStrategy === "handoff" || rule.errorStrategy === "stop") return false;
  return ["knowledge", "sales", "closing", "clarification"].includes(String(rule.category || ""));
}
