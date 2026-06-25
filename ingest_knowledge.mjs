import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachFileToVectorStore,
  createVectorStore,
  deleteVectorStoreFile,
  getVectorStoreFile,
  listVectorStoreFiles,
  uploadFile,
} from "./lib/openai.mjs";
import { getEnv, loadEnvFile, requireEnv } from "./lib/env.mjs";
import { AdminAccountStore } from "./lib/admin_accounts.mjs";
import { PostgresJsonAdapter } from "./lib/postgres_adapter.mjs";
import { SqliteJsonAdapter } from "./lib/sqlite_adapter.mjs";
import { TeamContentStore } from "./lib/team_content.mjs";
import { sanitizeImageKnowledgeChunk } from "./lib/knowledge_sanitizer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

const teamAccountId = getCliValue("--account-id") || getEnv("TEAM_ACCOUNT_ID", "");
const manualKnowledgeDir = getCliValue("--knowledge-dir");
const dryRun = hasCliFlag("--dry-run");
const appendMode = hasCliFlag("--append");
const apiKey = dryRun ? getEnv("OPENAI_API_KEY", "") : requireEnv("OPENAI_API_KEY");
const vectorStoreName = getEnv(
  "OPENAI_VECTOR_STORE_NAME",
  teamAccountId ? `whatsapp_${teamAccountId}_knowledge` : "whatsapp_customer_service_knowledge"
);
const adminAccounts = teamAccountId && !dryRun ? await createAdminAccountStore() : null;
const teamSettings = adminAccounts ? await adminAccounts.getTeamSettings(teamAccountId) : {};
let vectorStoreId = dryRun ? "" : teamSettings.openaiVectorStoreId || process.env.OPENAI_VECTOR_STORE_ID;

if (dryRun) {
  console.log("Dry run: skipping OpenAI vector store creation and upload.");
} else if (!vectorStoreId) {
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

const generatedDir = manualKnowledgeDir ? "" : await mkdtemp(path.join(os.tmpdir(), "whatsapp-vector-knowledge-"));
const knowledgeDir = manualKnowledgeDir ? path.resolve(manualKnowledgeDir) : generatedDir;

try {
  if (!manualKnowledgeDir) {
    await generateVectorKnowledgeFiles(knowledgeDir, teamAccountId);
  }

  const filePaths = await listKnowledgeFiles(knowledgeDir);
  if (filePaths.length === 0) {
    throw new Error(`No supported knowledge files found in ${knowledgeDir}`);
  }

  console.log("Vector store files to embed:");
  for (const filePath of filePaths) {
    console.log(`- ${path.basename(filePath)}`);
  }
  if (dryRun) {
    console.log(`Dry run complete. Generated files are in: ${knowledgeDir}`);
    process.exit(0);
  }

  if (!manualKnowledgeDir && !appendMode) {
    await clearVectorStore(apiKey, vectorStoreId);
  }

  for (const filePath of filePaths) {
    console.log(`Uploading ${path.relative(process.cwd(), filePath)}`);
    const file = await uploadFile(apiKey, filePath);
    const attached = await attachFileToVectorStore(apiKey, vectorStoreId, file.id);
    await waitForVectorStoreFile(apiKey, vectorStoreId, file.id, attached.status);
    console.log(`Ready: ${path.basename(filePath)} (${file.id})`);
  }

  console.log("Knowledge ingestion complete.");
} finally {
  if (generatedDir && !dryRun) {
    await rm(generatedDir, { recursive: true, force: true });
  }
}

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

function hasCliFlag(name) {
  return process.argv.includes(name);
}

async function generateVectorKnowledgeFiles(outputDir, accountId = "") {
  const content = await loadVectorKnowledgeContent(accountId);
  await writeFile(
    path.join(outputDir, "general-faq.md"),
    renderGeneralFaqKnowledge(content.faqLibrary),
    "utf8"
  );
  await writeFile(
    path.join(outputDir, "product-faq.md"),
    renderProductFaqKnowledge(content.catalog),
    "utf8"
  );
  await writeFile(
    path.join(outputDir, "product-image-knowledge.md"),
    renderProductImageKnowledge(content.catalog),
    "utf8"
  );
}

async function loadVectorKnowledgeContent(accountId = "") {
  const dataDir = path.resolve(getEnv("WHATSAPP_DATA_DIR", path.join(__dirname, "data")));
  const defaults = {
    catalog: await readJson(path.join(dataDir, "product_catalog.json")),
    faqLibrary: await readJson(path.join(dataDir, "general_faqs.json")),
    salesReplyLibrary: { sales_replies: [] },
  };
  if (!accountId) return defaults;
  const store = new TeamContentStore(dataDir, {
    adapter: createStorageAdapter(dataDir),
  });
  return store.getContent(accountId, defaults);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function renderGeneralFaqKnowledge(faqLibrary = {}) {
  const faqs = (faqLibrary.approved_faqs || []).filter((faq) => faq && faq.active !== false);
  return [
    "# Vector Store Knowledge: General FAQ",
    "",
    "Use only these approved general FAQ records for business-level questions.",
    "",
    ...faqs.map((faq) => renderFaqRecord(faq, { scope: "general" })),
  ].join("\n");
}

function renderProductFaqKnowledge(catalog = {}) {
  const sections = [];
  for (const product of catalog.products || []) {
    const faqs = (product.approved_faqs || []).filter((faq) => faq && faq.active !== false);
    if (!faqs.length) continue;
    sections.push(
      `## Product: ${product.name || product.id}`,
      `Product ID: ${product.id || ""}`,
      "",
      ...faqs.map((faq) => renderFaqRecord(faq, { scope: "product", product })),
    );
  }
  return [
    "# Vector Store Knowledge: Approved Product FAQ",
    "",
    "Use these approved product FAQ records only for their matching product.",
    "",
    ...sections,
  ].join("\n");
}

function renderProductImageKnowledge(catalog = {}) {
  const sections = [];
  for (const product of catalog.products || []) {
    const chunks = (product.extracted_knowledge?.approvedImages || [])
      .filter((chunk) => chunk && chunk.active !== false && chunk.customer_safe !== false);
    if (!chunks.length) continue;
    sections.push(
      `## Product: ${product.name || product.id}`,
      `Product ID: ${product.id || ""}`,
      "",
      ...chunks.map((chunk) => renderImageChunk(chunk, product)),
    );
  }
  return [
    "# Vector Store Knowledge: Extracted Product Image Knowledge",
    "",
    "Use these approved product image knowledge chunks only for their matching product.",
    "",
    ...sections,
  ].join("\n");
}

function renderFaqRecord(faq, { scope, product = {} } = {}) {
  return [
    `### FAQ: ${faq.id || faq.topic || "unnamed"}`,
    `Scope: ${scope}`,
    product.id ? `Product ID: ${product.id}` : "",
    product.name ? `Product Name: ${product.name}` : "",
    faq.topic ? `Topic: ${faq.topic}` : "",
    ...(faq.example_questions || []).map((question) => `Customer question example: ${question}`),
    ...(faq.customer_messages || []).map((question) => `Customer question example: ${question}`),
    `Approved answer: ${faq.approved_reply || faq.answer || ""}`,
    "",
  ].filter(Boolean).join("\n");
}

function renderImageChunk(chunk, product) {
  const safeChunk = sanitizeImageKnowledgeChunk(chunk);
  return [
    `### Image Knowledge: ${safeChunk.id || safeChunk.title || "unnamed"}`,
    `Product ID: ${product.id || ""}`,
    `Product Name: ${product.name || ""}`,
    safeChunk.category ? `Category: ${safeChunk.category}` : "",
    safeChunk.title ? `Title: ${safeChunk.title}` : "",
    safeChunk.sourceFilename ? `Source file: ${safeChunk.sourceFilename}` : "",
    safeChunk.summary ? `Summary: ${safeChunk.summary}` : "",
    safeChunk.extracted_text ? `Extracted text: ${safeChunk.extracted_text}` : "",
    safeChunk.embedding_text ? `Embedding text: ${safeChunk.embedding_text}` : "",
    safeChunk.brunei_malay_summary ? `Brunei Malay summary: ${safeChunk.brunei_malay_summary}` : "",
    safeChunk.brunei_malay_search_text ? `Brunei Malay search text: ${safeChunk.brunei_malay_search_text}` : "",
    ...(safeChunk.question_examples || []).map((question) => `Customer question example: ${question}`),
    ...(safeChunk.brunei_malay_question_examples || []).map((question) => `Brunei Malay question example: ${question}`),
    "",
  ].filter(Boolean).join("\n");
}

function createStorageAdapter(dataDir) {
  const backend = getEnv("WHATSAPP_STORE", "json").toLowerCase();
  if (backend === "sqlite") return new SqliteJsonAdapter(dataDir, getEnv("WHATSAPP_SQLITE_PATH", "agent.sqlite"));
  if (backend === "postgres") {
    return new PostgresJsonAdapter(dataDir, {
      connectionString: getEnv("WHATSAPP_POSTGRES_URL", getEnv("DATABASE_URL", "")),
      tableName: getEnv("WHATSAPP_POSTGRES_TABLE", "json_documents"),
    });
  }
  return null;
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

async function clearVectorStore(apiKey, vectorStoreId) {
  const files = await listVectorStoreFiles(apiKey, vectorStoreId);
  if (!files.length) return;
  console.log(`Removing ${files.length} existing vector store file(s).`);
  for (const file of files) {
    await deleteVectorStoreFile(apiKey, vectorStoreId, file.id);
    console.log(`Removed: ${file.id}`);
  }
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
