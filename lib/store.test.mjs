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

test("processed message claims are durable and account-scoped", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);

  const first = await store.claimProcessedMessage("wamid_1", "store-a", {
    customerId: "6731111111",
    correlationId: "corr_1",
  });
  const duplicate = await store.claimProcessedMessage("wamid_1", "store-a");
  const otherAccount = await store.claimProcessedMessage("wamid_1", "store-b");
  await store.completeProcessedMessage("wamid_1", "store-a", { orderId: "ord_1" });
  const stored = await store.getProcessedMessage("wamid_1", "store-a");

  assert.equal(first.claimed, true);
  assert.equal(duplicate.claimed, false);
  assert.equal(otherAccount.claimed, true);
  assert.equal(stored.processingStatus, "completed");
  assert.equal(stored.completedAt.length > 0, true);
  assert.equal(stored.orderId, "ord_1");
  assert.equal(stored.correlationId, "corr_1");
});

test("pending buffers are durable, account-scoped, and replaceable", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);

  await store.savePendingBuffer("message_merge::store-a::6731111111", {
    type: "message_merge",
    businessAccountId: "store-a",
    customerId: "6731111111",
    dueAt: "2026-07-23T10:00:00.000Z",
    messages: ["harga"],
  });
  await store.savePendingBuffer("order_detail::store-b::6732222222", {
    type: "order_detail",
    businessAccountId: "store-b",
    customerId: "6732222222",
    dueAt: "2026-07-23T09:00:00.000Z",
    messages: ["Ali"],
  });
  const updated = await store.savePendingBuffer("message_merge::store-a::6731111111", {
    type: "message_merge",
    businessAccountId: "store-a",
    customerId: "6731111111",
    dueAt: "2026-07-23T10:01:00.000Z",
    messages: ["harga", "package"],
  });
  const scoped = await store.listPendingBuffers("store-a");
  const stored = await store.getPendingBuffer("message_merge::store-a::6731111111");
  const deleted = await store.deletePendingBuffer("message_merge::store-a::6731111111");

  assert.deepEqual(updated.messages, ["harga", "package"]);
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].businessAccountId, "store-a");
  assert.equal(stored.dueAt, "2026-07-23T10:01:00.000Z");
  assert.equal(deleted, true);
  assert.equal(await store.getPendingBuffer("message_merge::store-a::6731111111"), null);
});

test("concurrent pending buffer updates preserve fragments", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);
  const key = "order_detail::store-a::6731111111";

  await Promise.all([
    store.updatePendingBuffer(key, (buffer) => ({
      type: "order_detail",
      businessAccountId: "store-a",
      customerId: "6731111111",
      messages: [...(buffer?.messages || []), "Nama Ali"],
    })),
    store.updatePendingBuffer(key, (buffer) => ({
      type: "order_detail",
      businessAccountId: "store-a",
      customerId: "6731111111",
      messages: [...(buffer?.messages || []), "Kg Ayer"],
    })),
  ]);
  const stored = await store.getPendingBuffer(key);

  assert.equal(stored.messages.length, 2);
  assert.equal(stored.messages.includes("Nama Ali"), true);
  assert.equal(stored.messages.includes("Kg Ayer"), true);
});

test("concurrent customer updates preserve both patches and increment versions", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);
  await store.getOrCreateCustomer("6731111111", { businessAccountId: "store-a" });

  await Promise.all([
    store.updateCustomer("6731111111", (customer) => ({
      source: { ...(customer.source || {}), first: true },
    }), "store-a"),
    store.updateCustomer("6731111111", (customer) => ({
      followupsSent: { ...(customer.followupsSent || {}), first_day_followup: "sent" },
    }), "store-a"),
  ]);
  const customer = await store.getCustomer("6731111111", "store-a");

  assert.equal(customer.source.first, true);
  assert.equal(customer.followupsSent.first_day_followup, "sent");
  assert.equal(customer.version, 3);
});

test("getCustomer reads existing state before inbound count mutation", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);

  assert.equal(await store.getCustomer("6731111111", "store-a"), null);
  await store.getOrCreateCustomer("6731111111", {
    businessAccountId: "store-a",
    recordInbound: true,
  });
  const stored = await store.getCustomer("6731111111", "store-a");

  assert.equal(stored.id, "6731111111");
  assert.equal(stored.inboundCount, 1);
  assert.equal(await store.getCustomer("6731111111", "store-b"), null);
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

test("next follow-up does not fire shortly after previous follow-up was actually sent", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);
  await store.getOrCreateCustomer("6731111111", {
    businessAccountId: "store-a",
    productId: "wipe-xpert",
    firstSeenAt: "2026-06-30T02:00:00.000Z",
    lastInboundAt: "2026-06-30T02:00:00.000Z",
    orderIds: [],
    followupsSent: {
      first_day_followup: "2026-07-01T11:38:00.000Z",
    },
  });

  const catalog = {
    products: [
      {
        id: "wipe-xpert",
        followups: {
          first_day_followup: {
            message: "First follow up",
            send_hour: 20,
            first_chat_cutoff_hour: 19,
            day_offset: 0,
          },
          day_1_followup: {
            message: "Day 1 follow up",
            send_hour: 20,
            day_offset: 1,
          },
        },
      },
    ],
  };

  const sameDay8pm = await store.getDueFollowups(catalog, new Date("2026-07-01T12:00:00.000Z"));

  assert.equal(sameDay8pm.length, 0);
});

test("missed follow-up stage is skipped instead of sent as overdue", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);
  await store.getOrCreateCustomer("6731111111", {
    businessAccountId: "store-a",
    productId: "wipe-xpert",
    firstSeenAt: "2026-06-30T02:00:00.000Z",
    lastInboundAt: "2026-06-30T02:00:00.000Z",
    orderIds: [],
    followupsSent: {},
  });

  const catalog = {
    products: [
      {
        id: "wipe-xpert",
        followups: {
          first_day_followup: {
            message: "First follow up",
            send_hour: 20,
            first_chat_cutoff_hour: 19,
            day_offset: 0,
          },
          day_1_followup: {
            message: "Day 1 follow up",
            send_hour: 20,
            day_offset: 1,
          },
          day_2_followup: {
            message: "Day 2 follow up",
            send_hour: 20,
            day_offset: 2,
          },
        },
      },
    ],
  };

  const day1BeforeSendHour = await store.getDueFollowups(catalog, new Date("2026-07-01T11:38:00.000Z"));
  const day1AtSendHour = await store.getDueFollowups(catalog, new Date("2026-07-01T12:00:00.000Z"));
  const day2AtSendHour = await store.getDueFollowups(catalog, new Date("2026-07-02T12:00:00.000Z"));

  assert.equal(day1BeforeSendHour.length, 0);
  assert.equal(day1AtSendHour.length, 1);
  assert.equal(day1AtSendHour[0].followupKey, "day_1_followup");
  assert.equal(day2AtSendHour.length, 1);
  assert.equal(day2AtSendHour[0].followupKey, "day_2_followup");
});

test("after-cutoff customers receive first follow-up on the next day", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);
  await store.getOrCreateCustomer("6731111111", {
    businessAccountId: "store-a",
    productId: "wipe-xpert",
    firstSeenAt: "2026-07-01T11:30:00.000Z",
    lastInboundAt: "2026-07-01T11:30:00.000Z",
    orderIds: [],
    followupsSent: {},
  });

  const catalog = {
    products: [
      {
        id: "wipe-xpert",
        followups: {
          first_day_followup: {
            message: "First follow up",
            send_hour: 20,
            first_chat_cutoff_hour: 19,
            day_offset: 0,
          },
          day_1_followup: {
            message: "Day 1 follow up",
            send_hour: 20,
            day_offset: 1,
          },
        },
      },
    ],
  };

  const sameDay8pm = await store.getDueFollowups(catalog, new Date("2026-07-01T12:00:00.000Z"));
  const nextDay8pm = await store.getDueFollowups(catalog, new Date("2026-07-02T12:00:00.000Z"));
  await store.markFollowupSent("6731111111", "first_day_followup", new Date("2026-07-02T12:00:00.000Z"), "store-a");
  const dayAfterNext8pm = await store.getDueFollowups(catalog, new Date("2026-07-03T12:00:00.000Z"));

  assert.equal(sameDay8pm.length, 0);
  assert.equal(nextDay8pm.length, 1);
  assert.equal(nextDay8pm[0].followupKey, "first_day_followup");
  assert.equal(dayAfterNext8pm.length, 1);
  assert.equal(dayAfterNext8pm[0].followupKey, "day_1_followup");
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
