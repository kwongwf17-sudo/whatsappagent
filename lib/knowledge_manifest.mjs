export const KNOWLEDGE_MANIFEST = "knowledge-manifest.json";
export function knowledgeFileAttributes(account, productId = "", knowledgeType = "general_faq") {
  const attributes={business_account_id:String(account),knowledge_scope:productId ? "product" : "general",knowledge_type:knowledgeType};
  if(productId)attributes.product_id=String(productId);
  if(Object.values(attributes).some(value=>!value||value.length>256))throw new Error("Knowledge metadata must contain nonempty values of at most 256 characters.");
  return attributes;
}
export function validateKnowledgeAttributes(attributes, account) {
  if(!attributes||attributes.business_account_id!==account||!["general","product"].includes(attributes.knowledge_scope))throw new Error("Knowledge file metadata does not match the target account/scope.");
  if(attributes.knowledge_scope==="product"&&!attributes.product_id)throw new Error("Product knowledge requires product_id metadata.");
  if(attributes.knowledge_scope==="general"&&attributes.product_id)throw new Error("General knowledge cannot carry a product_id.");
  if(Object.values(attributes).some(value=>typeof value!=="string"||!value||value.length>256))throw new Error("Invalid knowledge metadata value.");
  return attributes;
}
