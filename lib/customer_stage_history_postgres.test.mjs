import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {PostgresJsonAdapter} from "./postgres_adapter.mjs";
import {JsonStore} from "./store.mjs";
import {stageHistoryDate,stageHistoryKey} from "./customer_stage_history.mjs";

test("Postgres stage history commits with customer writes, survives restart and reconciles concurrent processes",{skip:!process.env.CUSTOMER_IDENTITY_TEST_DATABASE_URL},async t=>{
 const {Pool}=await import("pg");
 const base=process.env.CUSTOMER_IDENTITY_TEST_DATABASE_URL,admin=new Pool({connectionString:base});
 const schema=`stage_test_${process.pid}_${Date.now()}`;assert.match(schema,/^stage_test_\d+_\d+$/);
 await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(base);url.searchParams.set("options",`-c search_path=${schema}`);
 const dir=await mkdtemp(path.join(tmpdir(),"stage-pg-"));
 const options={connectionString:url.toString(),customersTableEnabled:true};
 const a=new PostgresJsonAdapter(dir,options);await a.ready;
 const b=new PostgresJsonAdapter(dir,options);
 try{
  await Promise.all([a.ready,b.ready]);
  const first=new JsonStore(dir,{adapter:a}),second=new JsonStore(dir,{adapter:b});
  const day=stageHistoryDate();
  await first.captureCustomerStageHistory(new Date(),"A");
  await t.test("concurrent independent adapters do not lose or duplicate movements",async()=>{
   await Promise.all(Array.from({length:8},(_,i)=>(i%2?first:second).getOrCreateCustomer(`67399010${String(i).padStart(2,"0")}@s.whatsapp.net`,{businessAccountId:"A",inboundCount:2})));
   const report=await second.getCustomerStageHistory(new Date(),"A");
   assert.equal(report.reconciled,true);assert.equal(report.closing.new_customer,8);assert.equal(report.movements.length,8);
   await first.captureCustomerStageHistory(new Date(),"A");assert.equal((await first.getCustomerStageHistory(new Date(),"A")).movements.length,8);
  });
  const id="6739901000@s.whatsapp.net";
  await t.test("history-write failure rolls back the customer mutation",async()=>{
   const before=await a.readCustomerStageHistory("A",day);
   await a.pool.query(`CREATE FUNCTION fail_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key = '${stageHistoryKey("A",day)}' THEN RAISE EXCEPTION 'stage history test failure'; END IF; RETURN NEW; END $$`);
   await a.pool.query("CREATE TRIGGER fail_history BEFORE INSERT OR UPDATE ON json_documents FOR EACH ROW EXECUTE FUNCTION fail_history()");
   await assert.rejects(first.updateCustomer(id,()=>({optedOut:true}),"A"),/stage history test failure/);
   assert.equal((await first.getCustomer(id,"A")).optedOut,undefined);
   assert.deepEqual(await a.readCustomerStageHistory("A",day),before);
   await a.pool.query("DROP TRIGGER fail_history ON json_documents");
  });
  await t.test("opt-out, order, automatic deletion and account isolation preserve reasons and totals",async()=>{
   await first.updateCustomer(id,()=>({optedOut:true}),"A");
   await second.updateCustomer("6739901001@s.whatsapp.net",()=>({orderIds:["order"]}),"A");
   await a.deleteCustomerRow("6739901002@s.whatsapp.net","A",{reason:"Automatic deletion: No customer reply by DAY 11"});
   await second.getOrCreateCustomer(id,{businessAccountId:"B"});
   const report=await first.getCustomerStageHistory(new Date(),"A");
   assert.equal(report.reconciled,true);assert.equal(report.closing.new_customer,5);assert.equal(report.closing.opted_out,1);assert.equal(report.closing.done_customer,1);
   assert.equal(report.movements.filter(m=>m.toStage===null).length,1);
   assert.ok(report.movements.some(m=>m.reason==="Order submitted"));
   assert.ok(report.movements.some(m=>m.reason==="Customer opted out"));
   assert.ok(report.movements.some(m=>m.reason.startsWith("Automatic deletion")));
   assert.equal((await second.getCustomerStageHistory(new Date(),"B")).closing.new_customer,1);
   assert.equal(await second.getCustomerStageHistory(new Date("2000-01-01T04:00:00Z"),"A"),null);
  });
 }finally{await a.close();await b.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
