import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  customerOrderStatusReply,
  DEFAULT_ORDER_STATUS_REPLIES,
  isDeliveryRescheduleRequest,
  isLikelyOrderStatusQuestion,
} from "./order_tracking.mjs";
import { JsonStore } from "./store.mjs";

test("order admin delivery lifecycle stores submitted and reached-warehouse history", async () => {
  const dataDir = await mkdtemp(path.resolve("whatsapp_agent/data/.order-status-test-"));
  try {
    const store = new JsonStore(dataDir);
    await store.getOrCreateCustomer("customer_1", { businessAccountId: "store-a" });
    const submitted = await store.addOrder({
      customerId: "customer_1",
      businessAccountId: "store-a",
      productId: "blackhead-remover",
      name: "Aminah",
      phone: "6731234567",
      address: "Bandar",
    });
    assert.equal(submitted.status, "pending_admin_order");
    assert.equal(
      customerOrderStatusReply(submitted),
      "Your order has been received and currently in order & shipping phase."
    );

    const warehouse = await store.updateOrderStatus(submitted.id, "reached_warehouse", "orders-team");

    assert.equal(warehouse.status, "reached_warehouse");
    assert.equal(warehouse.orderAdminId, "orders-team");
    assert.ok(warehouse.reachedWarehouseAt);
    assert.deepEqual(
      warehouse.statusHistory.map((entry) => entry.status),
      [
        "pending_admin_order",
        "reached_warehouse",
      ]
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("status lookup and approved replies are isolated per business account", async () => {
  const dataDir = await mkdtemp(path.resolve("whatsapp_agent/data/.order-status-scope-test-"));
  try {
    const store = new JsonStore(dataDir);
    await store.getOrCreateCustomer("6730001", { businessAccountId: "store-a" });
    await store.getOrCreateCustomer("6730001", { businessAccountId: "store-b" });
    const orderA = await store.addOrder({
      customerId: "6730001",
      businessAccountId: "store-a",
      productId: "product-a",
    });
    const orderB = await store.addOrder({
      customerId: "6730001",
      businessAccountId: "store-b",
      productId: "product-b",
    });
    await store.updateOrderStatus(orderA.id, "reached_warehouse", "orders-team");
    await store.updateOrderStatus(orderB.id, "reached_warehouse", "orders-team");
    await store.saveOrderStatusReplies("store-a", {
      ...DEFAULT_ORDER_STATUS_REPLIES,
      reached_warehouse: "Store A order has reached warehouse.",
    });

    const latestA = await store.findLatestOrderForCustomer("6730001", "store-a");
    const latestB = await store.findLatestOrderForCustomer("6730001", "store-b");
    const repliesA = await store.getOrderStatusReplies("store-a");
    const repliesB = await store.getOrderStatusReplies("store-b");
    const customersA = await store.listCustomers(new Date(), "store-a");
    const customersB = await store.listCustomers(new Date(), "store-b");
    const ordersA = await store.listOrders("store-a");
    const ordersB = await store.listOrders("store-b");

    assert.equal(latestA.productId, "product-a");
    assert.equal(latestB.productId, "product-b");
    assert.equal(customersA.length, 1);
    assert.equal(customersB.length, 1);
    assert.equal(ordersA.length, 1);
    assert.equal(ordersB.length, 1);
    assert.equal(ordersA[0].productId, "product-a");
    assert.equal(ordersB[0].productId, "product-b");
    assert.equal(customerOrderStatusReply(latestA, repliesA), "Store A order has reached warehouse.");
    assert.equal(
      customerOrderStatusReply(latestB, repliesB),
      "Salam kita, dlm 1-3 ari runner will hantar brg '1 unit product-b' utk kita ya 🥰\nKita ingat reply Runner text, Runner TOMU LOGISTIC. 🥰"
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("delivery reschedule requests are not treated as order status questions", () => {
  const message = "Saya takde kat rumah. Buleh hantar minggu depan?";

  assert.equal(isDeliveryRescheduleRequest(message), true);
  assert.equal(isLikelyOrderStatusQuestion(message), false);
  assert.equal(isLikelyOrderStatusQuestion("Barang saya sudah sampai kah?"), true);
});
