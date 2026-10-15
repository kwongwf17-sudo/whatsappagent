import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { JsonStore } from "./store.mjs";
import { OperationsStore } from "./operations.mjs";
import { AdminAccountStore } from "./admin_accounts.mjs";
import { TeamContentStore } from "./team_content.mjs";
import { Script } from "node:vm";

test("real import HTTP routes map customer days, queue remaining messages and preserve existing records", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "import-http-"));
  const catalogPath = path.join(dir, "catalog.json");
  await writeFile(catalogPath, JSON.stringify({ default_product_id: "jc", products: [
    { id:"jc", name:"JointCare test", sku_code:"JC01", followup_schedule:[
      { key:"day_1_followup", label:"Day 1", timing_type:"fixed_time", day_offset:1, send_time:"08:15", message:"one" },
      { key:"custom_day_two", label:"Day 2", timing_type:"fixed_time", day_offset:2, send_time:"08:30", message:"two" },
      { key:"day_3_followup", label:"Day 3", timing_type:"fixed_time", day_offset:3, send_time:"08:45", message:"three" },
    ] },
    { id:"legacy", name:"Legacy gap", sku_code:"LG01", followups:{
      first_day_followup:{day_offset:0,send_hour:20,message:"first"},
      day_1_followup:{day_offset:1,send_hour:20,message:"one"},
      day_3_followup:{day_offset:3,send_hour:20,message:"three"},
    } },
  ] }));
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, [path.resolve("server.mjs")], { stdio:["ignore","pipe","pipe"], env:{
    ...process.env, DEMO_MODE:"true", WHATSAPP_TRANSPORT:"demo", WHATSAPP_STORE:"json", WHATSAPP_DATA_DIR:dir,
    PRODUCT_CATALOG_PATH:catalogPath, PORT:String(port), ACCOUNT_ID:"import-test", ADMIN_PASSWORD:"import-test-password",
    ADMIN_SESSION_SECRET:"import-test-only-secret", FOLLOWUP_AUTORUN:"false", WHATSAPP_SKIP_HTTP:"false",
    OPENAI_API_KEY:"", OPENAI_VECTOR_STORE_ID:"", DATABASE_URL:"", WHATSAPP_POSTGRES_URL:"",
    ADMIN_WHATSAPP_NUMBER:"", WHATSAPP_WEB_SESSION_DIR:path.join(dir,"sessions"), WHATSAPP_ASSETS_DIR:path.join(dir,"assets"),
  } });
  let output = "";
  child.stdout.on("data", d => { output += d; });
  child.stderr.on("data", d => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for(let attempt=0;attempt<100;attempt++) {
      if(child.exitCode!==null) throw new Error(`Test server exited: ${output}`);
      try { const response=await fetch(`${base}/health`,{signal:AbortSignal.timeout(500)}); if(response.ok){ready=true;break;} } catch {}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(ready,`Isolated test server did not start: ${output}`);
    const login=await fetch(`${base}/admin/login`,{method:"POST",redirect:"manual",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({accountId:"import-test",password:"import-test-password"})});
    assert.equal(login.status,303);
    let cookie=login.headers.get("set-cookie").split(";")[0];
    async function request(route,body) {
      const response=await fetch(`${base}${route}`,{method:body?"POST":"GET",headers:{cookie,"content-type":"application/json"},body:body?JSON.stringify(body):undefined});
      const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
    }
    const options=await request("/admin/customer-import-data");
    assert.deepEqual(options.stages.map(s=>s.label),["NEW",...Array.from({length:10},(_,i)=>`DAY ${i+1}`)]);
    const body={mode:"continue_followups",currentStageKey:"__customer_day_2__",rows:"6739900001,JC01"};
    const preview=await request("/admin/customer-import/preview",body);
    assert.equal(preview.valid,1);assert.equal(preview.rows[0].currentStageLabel,"DAY 2");
    const stale=await request("/admin/customer-import/preview",{...body,currentStageKey:"day_3_followup"});
    assert.equal(stale.valid,0);assert.match(stale.rows[0].errors.join(" "),/Refresh/);
    const result=await request("/admin/customer-import/run",body);
    assert.equal(result.created,1);assert.equal(result.followupRowsQueued,2);
    const store=new JsonStore(dir), operations=new OperationsStore(dir);
    const c=await store.getCustomer("6739900001@s.whatsapp.net","import-test");
    assert.equal(c.importJourney.startingDay,2);assert.equal(c.importStageLabelDisplay,"DAY 2");
    assert.ok(c.followupsSent.day_1_followup);assert.equal(c.followupsSent.custom_day_two,undefined);
    const queue=await operations.listFollowupQueue("import-test");
    const day2=queue.find(q=>q.followupKey==="custom_day_two"),day3=queue.find(q=>q.followupKey==="day_3_followup");
    const localDate=value=>new Date(value).toLocaleDateString("en-CA",{timeZone:"Asia/Kuala_Lumpur"});
    assert.equal(localDate(day2.dueAt),localDate(c.importedAt));
    assert.ok(Date.parse(day3.dueAt)>Date.parse(day2.dueAt));
    assert.ok(Date.parse(day3.dueAt)-Date.parse(c.importedAt)<48*3600000);
    assert.equal((await store.listCustomers(new Date(),"import-test"))[0].labelDisplay,"DAY 2");
    const pastDashboard=await request("/admin/dashboard-data?date=2000-01-01");
    assert.equal(pastDashboard.customers.find(row=>row.id===c.id).labelDisplay,"DAY 2");
    assert.equal(pastDashboard.customerStageHistory,null);
    const today=localDate(c.importedAt);
    const currentDashboard=await request("/admin/dashboard-data?date="+today);
    assert.equal(currentDashboard.customerStageHistory.reconciled,true);
    assert.ok(currentDashboard.customerStageHistory.movements.some(m=>m.customerId===c.id&&m.reason==="Customer imported"));
    const oldId="6739900022@s.whatsapp.net";
    await store.getOrCreateCustomer(oldId,{businessAccountId:"import-test",productId:"jc",firstSeenAt:new Date(Date.now()-20*86400000).toISOString(),inboundCount:2});
    const aged=await request("/admin/dashboard-data?date=2000-01-01");
    assert.equal(aged.customers.find(row=>row.id===oldId).labelDisplay,"DAY 11+");
    await request("/admin/customer/delete",{customerId:oldId,reason:"History test manual deletion"});
    const afterDelete=await request("/admin/dashboard-data?date="+today);
    assert.equal(afterDelete.customers.some(row=>row.id===oldId),false);
    assert.equal(afterDelete.customerStageHistory.reconciled,true);
    assert.ok(afterDelete.customerStageHistory.movements.some(m=>m.customerId===oldId&&m.toStage===null&&m.reason==="History test manual deletion"));
    const html=await (await fetch(base+"/admin/dashboard",{headers:{cookie}})).text();
    assert.match(html,/Stage History/);assert.match(html,/DAY 11\+/);assert.doesNotMatch(html,/labels\.push\("DELETE"\)/);
    for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Script(script[1]);
    // A matched LID/reimport must not restart history, reactivate opt-outs or rewrite a queue.
    await store.getOrCreateCustomer("123456789@lid",{businessAccountId:"import-test",phone:"6739900001",optedOut:true});
    const beforeCustomer=await readFile(path.join(dir,"customers.json"),"utf8");
    const beforeQueue=await readFile(path.join(dir,"followup_dispatch_queue.json"),"utf8");
    const reimport=await request("/admin/customer-import/run",body);
    assert.equal(reimport.created,0);assert.equal(reimport.updated,0);assert.equal(reimport.skipped,1);
    assert.equal(await readFile(path.join(dir,"customers.json"),"utf8"),beforeCustomer);
    assert.equal(await readFile(path.join(dir,"followup_dispatch_queue.json"),"utf8"),beforeQueue);
    // Follow-up settings are shared across products in an account. Use another
    // isolated account with only a legacy sequence to exercise an actual missing-day case.
    await new AdminAccountStore(dir).ensureInitialAccount({id:"legacy-test",name:"Legacy test",password:"legacy-test-password"});
    const legacyCatalog={default_product_id:"legacy",products:JSON.parse(await readFile(catalogPath,"utf8")).products.filter(p=>p.id==="legacy")};
    await new TeamContentStore(dir).saveContent("legacy-test",{catalog:legacyCatalog});
    const legacyLogin=await fetch(`${base}/admin/login`,{method:"POST",redirect:"manual",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({accountId:"legacy-test",password:"legacy-test-password"})});
    assert.equal(legacyLogin.status,303);cookie=legacyLogin.headers.get("set-cookie").split(";")[0];
    const gap=await request("/admin/customer-import/run",{...body,rows:"6739900001,LG01"});
    assert.equal(gap.created,1);assert.equal(gap.followupRowsQueued,1);
    const legacy=await store.getCustomer("6739900001@s.whatsapp.net","legacy-test");
    assert.equal(legacy.importStageLabelDisplay,"DAY 2");assert.equal(legacy.followupsSent.day_3_followup,undefined);
    const gapQueue=(await operations.listFollowupQueue("legacy-test")).find(q=>q.customerId===legacy.id);
    assert.equal(gapQueue.followupKey,"day_3_followup");
    assert.notEqual(localDate(gapQueue.dueAt),localDate(legacy.importedAt));
    const isolated=await request("/admin/dashboard-data?date="+today);
    assert.equal(isolated.customerStageHistory.businessAccountId,"legacy-test");
    assert.equal(isolated.customerStageHistory.movements.some(m=>m.customerId===oldId),false);
  } finally {
    const stopped=once(child,"close");child.kill();await stopped;
  }
});
