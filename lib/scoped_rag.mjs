import {searchVectorStore,rerankKnowledgeRecords} from "./openai.mjs";

export const RAG_MIN_SCORE = 0.5;
export const RAG_MAX_CANDIDATES = 3;

export function knowledgeSearchScope(account, route = null, product = null) {
  if (!account) throw new Error("Knowledge search requires a business account.");
  const general = route?.messageType === "general_faq" || !product?.id;
  if (route?.messageType === "product_question" && !product?.id) return null;
  const attributes = {business_account_id:account,knowledge_scope:general ? "general" : "product"};
  if (!general) attributes.product_id = product.id;
  return {attributes,filters:{type:"and",filters:Object.entries(attributes).map(([key,value])=>({type:"eq",key,value}))}};
}

export async function retrieveScopedKnowledge({apiKey,model,vectorStoreId,customerMessage,retrievalQuery,normalizedCustomerMessage="",routeClassification,product,businessAccountId,search=searchVectorStore,rerank=rerankKnowledgeRecords,onTrace=async()=>{}}) {
  const scope=knowledgeSearchScope(businessAccountId,routeClassification,product);
  if (!scope) return [];
  const results=await search({apiKey,vectorStoreId,query:retrievalQuery,maxResults:RAG_MAX_CANDIDATES,filters:scope.filters,scoreThreshold:RAG_MIN_SCORE});
  const candidates=results.filter(record=>Number.isFinite(record.score)&&record.score>=RAG_MIN_SCORE&&Object.entries(scope.attributes).every(([key,value])=>record.attributes?.[key]===value))
    .sort((a,b)=>b.score-a.score).slice(0,RAG_MAX_CANDIDATES);
  if (!candidates.length) {await onTrace({scope:scope.attributes,minimumScore:RAG_MIN_SCORE,candidates:[],selectedId:null});return [];}
  const ranked=await rerank({apiKey,model,customerMessage,normalizedCustomerMessage,route:routeClassification,records:candidates,topK:1,strict:true});
  const winner=candidates.find(candidate=>candidate.id===ranked[0]?.id);
  if (!winner) throw new Error("Reranker did not return a retrieved candidate.");
  await onTrace({scope:scope.attributes,minimumScore:RAG_MIN_SCORE,candidates:candidates.map(({id,score})=>({id,score})),selectedId:winner.id});
  return [winner];
}
