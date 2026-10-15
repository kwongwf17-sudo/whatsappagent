import assert from "node:assert/strict";import test from "node:test";
import {retrieveScopedKnowledge,knowledgeSearchScope} from "./scoped_rag.mjs";
import {searchVectorStore,rerankKnowledgeRecords,attachFileToVectorStore} from "./openai.mjs";
const attrs={business_account_id:"demo",knowledge_scope:"product",product_id:"py1"};
const record=(id,score,attributes=attrs)=>({id,score,attributes,text:`Knowledge ${id}`});
const args={apiKey:"test",model:"test",vectorStoreId:"vs_test",businessAccountId:"demo",product:{id:"py1"},routeClassification:{messageType:"product_question"},customerMessage:"cara guna",retrievalQuery:"PY1 usage"};

test("search requests only three candidates at 0.5 with account and product prefilters, then returns the first AI-ranked candidate only",async()=>{
 let seen;const traces=[];
 const result=await retrieveScopedKnowledge({...args,search:async input=>{assert.equal(input.maxResults,3);assert.equal(input.scoreThreshold,0.5);assert.deepEqual(input.filters.filters,[{type:"eq",key:"business_account_id",value:"demo"},{type:"eq",key:"knowledge_scope",value:"product"},{type:"eq",key:"product_id",value:"py1"}]);return [record("a",0.8),record("b",0.9),record("c",0.5),record("weak",0.49),record("other",0.99,{...attrs,product_id:"other"}),record("foreign",1,{...attrs,business_account_id:"other"})];},rerank:async input=>{seen=input;return [input.records[2],input.records[0]];},onTrace:async trace=>traces.push(trace)});
 assert.equal(seen.topK,1);assert.equal(seen.strict,true);assert.deepEqual(seen.records.map(r=>r.id),["b","a","c"]);assert.deepEqual(result.map(r=>r.id),["c"]);assert.equal(traces[0].selectedId,"c");assert.equal(traces[0].candidates.length,3);
});
test("general questions use general metadata, while an unidentified product question does not search",async()=>{
 const general=knowledgeSearchScope("demo",{messageType:"general_faq"},{id:"py1"});assert.deepEqual(general.attributes,{business_account_id:"demo",knowledge_scope:"general"});
 assert.deepEqual(await retrieveScopedKnowledge({...args,product:null,search:async()=>{throw Error("Should not search");}}),[]);
});
test("zero qualifying results skip reranking; errors or invalid reranking cannot fall back to another candidate",async()=>{
 assert.deepEqual(await retrieveScopedKnowledge({...args,search:async()=>[record("bad",0.49),record("missing",undefined)],rerank:async()=>{throw Error("Should not rerank");}}),[]);
 await assert.rejects(retrieveScopedKnowledge({...args,search:async()=>[record("a",0.9)],rerank:async()=>{throw Error("failure");}}),/failure/);
 await assert.rejects(retrieveScopedKnowledge({...args,search:async()=>[record("a",0.9)],rerank:async()=>[record("invented",1)]}),/retrieved candidate/);
});
test("OpenAI request carries filters and threshold, attachment carries metadata, and strict AI reranking rejects malformed outputs",async()=>{
 const original=globalThis.fetch;const bodies=[];let response={data:[]};
 globalThis.fetch=async(url,options)=>{bodies.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify(response),{status:200});};
 try{
  const scope=knowledgeSearchScope("demo",args.routeClassification,args.product);
  await searchVectorStore({apiKey:"test",vectorStoreId:"vs_test",query:"usage",maxResults:3,filters:scope.filters,scoreThreshold:0.5});
  assert.equal(bodies[0].body.max_num_results,3);assert.equal(bodies[0].body.ranking_options.score_threshold,0.5);assert.deepEqual(bodies[0].body.filters,scope.filters);
  await attachFileToVectorStore("test","vs_test","file_test",attrs);assert.deepEqual(bodies[1].body.attributes,attrs);
  response={output_text:JSON.stringify({top_ids:["b"]})};
  assert.equal((await rerankKnowledgeRecords({apiKey:"test",model:"test",customerMessage:"usage",records:[record("a",0.9),record("b",0.8)],topK:1,strict:true}))[0].id,"b");
  response={output_text:"not json"};await assert.rejects(rerankKnowledgeRecords({apiKey:"test",model:"test",records:[record("a",0.9)],topK:1,strict:true}));
  response={output_text:JSON.stringify({top_ids:["invented","a"]})};await assert.rejects(rerankKnowledgeRecords({apiKey:"test",model:"test",records:[record("a",0.9)],topK:1,strict:true}),/invalid first/);
 }finally{globalThis.fetch=original;}
});
