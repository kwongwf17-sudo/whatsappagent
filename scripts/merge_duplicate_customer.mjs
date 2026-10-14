import path from 'node:path';
import { Pool } from 'pg';
import { PostgresJsonAdapter } from '../lib/postgres_adapter.mjs';
import { mergeCustomerState, storedCustomerPhone } from '../lib/customer_identity.mjs';

// Read-only preview by default. Apply one explicitly selected pair, never a bulk merge.
const option=name=>process.argv.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3) || '';
const account=option('account'), targetId=option('target'), duplicateId=option('duplicate');
if(!account || !targetId || !duplicateId) throw new Error('Usage: node scripts/merge_duplicate_customer.mjs --account=ACCOUNT --target=ID --duplicate=ID [--apply]');
const url=new URL(process.env.DATABASE_URL || process.env.WHATSAPP_POSTGRES_URL);
if(process.env.POSTGRES_PROXY_HOST) {url.hostname=process.env.POSTGRES_PROXY_HOST;url.port=process.env.POSTGRES_PROXY_PORT || url.port;}
url.searchParams.set('sslmode','disable');
const pool=new Pool({connectionString:url.toString()});
const customersTable=process.env.WHATSAPP_CUSTOMERS_TABLE || 'customers';
if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(customersTable)) throw new Error('Invalid customer table name');
let adapter;
try {
 const rows=(await pool.query(`SELECT payload FROM ${customersTable} WHERE business_account_id=$1 AND customer_id=ANY($2::text[])`,[account,[targetId,duplicateId]])).rows.map(r=>r.payload);
 const target=rows.find(c=>c.id===targetId), duplicate=rows.find(c=>c.id===duplicateId);
 if(target && !duplicate && target.identityAliases?.includes(duplicateId)) {
   console.log(JSON.stringify({status:'already_merged',account,targetId,duplicateId}));
 } else {
   const merged=mergeCustomerState(target,duplicate);
   console.log(JSON.stringify({mode:process.argv.includes('--apply')?'apply':'preview',account,targetId,duplicateId,phone:storedCustomerPhone(merged),orderIds:merged.orderIds,followupsSent:merged.followupsSent,queueTimes:'preserved',storage:Object.fromEntries(['CUSTOMERS','FOLLOWUP_QUEUE','OUTBOX','ORDERS','PENDING_BUFFERS','OPERATIONAL_EVENTS','PROCESSED_MESSAGES','AUDIT_EVENTS'].map(k=>[k,process.env[`WHATSAPP_${k}_TABLE_ENABLED`] || 'false']))},null,2));
   if(process.argv.includes('--apply')) {
     if(process.env.WHATSAPP_CUSTOMERS_TABLE_ENABLED!=='true' || process.env.WHATSAPP_FOLLOWUP_QUEUE_TABLE_ENABLED!=='true') throw new Error('Live repair requires enabled Postgres customer and follow-up tables.');
     adapter=new PostgresJsonAdapter(path.resolve('tmp/customer-merge'),{connectionString:url.toString()});
     await adapter.mergeCustomerRecords(targetId,duplicateId,account);
     console.log(JSON.stringify({status:'merged',account,targetId,duplicateId,queueTimes:'preserved'}));
   }
 }
} finally {await adapter?.close();await pool.end();}
