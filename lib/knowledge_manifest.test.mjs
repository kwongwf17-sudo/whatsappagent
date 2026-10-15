import assert from "node:assert/strict";import test from "node:test";import {mkdtemp,writeFile,readFile,readdir} from "node:fs/promises";import {tmpdir} from "node:os";import path from "node:path";import {spawnSync} from "node:child_process";
import {knowledgeFileAttributes,validateKnowledgeAttributes,KNOWLEDGE_MANIFEST} from "./knowledge_manifest.mjs";

test("metadata rejects wrong accounts, missing product IDs and mixed general/product scope",()=>{
 assert.deepEqual(knowledgeFileAttributes("demo","py1","product_faq"),{business_account_id:"demo",knowledge_scope:"product",knowledge_type:"product_faq",product_id:"py1"});
 assert.throws(()=>validateKnowledgeAttributes(knowledgeFileAttributes("other","py1"),"demo"),/account/);
 assert.throws(()=>validateKnowledgeAttributes({business_account_id:"demo",knowledge_scope:"product"},"demo"),/product_id/);
 assert.throws(()=>validateKnowledgeAttributes({...knowledgeFileAttributes("demo"),product_id:"py1"},"demo"),/General/);
});
test("real ingestion dry run separates products and exports a validated manifest without uploading",async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),"rag-ingest-")),exportDir=path.join(dir,"exports");
 await writeFile(path.join(dir,"product_catalog.json"),JSON.stringify({default_product_id:"py1",products:[{id:"py1",name:"PY1",approved_faqs:[{id:"a",topic:"usage",approved_reply:"Only PY1 instructions"}]},{id:"other",name:"Other product",approved_faqs:[{id:"b",topic:"usage",approved_reply:"Only OTHER instructions"}]}]}));
 await writeFile(path.join(dir,"general_faqs.json"),JSON.stringify({approved_faqs:[{id:"g",approved_reply:"General delivery"}]}));await writeFile(path.join(dir,"sales_replies.json"),"{}");
 const result=spawnSync(process.execPath,["ingest_knowledge.mjs","--account-id","test","--dry-run"],{cwd:process.cwd(),encoding:"utf8",env:{...process.env,WHATSAPP_STORE:"json",WHATSAPP_DATA_DIR:dir,WHATSAPP_KNOWLEDGE_EXPORT_DIR:exportDir,OPENAI_API_KEY:"",DATABASE_URL:"",WHATSAPP_POSTGRES_URL:""}});
 assert.equal(result.status,0,result.stderr+result.stdout);
 const manifest=JSON.parse(await readFile(path.join(exportDir,KNOWLEDGE_MANIFEST),"utf8"));assert.equal(Object.keys(manifest).length,9);
 for(const [filename,attrs] of Object.entries(manifest)){
  validateKnowledgeAttributes(attrs,"test");const content=await readFile(path.join(exportDir,filename),"utf8");
  if(attrs.product_id==="py1")assert.doesNotMatch(content,/Only OTHER instructions|Product ID: other/);
  if(attrs.product_id==="other")assert.doesNotMatch(content,/Only PY1 instructions|Product ID: py1/);
 }
 assert.equal((await readdir(exportDir)).length,10);assert.equal(manifest["general-faq.md"].knowledge_scope,"general");
});
