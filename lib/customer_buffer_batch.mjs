import { randomUUID } from "node:crypto";

// Keep the active batch durable, while new arrivals accumulate in messages/sources.
// The existing store write queue makes each claim/completion one mutation.
export async function flushCustomerBufferBatch({ key, store, inFlight, processBatch, schedule, retryMs = 10000 }) {
  if (inFlight.has(key)) return inFlight.get(key);
  const task = (async () => {
    const claimed = await store.updatePendingBuffer(key, (record) => {
      if (!record) return null;
      if (record.processingBatch) return record;
      if (!(record.messages || []).some(Boolean)) return null;
      return {
        ...record,
        messages: [], sources: [], messageIds: [], startedAt: null,
        processingBatch: { ...record, processingBatch: undefined, batchId: randomUUID() },
      };
    });
    const batch = claimed?.processingBatch;
    if (!batch) return;
    try {
      await processBatch(batch);
      await store.updatePendingBuffer(key, (record) => {
        if (!record || record.processingBatch?.batchId !== batch.batchId) return record;
        if (!(record.messages || []).some(Boolean)) return null;
        return { ...record, processingBatch: null };
      });
    } catch (error) {
      await store.updatePendingBuffer(key, (record) => record ? {
        ...record, dueAt: new Date(Date.now() + retryMs).toISOString(),
      } : null);
      throw error;
    }
  })();
  inFlight.set(key, task);
  try { return await task; }
  finally {
    if (inFlight.get(key) === task) inFlight.delete(key);
    const remaining = await store.getPendingBuffer(key);
    if (remaining) schedule(remaining);
  }
}
