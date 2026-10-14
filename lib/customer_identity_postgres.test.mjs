import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgresJsonAdapter } from './postgres_adapter.mjs';
import { JsonStore } from './store.mjs';

// Opt-in integration test. Every table and fixture lives in an isolated temporary schema.
test('Postgres identity matching and transactional duplicate merge', {skip:!process.env.CUSTOMER_IDENTITY_TEST_DATABASE_URL}, async t=>{
 const {Pool}=await import('pg');
 const base=process.env.CUSTOMER_IDENTITY_TEST_DATABASE_URL;
 const admin=new Pool({connectionString:base});
 const schema=`identity_test_${process.pid}_${Date.now()}`;
 assert.match(schema,/^identity_test_\d+_\d+$/);
 await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(base);url.searchParams.set('options',`-c search_path=${schema}`);
 const dir=await mkdtemp(path.join(tmpdir(),'identity-pg-'));
 const adapter=new PostgresJsonAdapter(dir,{connectionString:url.toString(),customersTableEnabled:true,ordersTableEnabled:true,outboxTableEnabled:true,
   followupQueueTableEnabled:true,processedMessagesTableEnabled:true,pendingBuffersTableEnabled:true,operationalEventsTableEnabled:true,auditEventsTableEnabled:true});
 try {
  await adapter.ready;
  const store=new JsonStore(dir,{adapter});
  await t.test('phone and LID resolve to imported customer; aliases persist across store instances',async()=>{
   const a=await store.getOrCreateCustomer('6731111111@s.whatsapp.net',{businessAccountId:'A',phone:'6731111111'});
   const b=await store.getOrCreateCustomer('111@lid',{businessAccountId:'A',source:{phone:'6731111111'}});
   assert.equal(a.id,b.id);
   assert.equal(await new JsonStore(dir,{adapter}).resolveCustomerIdentity('111@lid','A'),a.id);
   assert.equal((await store.getOrCreateCustomer('111@lid',{businessAccountId:'B',phone:'6731111111'})).id,'111@lid');
   await store.updateCustomer('111@lid',()=>({optedOut:true}),'A');
   assert.equal((await store.getCustomer(a.id,'A')).optedOut,true);
  });
  await t.test('simultaneous first contacts reserve one canonical identity',async()=>{
   const resolved=await Promise.all([adapter.resolveCustomerIdentity('222@lid','C',{phone:'6732222222'}),adapter.resolveCustomerIdentity('6732222222@s.whatsapp.net','C')]);
   assert.equal(resolved[0],resolved[1]);
  });
  const target='6737326455@s.whatsapp.net', duplicate='125847323324420@lid',account='JointCare';
  const seed={businessAccountId:account,phone:'6737326455',productId:'jointcare',label:'day_4_customer',firstSeenAt:'2026-10-10T00:00:00Z',lastMessageAt:'2026-10-14T00:00:00Z',orderIds:[],followupsSent:{}};
  await adapter.upsertCustomerRow({...seed,id:target,followupsSent:{day_2:'2026-10-14T09:24:30Z'}});
  await adapter.upsertCustomerRow({...seed,id:duplicate,orderIds:['order_duplicate'],followupsSent:{first_day_followup:'2026-10-14T13:29:00Z'}});
  await adapter.upsertCustomerRow({...seed,businessAccountId:'Other',id:duplicate});
  await adapter.addOrderRow({id:'order_duplicate',businessAccountId:account,customerId:duplicate,status:'submitted'});
  await adapter.appendOutboxMessages([{id:'message_duplicate',businessAccountId:account,from:duplicate,to:'agent',direction:'inbound',body:'hello',createdAt:'2026-10-14T00:00:00Z'}]);
  await adapter.enqueueFollowupDispatches([
   {businessAccountId:account,customerId:target,followupKey:'day_5',dueAt:'2026-10-15T12:00:00Z'},
   {businessAccountId:account,customerId:duplicate,followupKey:'day_5',dueAt:'2026-10-15T12:00:00Z'},
   {businessAccountId:account,customerId:duplicate,followupKey:'day_2',dueAt:'2026-10-14T12:00:00Z'},
  ]);
  await adapter.pool.query(`INSERT INTO operational_events(category,id,business_account_id,customer_id,payload) VALUES('complaint','complaint1',$1,$2,$3::jsonb)`,[account,duplicate,JSON.stringify({businessAccountId:account,customerId:duplicate})]);
  await adapter.pool.query(`INSERT INTO processed_messages(business_account_id,message_id,payload) VALUES($1,'processed1',$2::jsonb)`,[account,JSON.stringify({businessAccountId:account,customerId:duplicate})]);
  await adapter.writeJson(path.join(dir,'complaint_cases.json'),{cases:[{businessAccountId:account,customerId:duplicate},{businessAccountId:'Other',customerId:duplicate}]});
  await t.test('merge refuses in-flight sends and rolls back without removing orders',async()=>{
   await adapter.pool.query(`UPDATE followup_dispatch_queue_rows SET status='processing' WHERE customer_id=$1 AND followup_key='day_5'`,[duplicate]);
   await assert.rejects(store.mergeCustomerRecords(target,duplicate,account),/being sent/);
   assert.equal((await adapter.pool.query(`SELECT count(*)::int AS n FROM customers WHERE business_account_id=$1`,[account])).rows[0].n,2);
   assert.equal((await adapter.pool.query(`SELECT customer_id FROM orders WHERE id='order_duplicate'`)).rows[0].customer_id,duplicate);
   await adapter.pool.query(`UPDATE followup_dispatch_queue_rows SET status='queued' WHERE customer_id=$1`,[duplicate]);
  });
  await t.test('merge preserves orders, history and due times; removes duplicate queue entries and blocks sent repeats',async()=>{
   const merged=await store.mergeCustomerRecords(target,duplicate,account);
   assert.equal(merged.followupsSent.first_day_followup,'2026-10-14T13:29:00Z');
   assert.equal(merged.followupsSent.day_2,'2026-10-14T09:24:30.000Z');
   assert.deepEqual(merged.orderIds,['order_duplicate']);
   assert.equal((await adapter.pool.query(`SELECT count(*)::int AS n FROM customers WHERE business_account_id=$1`,[account])).rows[0].n,1);
   assert.equal((await adapter.pool.query(`SELECT customer_id,payload FROM orders WHERE id='order_duplicate'`)).rows[0].customer_id,target);
   const message=(await adapter.pool.query(`SELECT customer_id,payload FROM outbox_messages WHERE id='message_duplicate'`)).rows[0];
   assert.equal(message.customer_id,target);assert.equal(message.payload.from,target);assert.equal(message.payload.body,'hello');
   const queue=(await adapter.pool.query(`SELECT * FROM followup_dispatch_queue_rows ORDER BY followup_key`)).rows;
   assert.equal(queue.length,2);assert.equal(queue[0].status,'sent');assert.equal(queue[1].status,'cancelled');
   assert.equal(queue[1].due_at.toISOString(),'2026-10-15T12:00:00.000Z');
   assert.equal(queue[1].dispatch_key,`${account}:${target}:day_5`);
   assert.equal((await adapter.pool.query(`SELECT customer_id FROM operational_events WHERE id='complaint1'`)).rows[0].customer_id,target);
   assert.equal((await adapter.pool.query(`SELECT payload FROM processed_messages WHERE message_id='processed1'`)).rows[0].payload.customerId,target);
   const complaints=await adapter.readJson(path.join(dir,'complaint_cases.json'),{});
   assert.equal(complaints.cases[0].customerId,target);assert.equal(complaints.cases[1].customerId,duplicate);
   assert.equal((await store.getCustomer(duplicate,account)).id,target);
   assert.equal((await store.getCustomer(duplicate,'Other')).id,duplicate);
   assert.equal(await store.resolveCustomerIdentity(duplicate,account),target);
   await assert.rejects(adapter.upsertCustomerRow({...seed,id:duplicate}),/identity changed/);
   assert.equal((await adapter.pool.query(`SELECT count(*)::int AS n FROM json_documents WHERE key LIKE 'customer_merge_backup_%'`)).rows[0].n,1);
   assert.deepEqual(await store.mergeCustomerRecords(target,duplicate,account),merged);
   await assert.rejects(adapter.upsertCustomerRow({...seed,id:target}),/merged during processing/);
   await adapter.enqueueFollowupDispatches([{businessAccountId:account,customerId:duplicate,followupKey:'day_2'}]);
   assert.equal((await adapter.pool.query(`SELECT count(*)::int AS n FROM followup_dispatch_queue_rows WHERE customer_id=$1`,[duplicate])).rows[0].n,0);
  });
  await t.test('pending buffers block repair; orderless merge retains queued times and aliases cannot recreate queues',async()=>{
   const a='6733333333@s.whatsapp.net',b='333@lid';
   const c={...seed,businessAccountId:'D',phone:'6733333333',orderIds:[]};
   await adapter.upsertCustomerRow({...c,id:a});await adapter.upsertCustomerRow({...c,id:b});
   await adapter.enqueueFollowupDispatches([{businessAccountId:'D',customerId:a,followupKey:'day_5',dueAt:'2026-10-15T12:00:00Z'}]);
   await adapter.pool.query(`INSERT INTO pending_buffers(key,business_account_id,customer_id,type) VALUES('buffer','D',$1,'message_merge')`,[b]);
   await assert.rejects(store.mergeCustomerRecords(a,b,'D'),/pending message buffers/);
   await adapter.pool.query(`DELETE FROM pending_buffers WHERE key='buffer'`);
   await store.mergeCustomerRecords(a,b,'D');
   await adapter.enqueueFollowupDispatches([{businessAccountId:'D',customerId:b,followupKey:'day_5',dueAt:'2026-10-15T01:15:00Z'}]);
   const queue=(await adapter.pool.query(`SELECT * FROM followup_dispatch_queue_rows WHERE business_account_id='D'`)).rows;
   assert.equal(queue.length,1);assert.equal(queue[0].status,'queued');
   assert.equal(queue[0].due_at.toISOString(),'2026-10-15T12:00:00.000Z');
   assert.equal(queue[0].customer_id,a);
  });
 } finally {
  await adapter.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
 }
});
