import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonStore } from "./store.mjs";
import { flushCustomerBufferBatch } from "./customer_buffer_batch.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "customer-batch-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("customer-batch-"));
    return rm(root, { recursive: true, force: true });
  });
  return { root, store: new JsonStore(root), inFlight: new Map(), scheduled: [] };
}
async function append(store, key, text) {
  return store.updatePendingBuffer(key, (r) => ({ ...r, type: "message_merge", businessAccountId: "A", customerId: "C",
    messages: [...(r?.messages || []), text], sources: [...(r?.sources || []), { text }], args: { text }, dueAt: new Date().toISOString() }));
}
function flush(f, key, processBatch) {
  return flushCustomerBufferBatch({ ...f, key, processBatch, schedule: r => f.scheduled.push(r), retryMs: 1000 });
}
test("new arrivals stay separate while one batch runs; overlapping flush does not replay", async t => {
  const f = await fixture(t); await append(f.store, "key", "$49 right?");
  let release, began; const started = new Promise(r => began = r), calls = [];
  const process = async batch => { calls.push(batch.messages); began(); await new Promise(r => release = r); };
  const first = flush(f, "key", process); await started;
  await append(f.store, "key", "Oke tq"); const second = flush(f, "key", process);
  release(); await Promise.all([first, second]);
  assert.deepEqual(calls, [["$49 right?"]]);
  assert.deepEqual((await f.store.getPendingBuffer("key")).messages, ["Oke tq"]);
  await flush(f, "key", async batch => calls.push(batch.messages));
  assert.deepEqual(calls, [["$49 right?"], ["Oke tq"]]);
  assert.equal(await f.store.getPendingBuffer("key"), null);
});
test("burst received before claim remains one merged batch", async t => {
  const f = await fixture(t); await append(f.store, "k", "one"); await append(f.store, "k", "two");
  const seen = []; await flush(f, "k", async b => seen.push(b.messages)); assert.deepEqual(seen, [["one", "two"]]);
});
test("restart recovers durable active batch before new arrivals", async t => {
  const f = await fixture(t); await f.store.savePendingBuffer("k", { messages: ["new"], processingBatch: { batchId: "saved", messages: ["active"], sources: [], args: {} } });
  const recovered = { ...f, store: new JsonStore(f.root), inFlight: new Map() }, seen = [];
  await flush(recovered, "k", async b => seen.push(b.messages));
  assert.deepEqual((await recovered.store.getPendingBuffer("k")).messages, ["new"]);
  await flush(recovered, "k", async b => seen.push(b.messages)); assert.deepEqual(seen, [["active"], ["new"]]);
});
test("failure keeps active batch and newer messages for retry", async t => {
  const f = await fixture(t); await append(f.store, "k", "active");
  await assert.rejects(flush(f, "k", async () => { await append(f.store, "k", "new"); throw Error("temporary"); }), /temporary/);
  const pending = await f.store.getPendingBuffer("k"); assert.deepEqual(pending.processingBatch.messages, ["active"]); assert.deepEqual(pending.messages, ["new"]);
  const seen = []; await flush(f, "k", async b => seen.push(b.messages)); await flush(f, "k", async b => seen.push(b.messages));
  assert.deepEqual(seen, [["active"], ["new"]]);
});
test("distinct customer/account keys process independently", async t => {
  const f = await fixture(t); await append(f.store, "A::C", "one"); await append(f.store, "B::C", "two");
  let release, began; const started = new Promise(r => began = r);
  const first = flush(f, "A::C", async () => { began(); await new Promise(r => release = r); }); await started;
  let otherDone = false; await flush(f, "B::C", async () => otherDone = true); assert.equal(otherDone, true); release(); await first;
});
