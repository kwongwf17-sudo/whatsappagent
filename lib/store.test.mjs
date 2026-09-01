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

test("stored customer and outbox sources trim repeated bulky ad payloads", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);
  const longAdBody = "promo ".repeat(400);

  const customer = await store.getOrCreateCustomer("6731111111", {
    businessAccountId: "store-a",
    source: {
      adId: "ad_1",
      referralHeadline: "Promo headline",
      referralBody: longAdBody,
      adBody: longAdBody,
      sourceUrl: "https://example.com/ad",
    },
  });
  await store.appendOutbox({
    id: "wamid_source",
    direction: "inbound",
    from: "6731111111",
    to: "agent",
    businessAccountId: "store-a",
    body: "hi",
    source: {
      referralBody: longAdBody,
      adBody: longAdBody,
    },
  });

  const outbox = await store.listOutbox("store-a");
  assert.equal(customer.source.adId, "ad_1");
  assert.equal(customer.source.referralHeadline, "Promo headline");
  assert.equal(customer.source.sourceUrl, "https://example.com/ad");
  assert.equal(customer.source.referralBody.length <= 803, true);
  assert.equal(customer.source.adBody.length <= 803, true);
  assert.equal(outbox[0].source.referralBody.length <= 803, true);
  assert.equal(outbox[0].source.adBody.length <= 803, true);
});

test("customer lead source keeps Baileys ad clues after plain and manual updates", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);

  const first = await store.getOrCreateCustomer("35553907056882@lid", {
    businessAccountId: "allen",
    recordInbound: true,
    source: {
      transport: "web",
      remoteJid: "35553907056882@lid",
      adTitle: "PEEL-OFF BROW GEL",
      adBody: "Promo for PEEL-OFF BROW GEL",
      referralHeadline: "Hi are you looking for PEEL-OFF BROW GEL?",
      sourceUrl: "https://example.com/ad",
    },
  });
  const second = await store.getOrCreateCustomer("35553907056882@lid", {
    businessAccountId: "allen",
    recordInbound: true,
    source: {
      transport: "web",
      remoteJid: "35553907056882@lid",
    },
  });
  const manual = await store.getOrCreateCustomer("35553907056882@lid", {
    businessAccountId: "allen",
    source: {
      transport: "web",
      remoteJid: "35553907056882@lid",
      fromMe: true,
      manualBusinessMessage: true,
    },
  });

  assert.equal(first.leadSource.adTitle, "PEEL-OFF BROW GEL");
  assert.equal(second.leadSource.referralHeadline, "Hi are you looking for PEEL-OFF BROW GEL?");
  assert.equal(manual.leadSource.adBody, "Promo for PEEL-OFF BROW GEL");
  assert.equal(manual.source.adTitle, "PEEL-OFF BROW GEL");
  assert.equal(manual.source.manualBusinessMessage, true);
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

test("operational retention trims old outbox processed messages and audit rows", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir, {
    outboxRetentionDays: 5,
    processedMessageRetentionDays: 5,
    auditLogMaxRows: 2,
  });
  const oldDate = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();

  await store.appendOutbox({ createdAt: oldDate, direction: "inbound", from: "old", businessAccountId: "store-a", body: "old" });
  await store.appendOutbox({ direction: "inbound", from: "new", businessAccountId: "store-a", body: "new" });
  assert.deepEqual((await store.listOutbox("store-a")).map((message) => message.from), ["new"]);

  await store.claimProcessedMessage("old_msg", "store-a", { receivedAt: oldDate, completedAt: oldDate });
  await store.claimProcessedMessage("new_msg", "store-a");
  assert.equal(await store.getProcessedMessage("old_msg", "store-a"), null);
  assert.notEqual(await store.getProcessedMessage("new_msg", "store-a"), null);

  await store.appendAuditLog({ action: "first" });
  await store.appendAuditLog({ action: "second" });
  await store.appendAuditLog({ action: "third" });
  assert.deepEqual((await store.listAuditLog()).map((event) => event.action), ["second", "third"]);
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

test("follow-up remains sendable later on its due day", async () => {
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
  const day1LaterSameEvening = await store.getDueFollowups(catalog, new Date("2026-07-01T15:30:00.000Z"));
  const day2AtSendHour = await store.getDueFollowups(catalog, new Date("2026-07-02T12:00:00.000Z"));

  assert.equal(day1BeforeSendHour.length, 0);
  assert.equal(day1AtSendHour.length, 1);
  assert.equal(day1AtSendHour[0].followupKey, "day_1_followup");
  assert.equal(day1LaterSameEvening.length, 1);
  assert.equal(day1LaterSameEvening[0].followupKey, "day_1_followup");
  assert.equal(day2AtSendHour.length, 1);
  assert.equal(day2AtSendHour[0].followupKey, "day_2_followup");
});

test("custom follow-up schedule supports multiple same-day follow-ups", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);
  await store.getOrCreateCustomer("6731111111", {
    businessAccountId: "store-a",
    productId: "wipe-xpert",
    firstSeenAt: "2026-07-01T02:00:00.000Z",
    lastInboundAt: "2026-07-01T02:00:00.000Z",
    orderIds: [],
    followupsSent: {},
  });

  const catalog = {
    products: [
      {
        id: "wipe-xpert",
        followup_schedule: [
          { key: "same_day_1", label: "Same-day 1", timing_type: "fixed_time", day_offset: 0, send_hour: 12, message: "Noon" },
          { key: "same_day_2", label: "Same-day 2", timing_type: "fixed_time", day_offset: 0, send_hour: 16, message: "Afternoon" },
          { key: "same_day_3", label: "Same-day 3", timing_type: "fixed_time", day_offset: 0, send_hour: 20, message: "Evening" },
        ],
      },
    ],
  };

  const noon = await store.getDueFollowups(catalog, new Date("2026-07-01T04:00:00.000Z"));
  assert.equal(noon[0].followupKey, "same_day_1");
  await store.markFollowupSent("6731111111", "same_day_1", new Date("2026-07-01T04:00:00.000Z"), "store-a");

  const afternoon = await store.getDueFollowups(catalog, new Date("2026-07-01T08:00:00.000Z"));
  assert.equal(afternoon[0].followupKey, "same_day_2");
  await store.markFollowupSent("6731111111", "same_day_2", new Date("2026-07-01T08:00:00.000Z"), "store-a");

  const evening = await store.getDueFollowups(catalog, new Date("2026-07-01T12:00:00.000Z"));
  assert.equal(evening[0].followupKey, "same_day_3");
});

test("custom fixed-time follow-ups support minute precision", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);
  await store.getOrCreateCustomer("6731111111", {
    businessAccountId: "store-a",
    productId: "wipe-xpert",
    firstSeenAt: "2026-07-01T02:00:00.000Z",
    lastInboundAt: "2026-07-01T02:00:00.000Z",
    orderIds: [],
    followupsSent: {},
  });

  const catalog = {
    products: [
      {
        id: "wipe-xpert",
        followup_schedule: [
          { key: "evening_730", label: "7:30 PM", timing_type: "fixed_time", day_offset: 0, send_time: "19:30", message: "Evening" },
          { key: "midnight_1230", label: "12:30 AM", timing_type: "fixed_time", day_offset: 1, send_hour: 0, send_minute: 30, message: "Midnight" },
        ],
      },
    ],
  };

  const beforeEvening = await store.getDueFollowups(catalog, new Date("2026-07-01T11:29:00.000Z"));
  assert.equal(beforeEvening.length, 0);

  const evening = await store.getDueFollowups(catalog, new Date("2026-07-01T11:30:00.000Z"));
  assert.equal(evening[0].followupKey, "evening_730");
  await store.markFollowupSent("6731111111", "evening_730", new Date("2026-07-01T11:30:00.000Z"), "store-a");

  const beforeMidnight = await store.getDueFollowups(catalog, new Date("2026-07-01T16:29:00.000Z"));
  assert.equal(beforeMidnight.length, 0);

  const midnight = await store.getDueFollowups(catalog, new Date("2026-07-01T16:30:00.000Z"));
  assert.equal(midnight[0].followupKey, "midnight_1230");
});

test("custom fixed-time follow-ups do not catch up late after opening", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);
  await store.getOrCreateCustomer("6731111111", {
    businessAccountId: "store-a",
    productId: "wipe-xpert",
    firstSeenAt: "2026-07-01T14:00:00.000Z",
    openingFlowSentAt: "2026-07-01T15:50:00.000Z",
    lastInboundAt: "2026-07-01T14:00:00.000Z",
    orderIds: [],
    followupsSent: {},
  });

  const catalog = {
    products: [
      {
        id: "wipe-xpert",
        followup_schedule: [
          {
            key: "first_day_followup_1",
            label: "First Follow-Up",
            timing_type: "fixed_time",
            day_offset: 0,
            send_time: "13:00",
            message: "1 PM follow-up",
          },
        ],
      },
    ],
  };

  const lateSameDay = await store.getDueFollowups(catalog, new Date("2026-07-01T15:52:00.000Z"));
  assert.equal(lateSameDay.length, 0);

  const nextOnePm = await store.getDueFollowups(catalog, new Date("2026-07-02T05:00:00.000Z"));
  assert.equal(nextOnePm[0].followupKey, "first_day_followup_1");
});

test("custom fixed-time follow-ups use opening flow sent time as eligibility anchor", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);
  await store.getOrCreateCustomer("6731111111", {
    businessAccountId: "store-a",
    productId: "wipe-xpert",
    firstSeenAt: "2026-07-01T00:00:00.000Z",
    openingFlowSentAt: "2026-07-01T06:00:00.000Z",
    lastInboundAt: "2026-07-01T00:00:00.000Z",
    orderIds: [],
    followupsSent: {},
  });

  const catalog = {
    products: [
      {
        id: "wipe-xpert",
        followup_schedule: [
          {
            key: "first_day_followup_1",
            label: "First Follow-Up",
            timing_type: "fixed_time",
            day_offset: 0,
            send_time: "13:00",
            message: "1 PM follow-up",
          },
        ],
      },
    ],
  };

  const wouldBeDueFromFirstSeen = await store.getDueFollowups(catalog, new Date("2026-07-01T05:30:00.000Z"));
  assert.equal(wouldBeDueFromFirstSeen.length, 0);

  const nextOnePm = await store.getDueFollowups(catalog, new Date("2026-07-02T05:00:00.000Z"));
  assert.equal(nextOnePm[0].followupKey, "first_day_followup_1");
});

test("delay-after-opening follow-ups support minute precision", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);
  await store.getOrCreateCustomer("6731111111", {
    businessAccountId: "store-a",
    productId: "wipe-xpert",
    firstSeenAt: "2026-07-01T02:00:00.000Z",
    lastInboundAt: "2026-07-01T02:00:00.000Z",
    orderIds: [],
    followupsSent: {},
  });

  const catalog = {
    products: [
      {
        id: "wipe-xpert",
        followup_schedule: [
          { key: "after_30", label: "30 minutes", timing_type: "delay_after_opening", day_offset: 0, delay_duration: "00:30", message: "30 minutes later" },
        ],
      },
    ],
  };

  const beforeDelay = await store.getDueFollowups(catalog, new Date("2026-07-01T02:29:00.000Z"));
  assert.equal(beforeDelay.length, 0);

  const afterDelay = await store.getDueFollowups(catalog, new Date("2026-07-01T02:30:00.000Z"));
  assert.equal(afterDelay[0].followupKey, "after_30");
});

test("delay-after-opening follow-ups use opening flow sent time when available", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);
  await store.getOrCreateCustomer("6731111111", {
    businessAccountId: "store-a",
    productId: "wipe-xpert",
    firstSeenAt: "2026-07-01T22:00:00.000Z",
    openingFlowSentAt: "2026-07-01T23:00:00.000Z",
    lastInboundAt: "2026-07-01T22:00:00.000Z",
    orderIds: [],
    followupsSent: {},
  });

  const catalog = {
    products: [
      {
        id: "wipe-xpert",
        followup_schedule: [
          { key: "after_4h", timing_type: "delay_after_opening", delay_duration: "04:00", message: "4 hours later" },
        ],
      },
    ],
  };

  const fromFirstSeen = await store.getDueFollowups(catalog, new Date("2026-07-02T02:00:00.000Z"));
  assert.equal(fromFirstSeen.length, 0);

  const fromOpeningSent = await store.getDueFollowups(catalog, new Date("2026-07-02T03:00:00.000Z"));
  assert.equal(fromOpeningSent[0].followupKey, "after_4h");
});

test("next-day follow-up still waits until the configured send time after a late send", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const store = new JsonStore(dataDir);
  await store.getOrCreateCustomer("6731111111", {
    businessAccountId: "store-a",
    productId: "wipe-xpert",
    firstSeenAt: "2026-06-30T02:00:00.000Z",
    lastInboundAt: "2026-06-30T02:00:00.000Z",
    orderIds: [],
    followupsSent: {
      first_day_followup: "2026-07-01T15:30:00.000Z",
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

  const nextDayBeforeSendHour = await store.getDueFollowups(catalog, new Date("2026-07-02T11:59:00.000Z"));
  const nextDayAtSendHour = await store.getDueFollowups(catalog, new Date("2026-07-02T12:00:00.000Z"));

  assert.equal(nextDayBeforeSendHour.length, 0);
  assert.equal(nextDayAtSendHour.length, 1);
  assert.equal(nextDayAtSendHour[0].followupKey, "day_1_followup");
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

test("table-backed outbox preserves account scope without JSON rewrites", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const adapter = new MemoryTableAdapter();
  const store = new JsonStore(dataDir, { adapter });

  await store.appendOutbox({ id: "wamid_1", direction: "inbound", from: "6731111111", to: "agent", businessAccountId: "ALLEN", body: "hi" });
  await store.appendOutbox({ id: "wamid_1", direction: "inbound", from: "6731111111", to: "agent", businessAccountId: "allen", body: "hi other" });
  await store.appendOutbox({ direction: "outbound", from: "ai_agent", to: "6731111111", businessAccountId: "ALLEN", body: "hello" });

  assert.equal(await store.hasOutboxMessageId("wamid_1", "ALLEN"), true);
  assert.equal(await store.hasOutboxMessageId("wamid_1", "missing"), false);
  assert.deepEqual((await store.listOutbox("ALLEN")).map((message) => message.body), ["hi", "hello"]);
  assert.deepEqual(await store.deleteConversationMessages("6731111111", "ALLEN"), { customerId: "6731111111", deleted: 2 });
  assert.deepEqual((await store.listOutbox("allen")).map((message) => message.body), ["hi other"]);
  assert.equal(adapter.writeCounts.get("outbox") || 0, 0);
});

test("table-backed customers preserve updates and exact account isolation", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wa-store-"));
  const adapter = new MemoryTableAdapter();
  const store = new JsonStore(dataDir, { adapter });

  await store.getOrCreateCustomer("6731111111", {
    businessAccountId: "ALLEN",
    recordInbound: true,
    productId: "product-a",
    source: { adTitle: "Product A", adBody: "Promo Product A" },
  });
  await store.getOrCreateCustomer("6731111111", {
    businessAccountId: "allen",
    recordInbound: true,
    productId: "product-b",
  });
  await Promise.all([
    store.updateCustomer("6731111111", (customer) => ({
      source: { ...(customer.source || {}), first: true },
    }), "ALLEN"),
    store.updateCustomer("6731111111", (customer) => ({
      followupsSent: { ...(customer.followupsSent || {}), first_day_followup: "sent" },
    }), "ALLEN"),
  ]);

  const upper = await store.getCustomer("6731111111", "ALLEN");
  const lower = await store.getCustomer("6731111111", "allen");

  assert.equal(upper.productId, "product-a");
  assert.equal(upper.leadSource.adTitle, "Product A");
  assert.equal(upper.source.first, true);
  assert.equal(upper.followupsSent.first_day_followup, "sent");
  assert.equal(upper.version, 3);
  assert.equal(lower.productId, "product-b");
  assert.equal(lower.followupsSent.first_day_followup, undefined);
  assert.equal(adapter.writeCounts.get("customers") || 0, 0);
});

class MemoryTableAdapter {
  constructor() {
    this.outboxTableEnabled = true;
    this.customersTableEnabled = true;
    this.outbox = [];
    this.customers = new Map();
    this.documents = new Map();
    this.writeCounts = new Map();
  }

  async readJson(filePath, fallback) {
    const key = path.basename(filePath, ".json");
    return structuredClone(this.documents.get(key) || fallback);
  }

  async writeJson(filePath, data) {
    const key = path.basename(filePath, ".json");
    this.writeCounts.set(key, (this.writeCounts.get(key) || 0) + 1);
    this.documents.set(key, structuredClone(data));
  }

  async appendOutboxMessages(messages = []) {
    this.outbox.push(...messages.map((message) => structuredClone(message)));
    return messages;
  }

  async listOutboxMessages(businessAccountId = "") {
    return this.outbox.filter((message) => !businessAccountId || message.businessAccountId === businessAccountId);
  }

  async hasOutboxMessageId(messageId, businessAccountId = "") {
    return this.outbox.some((message) =>
      message.id === messageId && (!businessAccountId || message.businessAccountId === businessAccountId)
    );
  }

  async deleteConversationMessages(customerId, businessAccountId = "") {
    const before = this.outbox.length;
    this.outbox = this.outbox.filter((message) =>
      !(
        (!businessAccountId || message.businessAccountId === businessAccountId) &&
        (message.from === customerId || message.to === customerId)
      )
    );
    return { customerId, deleted: before - this.outbox.length };
  }

  async getCustomerRow(customerId, businessAccountId = "") {
    return structuredClone(this.customers.get(`${businessAccountId}::${customerId}`) || null);
  }

  async upsertCustomerRow(customer = {}) {
    this.customers.set(`${customer.businessAccountId || ""}::${customer.id}`, structuredClone(customer));
    return customer;
  }

  async listCustomerRows(businessAccountId = "") {
    return [...this.customers.values()]
      .filter((customer) => !businessAccountId || customer.businessAccountId === businessAccountId)
      .map((customer) => structuredClone(customer));
  }

  async deleteCustomerRow(customerId, businessAccountId = "") {
    return this.customers.delete(`${businessAccountId}::${customerId}`) ? 1 : 0;
  }
}
