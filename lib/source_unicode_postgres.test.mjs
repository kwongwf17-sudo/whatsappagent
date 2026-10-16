import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgresJsonAdapter } from "./postgres_adapter.mjs";
import { JsonStore } from "./store.mjs";

// Uses an opt-in database and an isolated, validated schema; no real customers.
test("Postgres accepts emoji-boundary sources while preserving opening history and message claims", { skip: !process.env.SOURCE_UNICODE_TEST_DATABASE_URL }, async () => {
  const { Pool } = await import("pg");
  const admin = new Pool({ connectionString: process.env.SOURCE_UNICODE_TEST_DATABASE_URL });
  const schema = `source_unicode_test_${process.pid}_${Date.now()}`;
  assert.match(schema, /^source_unicode_test_\d+_\d+$/);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.SOURCE_UNICODE_TEST_DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const dir = await mkdtemp(path.join(tmpdir(), "source-unicode-pg-"));
  const adapter = new PostgresJsonAdapter(dir, { connectionString: url.toString(), customersTableEnabled: true, outboxTableEnabled: true, processedMessagesTableEnabled: true });
  try {
    await adapter.ready;
    await assert.rejects(admin.query("SELECT $1::jsonb", [JSON.stringify({ adBody: "x".repeat(799) + "\ud83c..." })]), error => error.code === "22P02");
    const store = new JsonStore(dir, { adapter });
    const account = "unicode", id = "6739910888@s.whatsapp.net", sentAt = new Date().toISOString();
    const openingFlowsSent = { oats: { manual: true, sentAt } };
    await store.getOrCreateCustomer(id, { businessAccountId: account, productId: "oats", openingFlowsSent, openingFlowSentAt: sentAt, followupsSent: { day_2: sentAt } });
    await store.claimProcessedMessage("failed", account, { customerId: id });
    await store.failProcessedMessage("failed", account, "22P02");
    assert.equal((await store.claimProcessedMessage("failed", account)).claimed, false);
    assert.equal((await store.claimProcessedMessage("fresh", account)).claimed, true);
    const source = { adBody: "x".repeat(799) + "🌾 trailing", referralBody: "x".repeat(795) + "👨‍👩‍👧‍👦 trailing", text: "broken \ud83c", adId: "kept-ad", sourceUrl: "https://example.com/ad" };
    await store.getOrCreateCustomer(id, { businessAccountId: account, recordInbound: true, source });
    const saved = await store.getCustomer(id, account);
    assert.equal(saved.inboundCount, 1);
    assert.equal(saved.source.adBody, "x".repeat(799) + "...");
    assert.equal(saved.source.referralBody, "x".repeat(795) + "...");
    assert.equal(saved.source.text.isWellFormed(), true);
    assert.equal(saved.source.adId, source.adId);
    assert.equal(saved.leadSource.sourceUrl, source.sourceUrl);
    assert.deepEqual(saved.openingFlowsSent, openingFlowsSent);
    assert.equal(saved.followupsSent.day_2, sentAt);
    await store.appendOutbox({ id: "fresh", businessAccountId: account, from: id, direction: "inbound", body: "hi", source, meta: { source } });
    const message = (await store.listOutbox(account)).find(item => item.id === "fresh");
    assert.equal(message.source.adBody.isWellFormed(), true);
    assert.equal(message.meta.source.referralBody.isWellFormed(), true);
    await store.completeProcessedMessage("fresh", account);
    assert.equal((await store.getProcessedMessage("fresh", account)).processingStatus, "completed");
  } finally {
    await adapter.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
