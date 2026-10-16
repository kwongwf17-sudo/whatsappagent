import assert from "node:assert/strict";import test from "node:test";
import {sanitizeProductKnowledgeReply as clean,resolveKnowledgeReply,knowledgeHandoffAnswer} from "./knowledge_reply.mjs";
import {buildConversationPlan} from "./conversation.mjs";
test("preserves prices while stripping source introductions in English and Malay",()=>{
 for(const text of ["The poster shows B$49 for the product and a B$30 top-up for lubricant.","Menurut poster, B$49 untuk produk saja. Dalam poster, lubricant perlu top up B$30.","Yang B$49 itu harga promo untuk produk saja ya. Untuk lubricant, poster tunjuk top up B$30.","According to the extracted text, lubricant costs B$30 extra."]){
  const reply=clean(text);assert.match(reply,/30/);assert.doesNotMatch(reply,/poster|extracted/i);
 }
});
test("preserves refund claims and avoids guessing how to remove unfamiliar references",()=>{
 assert.equal(clean("You can claim within 30 days."),"You can claim within 30 days.");
 assert.equal(clean("A chunk in the vector store has the answer."),"");
 assert.equal(clean("I cannot find that in the approved info."),"");
 assert.equal(clean("Blackheads out in 5 minutes."),"");
});
test("usable cleaned reply needs no retry and records before/after",async()=>{
 let calls=0;const diagnostics=[];const answer=await resolveKnowledgeReply({generate:async()=>{calls++;return{reply:"The poster shows a B$30 top-up.",replyType:"faq"};},fallback:knowledgeHandoffAnswer("Is it included?"),onDiagnostic:async d=>diagnostics.push(d)});
 assert.equal(calls,1);assert.equal(answer.reply,"a B$30 top-up.");assert.equal(diagnostics.length,1);assert.match(diagnostics[0].rawReply,/poster/);
});
test("empty or uncleanable answer retries once with the same generator then returns a nonempty handoff",async()=>{
 const calls=[];const fallback=knowledgeHandoffAnswer("Bahannya apa kah?");const answer=await resolveKnowledgeReply({generate:async({repair})=>{calls.push(repair);return{reply:"See the extracted chunk."};},fallback});assert.deepEqual(calls,[false,true]);assert.deepEqual(answer,fallback);assert.ok(answer.reply);assert.equal(answer.handoffRequired,true);
});
test("a retry can recover an empty answer; generation failures also remain bounded",async()=>{
 let n=0;let a=await resolveKnowledgeReply({generate:async()=>({reply:++n===1?"":"Lubricant requires B$30 extra."}),fallback:knowledgeHandoffAnswer("Is it included?")});assert.match(a.reply,/30/);assert.equal(n,2);
 n=0;a=await resolveKnowledgeReply({generate:async()=>{n++;throw Error("unavailable");},fallback:knowledgeHandoffAnswer("Is it included?")});assert.equal(n,2);assert.equal(a.handoffRequired,true);assert.ok(a.reply);
});
test("knowledge fallback uses existing planner handoff and sends a customer message",async()=>{
 const product={id:"p",name:"Test",openingFlowEnabled:true,opening_flow:[],aliases:[],faqs:[]};
 const plan=await buildConversationPlan({catalog:{products:[product]},customer:{id:"C",productId:"p",openingFlowsSent:{p:{sentAt:new Date().toISOString()}}},customerMessage:"Is it dishwasher safe?",routeClassification:{messageType:"product_question",confidence:"high"},ragAnswer:knowledgeHandoffAnswer("Is it dishwasher safe?")});
 assert.equal(plan.handoffRequired,true);assert.ok(plan.messages[0].body);assert.equal(plan.customerPatch.handoffStatus,"human_required");
});
