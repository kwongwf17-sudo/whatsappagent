import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonStore } from './store.mjs';
import { customerIdentity, mergeCustomerState, rekeyCustomerReferences } from './customer_identity.mjs';

test('matching links imported phone JID, bare phone and LID within one account and survives restart', async () => {
 const dir=await mkdtemp(path.join(tmpdir(),'identity-test-'));
 let store=new JsonStore(dir);
 const imported=await store.getOrCreateCustomer('6737326455@s.whatsapp.net',{businessAccountId:'JointCare',phone:'6737326455',followupsSent:{day_1:'2026-10-13T12:00:00Z'}});
 const lid=await store.getOrCreateCustomer('125847323324420@lid',{businessAccountId:'JointCare',source:{phone:'6737326455',remoteJid:'125847323324420@lid'}});
 assert.equal(lid.id,imported.id);
 assert.deepEqual(lid.followupsSent,imported.followupsSent);
 store=new JsonStore(dir);
 assert.equal((await store.getOrCreateCustomer('125847323324420@lid',{businessAccountId:'JointCare'})).id,imported.id);
 assert.equal((await store.getOrCreateCustomer('6737326455',{businessAccountId:'JointCare'})).id,imported.id);
 await store.updateCustomer('125847323324420@lid',()=>({optedOut:true}),'JointCare');
 assert.equal((await store.getCustomer(imported.id,'JointCare')).optedOut,true);
 assert.equal((await store.listCustomers(new Date(),'JointCare')).length,1);
 const other=await store.getOrCreateCustomer('125847323324420@lid',{businessAccountId:'BBS',phone:'6737326455'});
 assert.equal(other.id,'125847323324420@lid');
 assert.equal(other.optedOut,undefined);
});

test('reverse import matching retains existing LID and anonymous LID does not guess a phone',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'identity-test-'));const store=new JsonStore(dir);
 await store.getOrCreateCustomer('111111111@lid',{businessAccountId:'A',phone:'6737326455'});
 assert.equal(await store.resolveCustomerIdentity('6737326455@s.whatsapp.net','A'),'111111111@lid');
 assert.equal(await store.resolveCustomerIdentity('222222222@lid','A'),'222222222@lid');
 assert.equal(customerIdentity('222222222@lid').phone,'');
});

test('ambiguous existing records require explicit merge instead of silently dropping state',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'identity-test-'));
 await writeFile(path.join(dir,'customers.json'),JSON.stringify({customers:{a:{id:'1@lid',businessAccountId:'A',phone:'6737326455'},b:{id:'2@lid',businessAccountId:'A',phone:'6737326455'}}}));
 const store=new JsonStore(dir);
 await assert.rejects(store.resolveCustomerIdentity('6737326455','A'),/dedicated merge/);
 assert.equal(await store.resolveCustomerIdentity('1@lid','A'),'1@lid');
});

test('merge combines sent history and orders and preserves blocking and pending states',()=>{
 const a={id:'6737326455@s.whatsapp.net',businessAccountId:'A',phone:'6737326455',productId:'p',firstSeenAt:'2026-10-10T00:00:00Z',followupsSent:{day_2:'2026-10-14T09:24:00Z'},orderIds:['o1'],inboundCount:2};
 const b={id:'1@lid',businessAccountId:'A',phone:'6737326455',productId:'p',firstSeenAt:'2026-10-14T00:00:00Z',followupsSent:{day_2:'2026-10-14T10:24:00Z',day_3:'2026-10-14T12:00:00Z'},orderIds:['o2'],inboundCount:3,optedOut:true,handoffStatus:'human_required',pendingOrder:{name:'A'}};
 const m=mergeCustomerState(a,b);
 assert.equal(m.id,a.id);assert.equal(m.firstSeenAt,a.firstSeenAt);
 assert.equal(m.followupsSent.day_2,a.followupsSent.day_2);assert.equal(m.followupsSent.day_3,b.followupsSent.day_3);
 assert.deepEqual(m.orderIds,['o1','o2']);assert.equal(m.inboundCount,5);
 assert.equal(m.optedOut,true);assert.equal(m.followupBlocked,true);assert.equal(m.handoffStatus,'human_required');
 assert.deepEqual(m.pendingOrder,b.pendingOrder);
 assert.throws(()=>mergeCustomerState(a,{...b,businessAccountId:'B'}),/across business/);
 assert.throws(()=>mergeCustomerState(a,{...b,phone:'6739999999'}),/verified phone/);
 assert.throws(()=>mergeCustomerState(a,{...b,productId:'different'}),/different products/);
 assert.throws(()=>mergeCustomerState({...a,pendingOrder:{name:'B'}},b),/Conflicting pendingOrder/);
});

test('reference migration preserves message content, transport evidence, and other accounts',()=>{
 const value={messages:[{businessAccountId:'A',from:'1@lid',body:'1@lid',source:{remoteJid:'1@lid'}},{businessAccountId:'B',from:'1@lid'}]};
 const next=rekeyCustomerReferences(value,'A','1@lid','6737326455@s.whatsapp.net');
 assert.equal(next.messages[0].from,'6737326455@s.whatsapp.net');
 assert.equal(next.messages[0].body,'1@lid');assert.equal(next.messages[0].source.remoteJid,'1@lid');
 assert.equal(next.messages[1].from,'1@lid');
});
