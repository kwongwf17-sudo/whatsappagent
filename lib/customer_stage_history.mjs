import { randomUUID } from "node:crypto";

const zone = process.env.BUSINESS_TIME_ZONE || "Asia/Kuala_Lumpur";
export function stageHistoryDate(value = new Date()) {
  return new Date(value).toLocaleDateString("en-CA", { timeZone: zone });
}
export function stageHistoryKey(account, date = "state") {
  return `customer_stage_history_${Buffer.from(account).toString("base64url")}_${date}`;
}
export function stageChangeReason(before, after) {
  if (!before) return after?.importedCustomer ? "Customer imported" : "Customer created";
  if (!after) return "Customer removed";
  if ((after.orderIds || []).length && !(before.orderIds || []).length) return "Order submitted";
  if (Boolean(before.optedOut) !== Boolean(after.optedOut)) return after.optedOut ? "Customer opted out" : "Customer opted back in";
  if (before.productId !== after.productId) return "Product changed";
  if (before.freshAdJourney?.startedAt !== after.freshAdJourney?.startedAt || before.productJourneyResetAt !== after.productJourneyResetAt) return "Customer journey restarted or completed";
  return "Customer state updated";
}

// The backend owns serialization/transactions. Only stage changes write history;
// normal messages that leave the stage unchanged do not append events.
export async function recordStageHistory(backend, account, now, classify, changes = null) {
  const at = new Date(now).toISOString(), date = stageHistoryDate(now);
  const stateKey = stageHistoryKey(account);
  let state = await backend.read(stateKey);
  let report, dirty = false;
  const stage = customer => customer ? classify(customer, new Date(now)) : null;
  const snapshotBeforeChanges = async () => {
    const records = new Map((await backend.customers()).map(c => [c.id, c]));
    for (const change of changes || []) {
      if (change.before) records.set(change.id, change.before);
      else records.delete(change.id);
    }
    return Object.fromEntries([...records].map(([id, c]) => [id, stage(c)]));
  };
  const counts = stages => {
    const result = {};
    for (const value of Object.values(stages)) result[value] = (result[value] || 0) + 1;
    return result;
  };
  if (!state) {
    state = { version: 1, businessAccountId: account, date, stages: await snapshotBeforeChanges(), startedAt: at };
    report = { version: 1, businessAccountId: account, date, baselineAt: at, partial: true, opening: counts(state.stages), closing: counts(state.stages), movements: [] };
    dirty = true;
  } else if (date < state.date) {
    if (changes === null) return null; // A delayed observation must not rewind a newer day.
    throw new Error("Stage history cannot be written backwards in time.");
  } else if (state.date !== date) {
    const previous = await backend.read(stageHistoryKey(account, state.date));
    if (previous) {
      previous.closedAt = at;
      await backend.write(stageHistoryKey(account, state.date), previous);
    }
    const consecutive = Date.parse(date) - Date.parse(state.date) === 86400000;
    report = { version: 1, businessAccountId: account, date, baselineAt: at, partial: !consecutive, opening: counts(state.stages), closing: counts(state.stages), movements: [] };
    state.date = date;
    dirty = true;
    // Record calendar progression before applying the triggering customer mutation.
    const before = await snapshotBeforeChanges();
    for (const id of new Set([...Object.keys(state.stages), ...Object.keys(before)])) {
      move(id, before[id] || null, consecutive ? "Business date advanced" : "Reconciled after a gap in observations");
    }
  } else {
    if (changes && changes.every(change => (state.stages[change.id] || null) === stage(change.before) && stage(change.before) === stage(change.after))) return null;
    report = await backend.read(stageHistoryKey(account, date));
    if (!report) throw new Error("Customer stage history report is missing.");
  }
  function move(id, toStage, reason) {
    const fromStage = state.stages[id] || null;
    if (fromStage === toStage) return;
    report.movements.push({ id: randomUUID(), customerId: id, fromStage, toStage, occurredAt: at, reason });
    if (fromStage) report.closing[fromStage] = (report.closing[fromStage] || 0) - 1;
    if (toStage) { report.closing[toStage] = (report.closing[toStage] || 0) + 1; state.stages[id] = toStage; }
    else delete state.stages[id];
    dirty = true;
  }
  if (changes === null) {
    const current = Object.fromEntries((await backend.customers()).map(c => [c.id, stage(c)]));
    for (const id of new Set([...Object.keys(state.stages), ...Object.keys(current)])) {
      move(id, current[id] || null, !current[id] ? "Reconciled customer removal" : !state.stages[id] ? "Reconciled customer addition" : "Calendar progression or reconciled customer state");
    }
  } else {
    for (const change of changes) {
      // Account for age progression since the last observation, then the mutation.
      if (change.before) move(change.id, stage(change.before), "Business date advanced");
      move(change.id, stage(change.after), change.reason || stageChangeReason(change.before, change.after));
    }
  }
  if (dirty) {
    state.observedAt = at;
    report.observedAt = at;
    await backend.write(stateKey, state);
    await backend.write(stageHistoryKey(account, date), report);
  }
  return report;
}

export function stageHistorySummary(report) {
  if (!report) return null;
  const stages = new Set([...Object.keys(report.opening), ...Object.keys(report.closing)]);
  const rows = [...stages].map(stage => {
    const entered = report.movements.filter(m => m.toStage === stage).length;
    const exited = report.movements.filter(m => m.fromStage === stage).length;
    const opening = report.opening[stage] || 0, closing = report.closing[stage] || 0;
    return { stage, opening, entered, exited, closing, reconciled: opening + entered - exited === closing };
  });
  return { ...report, stages: rows, reconciled: rows.every(row => row.reconciled) };
}
