import assert from "node:assert/strict";import test from "node:test";import { readFile } from "node:fs/promises";
import { buildConversationPlan, isClosingAcknowledgement } from "./conversation.mjs";
const catalog=JSON.parse(await readFile(new URL('../data/product_catalog.json',import.meta.url),'utf8'));const product=catalog.products[0];
test("thanks spelling variants close without knowledge or handoff, including after order",async()=>{
 for(const text of ['Oke tq','Okay tq','ok thanks','Terima kasih'])for(const submitted of [false,true]){
 const plan=await buildConversationPlan({catalog,customer:{id:'C',productId:product.id,...(submitted?{status:'order_submitted',orderIds:['order']}:{})},customerMessage:text,routeClassification:{messageType:'sales_reply',confidence:'high'},ragAnswer:{reply:'Repeated promotion',replyType:'faq',allowProductSpecific:true}});
 assert.equal(plan.handoffRequired,false,text);assert.deepEqual(plan.messages,[],text);
 }
});
test("thanks containing a question or order request are not silently closed",()=>{
 for(const text of ['Okay tq, order one','Okay but how much?','Thanks, where is my order?','Oke tq $49 right?'])assert.equal(isClosingAcknowledgement(text),false,text);
});
test("agreement to order remains an order when context indicates purchase",async()=>{
 const plan=await buildConversationPlan({catalog,customer:{id:'C',productId:product.id,awaitingPackageBInterest:true},customerMessage:'Okay tq',routeClassification:{messageType:'purchase_intent',confidence:'high'}});
 assert.ok(plan.customerPatch.pendingOrder);assert.ok(plan.messages.length);
});
