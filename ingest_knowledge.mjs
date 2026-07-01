import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
const dataDir = path.resolve(getEnv("WHATSAPP_DATA_DIR", path.join(__dirname, "data")));
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
    await exportGeneratedKnowledgeFiles(knowledgeDir, teamAccountId);
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
  await writeFile(
    path.join(outputDir, "sales-replies.md"),
    renderSalesReplyKnowledge(content.salesReplyLibrary),
    "utf8"
  );
}

async function loadVectorKnowledgeContent(accountId = "") {
  const defaults = {
    catalog: await readJson(path.join(dataDir, "product_catalog.json")),
    faqLibrary: await readJson(path.join(dataDir, "general_faqs.json")),
    salesReplyLibrary: await readJson(path.join(dataDir, "sales_replies.json")),
  };
  if (!accountId) return defaults;
  const store = new TeamContentStore(dataDir, {
    adapter: createStorageAdapter(dataDir),
  });
  return store.getContent(accountId, defaults);
}

async function exportGeneratedKnowledgeFiles(sourceDir, accountId = "") {
  const exportDir = path.resolve(
    getEnv(
      "WHATSAPP_KNOWLEDGE_EXPORT_DIR",
      path.join(dataDir, "knowledge_exports", safeExportSegment(accountId || "default"))
    )
  );
  await rm(exportDir, { recursive: true, force: true });
  await mkdir(exportDir, { recursive: true });
  const filePaths = await listKnowledgeFiles(sourceDir);
  for (const filePath of filePaths) {
    await writeFile(path.join(exportDir, path.basename(filePath)), await readFile(filePath));
  }
  console.log(`Exported generated knowledge files to: ${exportDir}`);
}

function safeExportSegment(value) {
  return String(value || "default").replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "default";
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

function renderSalesReplyKnowledge(salesReplyLibrary = {}) {
  const replies = (salesReplyLibrary.sales_replies || [])
    .filter((reply) => reply && reply.active !== false && (reply.scope || "business") !== "product");
  return [
    "# Vector Store Knowledge: Approved Sales Replies",
    "",
    "Use these records only to select an approved sales reply for customer objections, hesitation, concerns, or sales-related responses.",
    "Never use this file to answer factual FAQ or product knowledge questions.",
    "The application sends the saved approved reply; the model must return only the matching SALES_REPLY_ID.",
    "",
    ...replies.map(renderSalesReplyRecord),
  ].join("\n");
}

function renderSalesReplyRecord(reply) {
  const approvedReply = reply.approved_reply || "";
  const bruneiMalayReply = reply.brunei_malay_approved_reply || approvedReply;
  const bruneiMalaySearchText = renderBruneiMalaySalesSearchText(reply, bruneiMalayReply);
  return [
    `### Sales Reply: ${reply.id || reply.objection_type || "unnamed"}`,
    "Scope: general",
    `Sales Reply ID: ${reply.id || ""}`,
    reply.objection_type ? `Objection type: ${reply.objection_type}` : "",
    reply.intent ? `Intent: ${reply.intent}` : "",
    ...(reply.example_messages || []).map((message) => `Customer sales example: ${message}`),
    `Approved sales reply: ${approvedReply}`,
    reply.followup_prompt ? `Approved follow-up prompt: ${reply.followup_prompt}` : "",
    bruneiMalayReply ? `Brunei Malay approved sales reply: ${bruneiMalayReply}` : "",
    bruneiMalaySearchText ? `Brunei Malay sales search text: ${bruneiMalaySearchText}` : "",
    "",
  ].filter(Boolean).join("\n");
}

function renderBruneiMalaySalesSearchText(reply, approvedReply) {
  return [
    ...(reply.brunei_malay_example_messages || []),
    ...(reply.example_messages || []),
    reply.brunei_malay_objection_type || "",
    reply.objection_type || "",
    reply.brunei_malay_intent || "",
    reply.intent || "",
    approvedReply || "",
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(" | ");
}

function renderFaqRecord(faq, { scope, product = {} } = {}) {
  const approvedAnswer = faq.approved_reply || faq.answer || "";
  const bruneiMalayAnswer = faq.brunei_malay_approved_reply || approvedAnswer;
  const bruneiMalaySearchText = renderBruneiMalayFaqSearchText(faq, bruneiMalayAnswer);
  return [
    `### FAQ: ${faq.id || faq.topic || "unnamed"}`,
    `Scope: ${scope}`,
    product.id ? `Product ID: ${product.id}` : "",
    product.name ? `Product Name: ${product.name}` : "",
    faq.topic ? `Topic: ${faq.topic}` : "",
    ...(faq.example_questions || []).map((question) => `Customer question example: ${question}`),
    ...(faq.customer_messages || []).map((question) => `Customer question example: ${question}`),
    `Approved answer: ${approvedAnswer}`,
    bruneiMalayAnswer ? `Brunei Malay approved answer: ${bruneiMalayAnswer}` : "",
    bruneiMalaySearchText ? `Brunei Malay FAQ search text: ${bruneiMalaySearchText}` : "",
    "",
  ].filter(Boolean).join("\n");
}

function renderBruneiMalayFaqSearchText(faq, approvedAnswer) {
  return [
    ...(faq.brunei_malay_example_questions || []),
    ...(faq.example_questions || []),
    ...(faq.customer_messages || []),
    faq.brunei_malay_topic || "",
    approvedAnswer || "",
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(" | ");
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
  let totalRemoved = 0;
  for (let pass = 1; pass <= 10; pass += 1) {
    const files = await listVectorStoreFiles(apiKey, vectorStoreId);
    if (!files.length) {
      if (totalRemoved) console.log(`Vector store cleanup complete. Removed ${totalRemoved} file(s).`);
      return;
    }

    console.log(`Removing ${files.length} existing vector store file(s). Pass ${pass}.`);
    for (const file of files) {
      await detachVectorStoreFile(apiKey, vectorStoreId, file);
      totalRemoved += 1;
      console.log(`Removed: ${file.id}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  const remaining = await listVectorStoreFiles(apiKey, vectorStoreId);
  if (remaining.length) {
    throw new Error(`Vector store cleanup did not finish. ${remaining.length} old file row(s) still attached. Please delete the old rows in OpenAI Storage, then sync again.`);
  }
}

async function detachVectorStoreFile(apiKey, vectorStoreId, file) {
  const ids = [...new Set([file.id, file.file_id].filter(Boolean))];
  let lastError = null;
  for (const id of ids) {
    try {
      await deleteVectorStoreFile(apiKey, vectorStoreId, id);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Unable to detach vector store file ${file.id}`);
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
