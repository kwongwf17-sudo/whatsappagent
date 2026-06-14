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
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
