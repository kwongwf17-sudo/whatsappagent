import assert from "node:assert/strict";
import test from "node:test";

import { buildOrderDraftPlan } from "./order_handler.mjs";

const product = {
  id: "soil-activator",
  name: "Soil Activator",
  shopping_link: "https://supplier.example/product",
};
const helpers = {
  salesConversationClosedPatch: () => ({ salesConversationClosed: false }),
  pendingOrderPatch: (productId, existingPendingOrder, orderDraft) => ({
    productId,
    draft: orderDraft,
  }),
  incompleteOrderMessages: () => [{ type: "text", body: "Missing package" }],
  orderClosingMessages: () => [{ type: "text", body: "Order received" }],
  formatAdminOrderMessage: (item, orderDraft, customerId) => `Order ${customerId}: ${orderDraft.name}`,
};

test("order handler builds complete order plan", () => {
  const plan = buildOrderDraftPlan({
    customer: { id: "6731234567" },
    product,
    text: "Full order",
    orderDraft: {
      isComplete: true,
      packageId: "B",
      packageName: "Package B",
      packagePrice: "B$70",
      quantity: 1,
      name: "Ali",
      phone: "6731234567",
      address: "Kiulap",
    },
    helpers,
  });

  assert.equal(plan.handoffRequired, true);
  assert.equal(plan.order.productName, "Soil Activator");
  assert.equal(plan.order.name, "Ali");
  assert.equal(plan.customerPatch.pendingOrder, null);
  assert.equal(plan.adminMessage, "Order 6731234567: Ali");
});

test("order handler persists incomplete order draft", () => {
  const plan = buildOrderDraftPlan({
    customer: { id: "6731234567" },
    product,
    text: "Ali Kiulap",
    orderDraft: {
      isComplete: false,
      name: "Ali",
      address: "Kiulap",
    },
    helpers,
  });

  assert.equal(plan.handoffRequired, false);
  assert.equal(plan.order, undefined);
  assert.equal(plan.customerPatch.pendingOrder.productId, product.id);
  assert.equal(plan.messages[0].body, "Missing package");
});
