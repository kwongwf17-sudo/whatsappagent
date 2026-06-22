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
import { AdminAccountStore } from "./lib/admin_accounts.mjs";
import { PostgresJsonAdapter } from "./lib/postgres_adapter.mjs";
import { SqliteJsonAdapter } from "./lib/sqlite_adapter.mjs";

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
const teamAccountId = getCliValue("--account-id") || getEnv("TEAM_ACCOUNT_ID", "");
const vectorStoreName = getEnv(
  "OPENAI_VECTOR_STORE_NAME",
  teamAccountId ? `whatsapp_${teamAccountId}_knowledge` : "whatsapp_customer_service_knowledge"
);
const knowledgeDir = path.resolve(getCliValue("--knowledge-dir") || getEnv("KNOWLEDGE_DIR", defaultKnowledgeDir));
const adminAccounts = teamAccountId ? await createAdminAccountStore() : null;
const teamSettings = teamAccountId ? await adminAccounts.getTeamSettings(teamAccountId) : {};
let vectorStoreId = teamSettings.openaiVectorStoreId || process.env.OPENAI_VECTOR_STORE_ID;

if (!vectorStoreId) {
  const vectorStore = await createVectorStore(apiKey, vectorStoreName);
  vectorStoreId = vectorStore.id;
  console.log(`Created vector store: ${vectorStoreId}`);
  if (teamAccountId) {
    await adminAccounts.updateTeamSettings(teamAccountId, { openaiVectorStoreId: vectorStoreId });
    console.log(`Saved vector store ID to team settings for ${teamAccountId}.`);
  } else {
    console.log("Add this to whatsapp_agent/.env:");
    console.log(`OPENAI_VECTOR_STORE_ID=${vectorStoreId}`);
  }
} else {
  console.log(`Using vector store: ${vectorStoreId}`);
  if (teamAccountId && teamSettings.openaiVectorStoreId !== vectorStoreId) {
    await adminAccounts.updateTeamSettings(teamAccountId, { openaiVectorStoreId: vectorStoreId });
    console.log(`Saved vector store ID to team settings for ${teamAccountId}.`);
  }
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

async function createAdminAccountStore() {
  const dataDir = path.resolve(getEnv("WHATSAPP_DATA_DIR", path.join(__dirname, "data")));
  const backend = getEnv("WHATSAPP_STORE", "json").toLowerCase();
  const adapter = backend === "sqlite"
    ? new SqliteJsonAdapter(dataDir, getEnv("WHATSAPP_SQLITE_PATH", "agent.sqlite"))
    : backend === "postgres"
      ? new PostgresJsonAdapter(dataDir, {
          connectionString: getEnv("WHATSAPP_POSTGRES_URL", getEnv("DATABASE_URL", "")),
          tableName: getEnv("WHATSAPP_POSTGRES_TABLE", "json_documents"),
        })
      : null;
  return new AdminAccountStore(dataDir, {
    adapter,
    encryptionSecret: getEnv("ADMIN_SESSION_SECRET", getEnv("WHATSAPP_APP_SECRET", "local_team_settings_secret")),
  });
}

function getCliValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return "";
  return process.argv[index + 1] || "";
}

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
