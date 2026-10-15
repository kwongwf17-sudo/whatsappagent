import assert from "node:assert/strict";
import test from "node:test";
import { recordStageHistory, stageHistorySummary, stageHistoryKey } from "./customer_stage_history.mjs";
import { computeCustomerLabel } from "./store.mjs";

function fixture() {
  const docs = new Map(), records = new Map();let writes=0;
  const backend={read:async key=>structuredClone(docs.get(key)||null),write:async(key,value)=>{writes++;docs.set(key,structuredClone(value));},customers:async()=>[...records.values()]};
  const customer=(id,day,inbound=2)=>({id,businessAccountId:"A",firstSeenAt:`2026-10-${String(day).padStart(2,"0")}T04:00:00Z`,inboundCount:inbound,orderIds:[]});
  const observe=(date,changes=null,account="A")=>recordStageHistory(backend,account,new Date(date),computeCustomerLabel,changes);
  return {docs,records,customer,observe,writes:()=>writes};
}

test("daily counts reconcile calendar entrants, retained DAY 11+ and deletion without changing saved past reports",async()=>{
  const f=fixture();
  const older=f.customer("older",3),incoming=f.customer("incoming",5),unresponsive=f.customer("unresponsive",4,1);
  for(const c of [older,incoming,unresponsive])f.records.set(c.id,c);
  const before=await f.observe("2026-10-14T04:00:00Z");
  assert.equal(before.opening.day_11_plus_customer,1);assert.equal(before.opening.day_10_customer,1);assert.equal(before.opening.day_9_customer,1);
  const savedBefore=structuredClone(before);
  const next=await f.observe("2026-10-14T16:00:00Z");
  assert.equal(next.opening.day_10_customer,1);
  assert.equal(next.closing.day_10_customer,1);assert.equal(next.closing.delete_pending,1);
  assert.ok(next.movements.some(m=>m.customerId==="incoming"&&m.fromStage==="day_9_customer"&&m.toStage==="day_10_customer"));
  f.records.delete(unresponsive.id);
  const deleted=stageHistorySummary(await f.observe("2026-10-14T16:00:28Z",[{id:unresponsive.id,before:unresponsive,after:null,reason:"Automatic deletion: No customer reply by DAY 11"}]));
  assert.equal(deleted.reconciled,true);assert.equal(deleted.closing.delete_pending,0);
  assert.ok(deleted.movements.some(m=>m.customerId==="unresponsive"&&m.toStage===null&&m.reason.startsWith("Automatic deletion")));
  const past=f.docs.get(stageHistoryKey("A","2026-10-14"));
  assert.deepEqual(past.opening,savedBefore.opening);assert.deepEqual(past.closing,savedBefore.closing);assert.deepEqual(past.movements,savedBefore.movements);
  assert.ok(past.closedAt);assert.equal(deleted.partial,false);
  const count=deleted.movements.length;assert.equal((await f.observe("2026-10-15T04:00:00Z")).movements.length,count);
});

test("mutations record reasons, multiple same-day changes and account isolation; unchanged messages do not rewrite history",async()=>{
  const f=fixture();await f.observe("2026-10-15T04:00:00Z");
  let c=f.customer("customer",15);
  f.records.set(c.id,c);await f.observe("2026-10-15T04:01:00Z",[{id:c.id,before:null,after:c}]);
  const writes=f.writes();assert.equal(await f.observe("2026-10-15T04:02:00Z",[{id:c.id,before:c,after:{...c,inboundCount:3}}]),null);assert.equal(f.writes(),writes);
  const opted={...c,optedOut:true};await f.observe("2026-10-15T04:03:00Z",[{id:c.id,before:c,after:opted}]);
  const submitted={...c,orderIds:["order"]};await f.observe("2026-10-15T04:04:00Z",[{id:c.id,before:opted,after:submitted}]);
  const report=stageHistorySummary(f.docs.get(stageHistoryKey("A","2026-10-15")));
  assert.equal(report.reconciled,true);assert.equal(report.movements.length,3);
  assert.equal(report.movements[0].reason,"Customer created");assert.equal(report.movements[1].reason,"Customer opted out");assert.equal(report.movements[2].toStage,"done_customer");
  assert.equal(f.docs.has(stageHistoryKey("Other","2026-10-15")),false);
  assert.equal(new Set(report.movements.map(m=>m.id)).size,3);
});

test("first-day baselines and observation gaps are marked partial, with no invented intermediate reports",async()=>{
 const f=fixture();f.records.set("a",f.customer("a",5));
 assert.equal((await f.observe("2026-10-14T04:00:00Z")).partial,true);
 assert.equal((await f.observe("2026-10-17T04:00:00Z")).partial,true);
 assert.equal(f.docs.has(stageHistoryKey("A","2026-10-16")),false);
 assert.equal(await f.observe("2026-10-13T04:00:00Z"),null);
 await assert.rejects(f.observe("2026-10-13T04:00:00Z",[]),/backwards/);
});
