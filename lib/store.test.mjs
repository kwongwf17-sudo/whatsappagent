import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonStore, computeCustomerLabel, customerLabelDisplay } from "./store.mjs";

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

test("hasOutboxMessageId detects scoped stored inbound ids", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);

  await store.appendOutbox({
    id: "wamid_duplicate",
    direction: "inbound",
    from: "6731111111",
    to: "agent",
    businessAccountId: "store-a",
    body: "harga brpa?",
  });

  assert.equal(await store.hasOutboxMessageId("wamid_duplicate", "store-a"), true);
  assert.equal(await store.hasOutboxMessageId("wamid_duplicate", "store-b"), false);
  assert.equal(await store.hasOutboxMessageId("missing", "store-a"), false);
});

test("first follow-up sent does not change same-day new customer label to day 1", () => {
  const firstSeenAt = "2026-06-27T08:00:00.000Z";
  const label = computeCustomerLabel(
    {
      id: "6731111111",
      firstSeenAt,
      inboundCount: 1,
      orderIds: [],
      followupsSent: {
        first_day_followup: "2026-06-27T12:00:00.000Z",
      },
    },
    new Date("2026-06-27T12:05:00.000Z")
  );

  assert.equal(label, "new_customer");
  assert.equal(customerLabelDisplay(label), "NEW");
});

test("first follow-up due time uses Brunei business timezone instead of server timezone", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);
  await store.getOrCreateCustomer("6731111111", {
    businessAccountId: "store-a",
    productId: "wipe-xpert",
    firstSeenAt: "2026-06-28T10:00:00.000Z",
    lastInboundAt: "2026-06-28T10:00:00.000Z",
    orderIds: [],
    followupsSent: {},
  });

  const catalog = {
    products: [
      {
        id: "wipe-xpert",
        followups: {
          first_day_followup: {
            message: "Follow up",
            send_hour: 20,
            first_chat_cutoff_hour: 19,
            day_offset: 0,
          },
        },
      },
    ],
  };

  const before8pmBrunei = await store.getDueFollowups(catalog, new Date("2026-06-28T11:59:00.000Z"));
  const at8pmBrunei = await store.getDueFollowups(catalog, new Date("2026-06-28T12:00:00.000Z"));

  assert.equal(before8pmBrunei.length, 0);
  assert.equal(at8pmBrunei.length, 1);
  assert.equal(at8pmBrunei[0].followupKey, "first_day_followup");
});

test("submitted order customer is labeled done instead of day stage", () => {
  const label = computeCustomerLabel(
    {
      id: "6731111111",
      firstSeenAt: "2026-06-27T08:00:00.000Z",
      inboundCount: 1,
      orderIds: ["ord_123"],
    },
    new Date("2026-06-28T12:05:00.000Z")
  );

  assert.equal(label, "done_customer");
  assert.equal(customerLabelDisplay(label), "DONE");
});
