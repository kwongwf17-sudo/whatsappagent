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

test("submitted order detection remains reusable", () => {
  assert.equal(customerHasSubmittedOrder({ orderIds: ["ord_1"] }), true);
  assert.equal(customerHasSubmittedOrder({ status: "order_submitted" }), true);
  assert.equal(customerHasSubmittedOrder({}), false);
});
