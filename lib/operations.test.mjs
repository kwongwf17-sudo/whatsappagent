import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("duplicate follow-up enqueue does not rewrite the dispatch queue", async () => {
  const dataDir = await mkdtemp(path.resolve("whatsapp_agent/data/.operations-test-"));
  try {
    const adapter = new CountingAdapter();
    const store = new OperationsStore(dataDir, { adapter });
    const item = {
      businessAccountId: "store-a",
      customerId: "6731234567",
      productId: "product-a",
      followupKey: "day_4_followup",
      message: "Already queued",
    };

    await store.enqueueFollowups([item], new Date("2026-07-04T12:00:00.000Z"));
    const writesAfterFirst = adapter.writeCounts.get("followup_dispatch_queue") || 0;
    const duplicate = await store.enqueueFollowups([item], new Date("2026-07-04T12:01:00.000Z"));
    const writesAfterDuplicate = adapter.writeCounts.get("followup_dispatch_queue") || 0;

    assert.equal(duplicate.length, 0);
    assert.equal(writesAfterFirst, 1);
    assert.equal(writesAfterDuplicate, writesAfterFirst);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("empty follow-up dispatch claim does not rewrite the queue", async () => {
  const dataDir = await mkdtemp(path.resolve("whatsapp_agent/data/.operations-test-"));
  try {
    const adapter = new CountingAdapter();
    const store = new OperationsStore(dataDir, { adapter });
    await store.enqueueFollowups([
      {
        businessAccountId: "store-a",
        customerId: "6731234567",
        productId: "product-a",
        followupKey: "day_4_followup",
        message: "Later",
        dueAt: "2026-07-04T12:00:00.000Z",
      },
    ], new Date("2026-07-04T11:00:00.000Z"));
    const writesAfterEnqueue = adapter.writeCounts.get("followup_dispatch_queue") || 0;

    const claimed = await store.claimFollowupBatch(5, new Date("2026-07-04T11:30:00.000Z"), "store-a");
    const writesAfterEmptyClaim = adapter.writeCounts.get("followup_dispatch_queue") || 0;

    assert.deepEqual(claimed, []);
    assert.equal(writesAfterEmptyClaim, writesAfterEnqueue);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("no-op follow-up dispatch update does not rewrite the queue", async () => {
  const dataDir = await mkdtemp(path.resolve("whatsapp_agent/data/.operations-test-"));
  try {
    const adapter = new CountingAdapter();
    const store = new OperationsStore(dataDir, { adapter });
    const [queued] = await store.enqueueFollowups([
      {
        businessAccountId: "store-a",
        customerId: "6731234567",
        productId: "product-a",
        followupKey: "day_4_followup",
        message: "Already queued",
        dueAt: "2026-07-04T12:00:00.000Z",
      },
    ], new Date("2026-07-04T11:00:00.000Z"));
    const writesAfterEnqueue = adapter.writeCounts.get("followup_dispatch_queue") || 0;

    await store.updateFollowupDispatch(queued.id, {
      status: "queued",
      availableAt: "2026-07-04T12:00:00.000Z",
      lastError: "",
    });
    const writesAfterNoopUpdate = adapter.writeCounts.get("followup_dispatch_queue") || 0;

    assert.equal(writesAfterNoopUpdate, writesAfterEnqueue);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("batched follow-up dispatch updates rewrite the queue once", async () => {
  const dataDir = await mkdtemp(path.resolve("whatsapp_agent/data/.operations-test-"));
  try {
    const adapter = new CountingAdapter();
    const store = new OperationsStore(dataDir, { adapter });
    const queued = await store.enqueueFollowups([
      {
        businessAccountId: "store-a",
        customerId: "6731111111",
        productId: "product-a",
        followupKey: "first_followup",
        message: "First",
      },
      {
        businessAccountId: "store-a",
        customerId: "6732222222",
        productId: "product-a",
        followupKey: "first_followup",
        message: "Second",
      },
    ], new Date("2026-07-04T11:00:00.000Z"));
    const writesAfterEnqueue = adapter.writeCounts.get("followup_dispatch_queue") || 0;

    await store.updateFollowupDispatches(queued.map((item) => ({
      id: item.id,
      patch: { status: "sent", sentAt: "2026-07-04T12:00:00.000Z", lastError: "" },
    })));
    const writesAfterBatch = adapter.writeCounts.get("followup_dispatch_queue") || 0;

    assert.equal(writesAfterBatch, writesAfterEnqueue + 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("multi-account follow-up claims rewrite the queue once", async () => {
  const dataDir = await mkdtemp(path.resolve("whatsapp_agent/data/.operations-test-"));
  try {
    const adapter = new CountingAdapter();
    const store = new OperationsStore(dataDir, { adapter });
    await store.enqueueFollowups([
      {
        businessAccountId: "store-a",
        customerId: "6731111111",
        productId: "product-a",
        followupKey: "first_followup",
        message: "First",
      },
      {
        businessAccountId: "store-b",
        customerId: "6732222222",
        productId: "product-b",
        followupKey: "first_followup",
        message: "Second",
      },
    ], new Date("2026-07-04T11:00:00.000Z"));
    const writesAfterEnqueue = adapter.writeCounts.get("followup_dispatch_queue") || 0;

    const claimed = await store.claimFollowupBatches([
      { businessAccountId: "store-a", limit: 1 },
      { businessAccountId: "store-b", limit: 1 },
    ], new Date("2026-07-04T12:00:00.000Z"));
    const writesAfterClaim = adapter.writeCounts.get("followup_dispatch_queue") || 0;

    assert.equal(claimed.length, 2);
    assert.equal(writesAfterClaim, writesAfterEnqueue + 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("table-backed follow-up dispatches bypass JSON queue rewrites", async () => {
  const dataDir = await mkdtemp(path.resolve("whatsapp_agent/data/.operations-test-"));
  try {
    const adapter = new TableCountingAdapter();
    const store = new OperationsStore(dataDir, { adapter });
    const item = {
      businessAccountId: "store-a",
      customerId: "6731111111",
      productId: "product-a",
      followupKey: "first_followup",
      message: "First",
      dueAt: "2026-07-04T12:00:00.000Z",
    };

    const queued = await store.enqueueFollowups([item], new Date("2026-07-04T11:00:00.000Z"));
    const duplicate = await store.enqueueFollowups([item], new Date("2026-07-04T11:01:00.000Z"));
    const claimed = await store.claimFollowupBatch(10, new Date("2026-07-04T12:00:00.000Z"), "store-a");
    await store.updateFollowupDispatch(claimed[0].id, { status: "sent", sentAt: "2026-07-04T12:00:02.000Z" });
    const rows = await store.listFollowupQueue("store-a");

    assert.equal(queued.length, 1);
    assert.equal(duplicate.length, 0);
    assert.equal(claimed.length, 1);
    assert.equal(rows[0].status, "sent");
    assert.equal(adapter.writeCounts.get("followup_dispatch_queue") || 0, 0);
    assert.deepEqual(adapter.calls, ["enqueue", "prune", "enqueue", "prune", "claim", "prune", "updateMany", "list"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("operations store treats all-NUL operational JSON files as empty", async () => {
  const dataDir = await mkdtemp(path.resolve("whatsapp_agent/data/.operations-test-"));
  try {
    const store = new OperationsStore(dataDir);
    await writeFile(path.join(dataDir, "error_log.json"), Buffer.alloc(128));
    await writeFile(path.join(dataDir, "followup_dispatch_queue.json"), Buffer.alloc(128));

    assert.deepEqual(await store.listErrors(), []);
    assert.deepEqual(await store.listFollowupQueue("store-a"), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("operations store can persist operational records in table storage", async () => {
  const dataDir = await mkdtemp(path.resolve("whatsapp_agent/data/.operations-table-events-test-"));
  try {
    const adapter = new OperationalEventsAdapter();
    const store = new OperationsStore(dataDir, { adapter });

    await store.recordError({ scope: "send", accountId: "ALLEN", message: "failed" });
    const failed = await store.recordFailedMessage({ businessAccountId: "ALLEN", to: "673", messages: [{ type: "text", text: "hi" }], error: "network" });
    await store.markRetry(failed.id, { success: false, error: "still failed" });
    await store.resolveNoReply({ businessAccountId: "allen", customerId: "673", inboundMessageId: "wamid_1" });

    assert.equal((await store.listErrors("ALLEN"))[0].message, "failed");
    assert.equal((await store.getFailedMessage(failed.id)).attempts, 1);
    assert.equal((await store.listFailedMessages("ALLEN"))[0].status, "retry_failed");
    assert.equal((await store.listNoReplyReviews("allen"))[0].customerId, "673");
    assert.equal(adapter.writeCounts.get("error_log") || 0, 0);
    assert.equal(adapter.writeCounts.get("failed_messages") || 0, 0);
    assert.equal(adapter.writeCounts.get("no_reply_reviews") || 0, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

class CountingAdapter {
  documents = new Map();
  writeCounts = new Map();

  async readJson(filePath, fallback) {
    const key = path.basename(filePath, ".json");
    if (!this.documents.has(key)) return structuredClone(fallback);
    return structuredClone(this.documents.get(key));
  }

  async writeJson(filePath, data) {
    const key = path.basename(filePath, ".json");
    this.documents.set(key, structuredClone(data));
    this.writeCounts.set(key, (this.writeCounts.get(key) || 0) + 1);
  }
}

class OperationalEventsAdapter extends CountingAdapter {
  operationalEventsTableEnabled = true;
  events = new Map();

  async insertOperationalEvent(category, event = {}) {
    const key = `${category}::${event.id}`;
    this.events.set(key, { category, payload: structuredClone(event) });
    return structuredClone(event);
  }

  async listOperationalEvents(category, businessAccountId = "") {
    return [...this.events.values()]
      .filter((entry) => entry.category === category)
      .map((entry) => entry.payload)
      .filter((event) => !businessAccountId || event.businessAccountId === businessAccountId)
      .map((event) => structuredClone(event))
      .reverse();
  }

  async getOperationalEvent(category, id) {
    return structuredClone(this.events.get(`${category}::${id}`)?.payload || null);
  }
}

class TableCountingAdapter extends CountingAdapter {
  followupQueueTableEnabled = true;
  rows = [];
  calls = [];

  async enqueueFollowupDispatches(items = [], queuedAt = new Date()) {
    this.calls.push("enqueue");
    const saved = [];
    for (const item of items) {
      const dispatchKey = [item.businessAccountId || "", item.customerId || "", item.followupKey || ""].join(":");
      const existing = this.rows.find((row) => row.dispatchKey === dispatchKey);
      if (existing) {
        if (["held_template", "cancelled"].includes(existing.status)) {
          Object.assign(existing, {
            status: "queued",
            dueAt: item.dueAt || queuedAt.toISOString(),
            availableAt: item.dueAt || queuedAt.toISOString(),
            lastError: "",
            updatedAt: queuedAt.toISOString(),
          });
          saved.push(structuredClone(existing));
        }
        continue;
      }
      const row = {
        id: `followup_${this.rows.length + 1}`,
        dispatchKey,
        businessAccountId: item.businessAccountId || "",
        customerId: item.customerId || "",
        productId: item.productId || "",
        labelDisplay: item.labelDisplay || "",
        followupKey: item.followupKey || "",
        message: item.message || "",
        messages: item.messages || [],
        status: "queued",
        attempts: 0,
        queuedAt: queuedAt.toISOString(),
        dueAt: item.dueAt || queuedAt.toISOString(),
        availableAt: item.dueAt || queuedAt.toISOString(),
        updatedAt: queuedAt.toISOString(),
        lastError: "",
      };
      this.rows.push(row);
      saved.push(structuredClone(row));
    }
    return saved;
  }

  async claimFollowupDispatchBatches(accountLimits = [], now = new Date()) {
    this.calls.push("claim");
    const claimed = [];
    for (const entry of accountLimits) {
      const batch = this.rows
        .filter((row) => row.businessAccountId === entry.businessAccountId && ["queued", "retry_pending"].includes(row.status) && new Date(row.availableAt || row.queuedAt) <= now)
        .slice(0, entry.limit);
      for (const row of batch) {
        row.status = "processing";
        row.attempts += 1;
        row.updatedAt = now.toISOString();
        claimed.push(structuredClone(row));
      }
    }
    return claimed;
  }

  async updateFollowupDispatch(id, patch = {}) {
    const [row] = await this.updateFollowupDispatches([{ id, patch }]);
    if (!row) throw new Error("Follow-up queue item not found.");
    return row;
  }

  async updateFollowupDispatches(updates = []) {
    this.calls.push("updateMany");
    const saved = [];
    for (const update of updates) {
      const row = this.rows.find((item) => item.id === update.id);
      if (!row) continue;
      Object.assign(row, update.patch, { updatedAt: new Date().toISOString() });
      saved.push(structuredClone(row));
    }
    return saved;
  }

  async listFollowupDispatches(businessAccountId = "") {
    this.calls.push("list");
    return this.rows.filter((row) => !businessAccountId || row.businessAccountId === businessAccountId).map((row) => structuredClone(row)).reverse();
  }

  async pruneFollowupDispatches() {
    this.calls.push("prune");
    return 0;
  }
}

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
