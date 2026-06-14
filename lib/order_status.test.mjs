import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { customerOrderStatusReply, DEFAULT_ORDER_STATUS_REPLIES } from "./order_tracking.mjs";
import { JsonStore } from "./store.mjs";

test("order admin delivery lifecycle stores timestamped status history", async () => {
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

    const acknowledged = await store.updateOrderStatus(
      submitted.id,
      "acknowledged_by_order_admin",
      "orders-team"
    );
    assert.equal(acknowledged.orderAdminId, "orders-team");
    assert.ok(acknowledged.acknowledgedAt);

    const ordered = await store.updateOrderStatus(
      submitted.id,
      "ordered_from_supplier",
      "orders-team"
    );
    const warehouse = await store.updateOrderStatus(submitted.id, "reached_warehouse", "orders-team");
    const preparing = await store.updateOrderStatus(submitted.id, "preparing_for_delivery", "orders-team");
    const delivering = await store.updateOrderStatus(submitted.id, "delivering", "orders-team");
    const delivered = await store.updateOrderStatus(submitted.id, "delivered", "orders-team");

    assert.equal(ordered.status, "ordered_from_supplier");
    assert.equal(warehouse.status, "reached_warehouse");
    assert.equal(preparing.status, "preparing_for_delivery");
    assert.equal(delivering.status, "delivering");
    assert.equal(delivered.status, "delivered");
    assert.ok(delivered.completedAt);
    assert.deepEqual(
      delivered.statusHistory.map((entry) => entry.status),
      [
        "pending_admin_order",
        "acknowledged_by_order_admin",
        "ordered_from_supplier",
        "reached_warehouse",
        "preparing_for_delivery",
        "delivering",
        "delivered",
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
    await store.updateOrderStatus(orderA.id, "delivering", "orders-team");
    await store.updateOrderStatus(orderB.id, "reached_warehouse", "orders-team");
    await store.saveOrderStatusReplies("store-a", {
      ...DEFAULT_ORDER_STATUS_REPLIES,
      delivering: "Store A delivery is on the way.",
    });

    const latestA = await store.findLatestOrderForCustomer("6730001", "store-a");
    const latestB = await store.findLatestOrderForCustomer("6730001", "store-b");
    const repliesA = await store.getOrderStatusReplies("store-a");
    const repliesB = await store.getOrderStatusReplies("store-b");

    assert.equal(latestA.productId, "product-a");
    assert.equal(latestB.productId, "product-b");
    assert.equal(customerOrderStatusReply(latestA, repliesA), "Store A delivery is on the way.");
    assert.equal(customerOrderStatusReply(latestB, repliesB), DEFAULT_ORDER_STATUS_REPLIES.reached_warehouse);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
