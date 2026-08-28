import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { OperationsStore } from "./operations.mjs";

test("operations store keeps releases, errors, and failed-message retries", async () => {
  const dataDir = await mkdtemp(path.resolve("whatsapp_agent/data/.operations-test-"));
  try {
    const store = new OperationsStore(dataDir);
    const initial = await store.ensureState({ version: "0.1.0-demo" });
    assert.equal(initial.version, "0.1.0-demo");
    assert.ok(initial.noReplyMonitorStartedAt);

    const release = await store.recordRelease({ version: "0.2.0", notes: "Operational controls" });
    assert.equal(release.version, "0.2.0");

    await store.recordError({ scope: "outbound_message", message: "Send failed", accountId: "store-a" });
    assert.equal((await store.listErrors())[0].scope, "outbound_message");

    const failure = await store.recordFailedMessage({
      businessAccountId: "store-a",
      to: "6731234567",
      messages: [{ type: "text", body: "Hello" }],
      error: "Send failed",
    });
    assert.equal(failure.status, "pending_retry");
    const retried = await store.markRetry(failure.id, { success: true });
    assert.equal(retried.status, "retried");
    assert.equal(retried.attempts, 1);

    const review = await store.resolveNoReply({
      businessAccountId: "store-a",
      customerId: "6731234567",
      inboundMessageId: "msg_1",
      actor: "admin:store-a",
    });
    assert.equal(review.status, "resolved");
    assert.equal((await store.listNoReplyReviews())[0].inboundMessageId, "msg_1");

    const queued = await store.enqueueFollowups([
      {
        businessAccountId: "store-a",
        customerId: "6731234567",
        productId: "product-a",
        followupKey: "first_day_followup",
        message: "Still interested?",
      },
      {
        businessAccountId: "store-a",
        customerId: "6731234567",
        productId: "product-a",
        followupKey: "first_day_followup",
        message: "Duplicate should be skipped.",
      },
    ], new Date("2026-05-26T12:00:00.000Z"));
    assert.equal(queued.length, 1);
    const claimed = await store.claimFollowupBatch(10, new Date("2026-05-26T12:00:00.000Z"));
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].status, "processing");
    assert.equal(claimed[0].attempts, 1);
    const sent = await store.updateFollowupDispatch(claimed[0].id, {
      status: "sent",
      sentAt: "2026-05-26T12:00:02.000Z",
    });
    assert.equal(sent.status, "sent");
    assert.equal((await store.listFollowupQueue())[0].followupKey, "first_day_followup");
    assert.equal((await store.listFollowupQueue("store-a")).length, 1);
    assert.equal((await store.listFollowupQueue("store-b")).length, 0);
    assert.equal((await store.listErrors("store-a")).length, 1);
    assert.equal((await store.listErrors("store-b")).length, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("dashboard profiles are isolated by business account", async () => {
  const dataDir = await mkdtemp(path.resolve("whatsapp_agent/data/.operations-test-"));
  try {
    const store = new OperationsStore(dataDir);
    await store.ensureState({ version: "0.1.0-demo" });

    await store.updateDashboardProfile({
      accountId: "team-a",
      name: "EXAL",
      accentColor: "#123456",
    });
    await store.updateDashboardProfile({
      accountId: "team-b",
      name: "AVANOVA",
      accentColor: "#654321",
    });

    assert.deepEqual(await store.getDashboardProfile("team-a"), {
      name: "EXAL",
      accentColor: "#123456",
    });
    assert.deepEqual(await store.getDashboardProfile("team-b"), {
      name: "AVANOVA",
      accentColor: "#654321",
    });
    assert.deepEqual(await store.getDashboardProfile("team-c"), {
      name: "AI Agent Monitor",
      accentColor: "#0071e3",
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("cancelled follow-up dispatch can be requeued when still due", async () => {
  const dataDir = await mkdtemp(path.resolve("whatsapp_agent/data/.operations-test-"));
  try {
    const store = new OperationsStore(dataDir);
    const [queued] = await store.enqueueFollowups([
      {
        businessAccountId: "store-a",
        customerId: "6731234567",
        productId: "product-a",
        followupKey: "day_4_followup",
        message: "First attempt",
      },
    ], new Date("2026-07-04T12:00:00.000Z"));

    await store.updateFollowupDispatch(queued.id, {
      status: "cancelled",
      lastError: "Follow-up send window missed or customer moved to another stage.",
    });

    const requeued = await store.enqueueFollowups([
      {
        businessAccountId: "store-a",
        customerId: "6731234567",
        productId: "product-a",
        followupKey: "day_4_followup",
        message: "Current attempt",
      },
    ], new Date("2026-07-04T12:10:00.000Z"));
    const claimed = await store.claimFollowupBatch(10, new Date("2026-07-04T12:10:00.000Z"), "store-a");

    assert.equal(requeued.length, 1);
    assert.equal(requeued[0].id, queued.id);
    assert.equal(requeued[0].status, "queued");
    assert.equal(requeued[0].message, "Current attempt");
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, queued.id);
    assert.equal(claimed[0].status, "processing");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("follow-up dispatch rows wait until their dueAt time", async () => {
  const dataDir = await mkdtemp(path.resolve("whatsapp_agent/data/.operations-test-"));
  try {
    const store = new OperationsStore(dataDir);
    await store.enqueueFollowups([
      {
        businessAccountId: "store-a",
        customerId: "6731111111",
        productId: "product-a",
        followupKey: "first_follow_up_1",
        dueAt: "2026-08-28T03:49:00.000Z",
      },
      {
        businessAccountId: "store-a",
        customerId: "6731111111",
        productId: "product-a",
        followupKey: "first_follow_up_2",
        dueAt: "2026-08-28T10:49:00.000Z",
      },
    ], new Date("2026-08-28T01:49:00.000Z"));

    assert.equal((await store.claimFollowupBatch(10, new Date("2026-08-28T03:48:59.000Z"), "store-a")).length, 0);

    const firstBatch = await store.claimFollowupBatch(10, new Date("2026-08-28T03:49:00.000Z"), "store-a");
    assert.equal(firstBatch.length, 1);
    assert.equal(firstBatch[0].followupKey, "first_follow_up_1");
    await store.updateFollowupDispatch(firstBatch[0].id, {
      status: "sent",
      sentAt: "2026-08-28T03:49:05.000Z",
    });

    const secondBatch = await store.claimFollowupBatch(10, new Date("2026-08-28T10:49:00.000Z"), "store-a");
    assert.equal(secondBatch.length, 1);
    assert.equal(secondBatch[0].followupKey, "first_follow_up_2");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("follow-up queue retention drops completed rows but keeps active rows", async () => {
  const dataDir = await mkdtemp(path.resolve("whatsapp_agent/data/.operations-test-"));
  try {
    const store = new OperationsStore(dataDir, { completedFollowupRetentionDays: 0 });
    const [completed] = await store.enqueueFollowups([
      {
        businessAccountId: "store-a",
        customerId: "6731111111",
        productId: "product-a",
        followupKey: "day_1_followup",
        message: "Completed",
      },
    ], new Date("2026-07-04T12:00:00.000Z"));
    const [claimed] = await store.claimFollowupBatch(1, new Date("2026-07-04T12:00:00.000Z"), "store-a");
    await store.updateFollowupDispatch(claimed.id, { status: "sent" });

    await store.enqueueFollowups([
      {
        businessAccountId: "store-a",
        customerId: "6732222222",
        productId: "product-a",
        followupKey: "day_1_followup",
        message: "Active",
      },
    ], new Date("2026-07-04T12:05:00.000Z"));

    const rows = await store.listFollowupQueue("store-a");
    assert.equal(rows.some((item) => item.id === completed.id), false);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].customerId, "6732222222");
    assert.equal(rows[0].status, "queued");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
