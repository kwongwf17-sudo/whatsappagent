export function buildUnhandledHandoffPlan(context = {}) {
  const {
    product = {},
    reason = "No matching sales response, FAQ, or RAG answer.",
    severity = "normal",
  } = context;

  return {
    customerPatch: {
      productId: product.id,
      awaitingPackageBInterest: false,
      handoffStatus: "human_required",
      handoffReason: reason,
      handoffSeverity: severity,
    },
    messages: [],
    handoffRequired: true,
    handoffReason: reason,
    handoffSeverity: severity,
  };
}
