import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachFileToVectorStore,
  createVectorStore,
  getVectorStoreFile,
  uploadFile,
} from "./lib/openai.mjs";
import { getEnv, loadEnvFile, requireEnv } from "./lib/env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultKnowledgeDir = path.join(__dirname, "knowledge");
const supportedExtensions = new Set([
  ".c",
  ".cpp",
  ".cs",
  ".css",
  ".doc",
  ".docx",
  ".go",
  ".html",
  ".java",
  ".js",
  ".json",
  ".md",
  ".pdf",
  ".php",
  ".pptx",
  ".py",
  ".rb",
  ".sh",
  ".tex",
  ".ts",
  ".txt",
]);

await loadEnvFile(path.join(__dirname, ".env"));
await loadEnvFile();

const apiKey = requireEnv("OPENAI_API_KEY");
const vectorStoreName = getEnv("OPENAI_VECTOR_STORE_NAME", "whatsapp_customer_service_knowledge");
const knowledgeDir = path.resolve(getEnv("KNOWLEDGE_DIR", defaultKnowledgeDir));
let vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;

if (!vectorStoreId) {
  const vectorStore = await createVectorStore(apiKey, vectorStoreName);
  vectorStoreId = vectorStore.id;
  console.log(`Created vector store: ${vectorStoreId}`);
  console.log("Add this to whatsapp_agent/.env:");
  console.log(`OPENAI_VECTOR_STORE_ID=${vectorStoreId}`);
} else {
  console.log(`Using vector store: ${vectorStoreId}`);
}

const filePaths = await listKnowledgeFiles(knowledgeDir);
if (filePaths.length === 0) {
  throw new Error(`No supported knowledge files found in ${knowledgeDir}`);
}

for (const filePath of filePaths) {
  console.log(`Uploading ${path.relative(process.cwd(), filePath)}`);
  const file = await uploadFile(apiKey, filePath);
  const attached = await attachFileToVectorStore(apiKey, vectorStoreId, file.id);
  await waitForVectorStoreFile(apiKey, vectorStoreId, file.id, attached.status);
  console.log(`Ready: ${path.basename(filePath)} (${file.id})`);
}

console.log("Knowledge ingestion complete.");

async function listKnowledgeFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listKnowledgeFiles(fullPath)));
    } else if (supportedExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

async function waitForVectorStoreFile(apiKey, vectorStoreId, fileId, initialStatus) {
  let status = initialStatus;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (status === "completed") return;
    if (status === "failed" || status === "cancelled") {
      throw new Error(`Vector store indexing failed for ${fileId}: ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const current = await getVectorStoreFile(apiKey, vectorStoreId, fileId);
    status = current.status;
  }
  throw new Error(`Timed out waiting for vector store indexing: ${fileId}`);
}
