import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonStore } from "./store.mjs";

test("deleteConversationMessages removes only the selected scoped customer chat", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);

  await store.appendOutbox({ direction: "inbound", from: "6731111111", to: "agent", businessAccountId: "store-a", body: "hi" });
  await store.appendOutbox({ direction: "outbound", from: "ai_agent", to: "6731111111", businessAccountId: "store-a", body: "hello" });
  await store.appendOutbox({ direction: "inbound", from: "6732222222", to: "agent", businessAccountId: "store-a", body: "other customer" });
  await store.appendOutbox({ direction: "inbound", from: "6731111111", to: "agent", businessAccountId: "store-b", body: "other account" });

  const result = await store.deleteConversationMessages("6731111111", "store-a");
  const storeA = await store.listOutbox("store-a");
  const storeB = await store.listOutbox("store-b");

  assert.deepEqual(result, { customerId: "6731111111", deleted: 2 });
  assert.equal(storeA.length, 1);
  assert.equal(storeA[0].from, "6732222222");
  assert.equal(storeB.length, 1);
  assert.equal(storeB[0].from, "6731111111");
});

test("deleteCustomer removes scoped customer orders from order tables", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);

  await store.getOrCreateCustomer("6731111111", { businessAccountId: "store-a" });
  await store.getOrCreateCustomer("6731111111", { businessAccountId: "store-b" });
  await store.addOrder({ customerId: "6731111111", businessAccountId: "store-a", productId: "product-a" });
  await store.addOrder({ customerId: "6731111111", businessAccountId: "store-b", productId: "product-b" });

  const deleted = await store.deleteCustomer("6731111111", "Manual deletion from submitted order customers", new Date(), "store-a");

  assert.equal(deleted.businessAccountId, "store-a");
  assert.equal((await store.listCustomers(new Date(), "store-a")).length, 0);
  assert.equal((await store.listCustomers(new Date(), "store-b")).length, 1);
  assert.deepEqual((await store.listOrders("store-a")).map((order) => order.productId), []);
  assert.deepEqual((await store.listOrders("store-b")).map((order) => order.productId), ["product-b"]);
});
