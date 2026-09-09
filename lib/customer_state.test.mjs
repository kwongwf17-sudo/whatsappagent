import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationActiveState,
  customerHasSubmittedOrder,
  deriveCustomerState,
} from "./customer_state.mjs";

test("customer state separates pending order from active state", () => {
  const state = deriveCustomerState({
    pendingOrder: { productId: "soil_booster" },
    openingFlowsSent: { soil_booster: "2026-07-23T00:00:00.000Z" },
  });

  assert.equal(state.activeState, "pendingOrder");
  assert.equal(state.orderState, "pending");
  assert.equal(state.salesState, "");
  assert.equal(state.openingFlowHistory.soil_booster, "2026-07-23T00:00:00.000Z");
});

test("customer state separates pending upsell from pending order", () => {
  const state = deriveCustomerState({
    pendingUpsell: {
      productId: "soil_booster",
      originalOrderDraft: { orderOptionName: "Package A" },
    },
  });

  assert.equal(state.orderState, "pending_upsell");
  assert.equal(state.activeState, "pendingUpsell");
});

test("customer state separates sales closed state", () => {
  const state = deriveCustomerState({
    salesConversationClosed: true,
    salesStatus: "sales_closed",
    followupBlockedReason: "sales_conversation_closed",
  });

  assert.equal(state.activeState, "salesClosed");
  assert.equal(state.salesState, "sales_closed");
  assert.equal(state.followupState, "sales_conversation_closed");
});

test("customer state preserves existing active state helper behavior", () => {
  assert.equal(conversationActiveState({ handoffStatus: "human_required" }), "handoff");
  assert.equal(conversationActiveState({ complaintStatus: "open" }), "complaint");
  assert.equal(conversationActiveState({ optedOut: true }), "optedOut");
  assert.equal(conversationActiveState({ awaitingPackageBInterest: true }), "awaitingPackageInterest");
});

test("submitted order state wins over admin-processing handoff marker", () => {
  const state = deriveCustomerState({
    status: "order_submitted",
    followupBlockedReason: "order_submitted",
    handoffStatus: "human_required",
    handoffReason: "Customer submitted complete order details.",
    orderIds: ["ord_1"],
  });

  assert.equal(state.activeState, "submittedOrder");
  assert.equal(state.orderState, "submitted");
  assert.equal(state.handoffState, "");
});

test("true handoff states still win when submitted customer needs human help", () => {
  assert.equal(conversationActiveState({
    status: "order_submitted",
    orderIds: ["ord_1"],
    complaintStatus: "open",
  }), "complaint");

  assert.equal(conversationActiveState({
    status: "order_submitted",
    orderIds: ["ord_1"],
    handoffStatus: "human_required",
    handoffReason: "Order lookup needs admin check.",
  }), "handoff");
});

test("submitted order detection remains reusable", () => {
  assert.equal(customerHasSubmittedOrder({ orderIds: ["ord_1"] }), true);
  assert.equal(customerHasSubmittedOrder({ status: "order_submitted" }), true);
  assert.equal(customerHasSubmittedOrder({}), false);
});
