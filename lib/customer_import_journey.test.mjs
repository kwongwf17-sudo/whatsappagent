import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonStore, computeCustomerLabel } from "./store.mjs";
import {
  CUSTOMER_IMPORT_NEW_STAGE_KEY, customerImportStages, customerImportStageDay,
  createImportJourney, importedFollowupHistory, importedFollowupDueAt, importedJourneyAgeDays,
} from "./customer_import_journey.mjs";

const importedAt = "2026-10-10T01:00:00.000Z"; // 09:00 Malaysia time.
const key = day => day === 0 ? CUSTOMER_IMPORT_NEW_STAGE_KEY : `__customer_day_${day}__`;
function customer(day, extra = {}) {
  return { id: "6739900001@s.whatsapp.net", businessAccountId: "JointCare", productId: "jc", importedCustomer: true,
    importedAt, firstSeenAt: importedAt, openingFlowSentAt: importedAt, orderIds: [], inboundCount: 0,
    importStageLabelDisplay: day === 0 ? "NEW" : `DAY ${day}`, importJourney: createImportJourney(key(day), "jc", importedAt), ...extra };
}
const fixed = (day, hour = 10, minute = 0, followupKey = `day_${day}`) => ({ key: followupKey, dayOffset: day, sendHour: hour, sendMinute: minute, customSchedule: true, timingType: "fixed_time" });

test("import dropdown stages are customer days, independent of message positions and custom keys", () => {
  assert.deepEqual(customerImportStages().map(s => s.label), ["NEW", ...Array.from({length:10}, (_,i)=>`DAY ${i+1}`)]);
  for (let day = 0; day <= 10; day++) assert.equal(customerImportStageDay(key(day)), day);
  assert.equal(customerImportStageDay("day_3_followup"), null);
  assert.equal(customerImportStageDay("custom_followup_1791964936746"), null);
  assert.equal(customerImportStageDay("__customer_day_11__"), null);
});

test("all starting days share a label, deletion and remaining-message clock", () => {
  for (let day = 0; day <= 10; day++) {
    const c = customer(day);
    assert.equal(importedJourneyAgeDays(c, new Date(importedAt)), day);
    assert.equal(computeCustomerLabel(c, new Date(importedAt)), day === 0 ? "new_customer" : `day_${day}_customer`);
    assert.equal(importedFollowupDueAt(c, fixed(day)).toISOString(), "2026-10-10T02:00:00.000Z");
    assert.equal(importedFollowupDueAt(c, fixed(day + 1)).toISOString(), "2026-10-11T02:00:00.000Z");
  }
});

test("DAY 2 skips configured earlier days and preserves custom Day 2 and later messages", () => {
  const sequence = [fixed(1), fixed(2,8,30,"custom_day_two"), fixed(2,17,0,"second_day_two"), fixed(3)];
  const sent = importedFollowupHistory(null, sequence, key(2), importedAt);
  assert.deepEqual(sent, {day_1:importedAt});
  const existing = {followupsSent:{custom_day_two:"2026-10-09T02:00:00Z"}};
  assert.equal(importedFollowupHistory(existing,sequence,key(2),importedAt).custom_day_two,existing.followupsSent.custom_day_two);
});

test("a missing Day 2 message does not turn the Day 3 message into Day 2", () => {
  const sequence = [fixed(0),fixed(1),fixed(3)];
  assert.deepEqual(importedFollowupHistory(null,sequence,key(2),importedAt),{day_0:importedAt,day_1:importedAt});
  assert.equal(importedFollowupDueAt(customer(2),sequence[2]).toISOString(),"2026-10-11T02:00:00.000Z");
});

test("already-passed selected-day slots become due at import for normal paced sending", () => {
  assert.equal(importedFollowupDueAt(customer(9),fixed(9,8,30)).toISOString(),importedAt);
  assert.equal(importedFollowupDueAt(customer(9),fixed(10,8,45)).toISOString(),"2026-10-11T00:45:00.000Z");
});

test("elapsed-time schedules use their configured duration, not list position or message name", () => {
  const early = { ...fixed(9), timingType:"delay_after_opening", delayMinutes:180 };
  const remaining = { ...fixed(0), key:"custom_49_hours", timingType:"delay_after_opening", delayMinutes:49*60 };
  assert.deepEqual(importedFollowupHistory(null,[early,remaining],key(2),importedAt),{day_9:importedAt});
  assert.equal(importedFollowupDueAt(customer(2),remaining).toISOString(),"2026-10-10T02:00:00.000Z");
});

test("legacy imports and customers without the new journey marker retain existing clocks", () => {
  const legacy = customer(9);delete legacy.importJourney;
  assert.equal(importedJourneyAgeDays(legacy,new Date("2026-10-12T01:00:00Z")),null);
  assert.equal(importedFollowupDueAt(legacy,fixed(10)),null);
  assert.equal(computeCustomerLabel(legacy,new Date("2026-10-12T01:00:00Z")),"day_11_plus_customer");
});

test("fresh ad reentry and product changes supersede the import clock", () => {
  const c = customer(9,{freshAdJourney:{active:true,productId:"jc",startedAt:"2026-10-12T01:00:00Z"}});
  assert.equal(importedJourneyAgeDays(c,new Date("2026-10-12T01:00:00Z")),null);
  assert.equal(importedFollowupDueAt(c,fixed(10)),null);
  assert.equal(computeCustomerLabel(c,new Date("2026-10-12T01:00:00Z")),"new_customer");
  assert.equal(importedFollowupDueAt(customer(9,{productId:"other"}),fixed(10)),null);
  assert.equal(importedFollowupDueAt(customer(9,{productJourneyResetAt:"2026-10-12T01:00:00Z"}),fixed(10)),null);
});

test("DAY 9 import expires on logical DAY 11 only under existing no-reply and no-order conditions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(),"import-clock-"));
  const store = new JsonStore(dir);
  await store.getOrCreateCustomer(customer(9).id,customer(9));
  await store.getOrCreateCustomer("6739900002@s.whatsapp.net",customer(9,{id:"6739900002@s.whatsapp.net",inboundCount:2}));
  await store.getOrCreateCustomer("6739900003@s.whatsapp.net",customer(9,{id:"6739900003@s.whatsapp.net",orderIds:["order"]}));
  const legacy = customer(9,{id:"6739900004@s.whatsapp.net"});delete legacy.importJourney;
  await store.getOrCreateCustomer(legacy.id,legacy);
  assert.equal((await store.deleteStaleUnresponsiveCustomers(new Date("2026-10-11T01:00:00Z"))).length,0);
  const deleted = await store.deleteStaleUnresponsiveCustomers(new Date("2026-10-12T01:00:00Z"));
  assert.deepEqual(deleted.map(c=>c.id),[customer(9).id]);
  assert.equal((await store.listDeletedCustomers("JointCare")).length,1);
  assert.equal((await store.listCustomers(new Date("2026-10-12T01:00:00Z"),"JointCare")).length,3);
});

test("legacy first-day gates do not postpone a selected-day imported follow-up", async () => {
  const dir = await mkdtemp(path.join(tmpdir(),"import-followups-"));
  const store = new JsonStore(dir);
  const c = customer(9,{followupsSent:{first_day_followup:importedAt}});
  await store.getOrCreateCustomer(c.id,c);
  const catalog = {products:[{id:"jc",followups:{first_day_followup:{day_offset:0,send_hour:20,message:"first"},day_9:{day_offset:9,send_hour:10,message:"nine"},day_10:{day_offset:10,send_hour:10,message:"ten"}}}]};
  const due = await store.getDueFollowups(catalog,new Date("2026-10-10T02:00:00Z"));
  assert.equal(due.length,1);assert.equal(due[0].followupKey,"day_9");
});
