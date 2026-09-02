import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEnv, loadEnvFile } from "../lib/env.mjs";
import { PostgresJsonAdapter } from "../lib/postgres_adapter.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnvFile(path.join(__dirname, "..", ".env"));
await loadEnvFile();

const dryRun = process.argv.includes("--dry-run");
const overwrite = process.argv.includes("--overwrite");
const dataDir = path.resolve(getEnv("WHATSAPP_DATA_DIR", path.join(__dirname, "..", "data")));
const connectionString = getEnv("WHATSAPP_POSTGRES_URL", getEnv("DATABASE_URL", ""));
const tableName = getEnv("WHATSAPP_POSTGRES_TABLE", "json_documents");
const processedMessagesTableName = getEnv("WHATSAPP_PROCESSED_MESSAGES_TABLE", "processed_messages");

if (!connectionString) throw new Error("DATABASE_URL or WHATSAPP_POSTGRES_URL is required.");

const adapter = new PostgresJsonAdapter(dataDir, {
  connectionString,
  tableName,
  processedMessagesTableEnabled: true,
  processedMessagesTableName,
});

try {
  const document = await adapter.readJson(path.join(dataDir, "processed_messages.json"), { messages: {} });
  const messages = document.messages && typeof document.messages === "object" && !Array.isArray(document.messages)
    ? document.messages
    : {};
  const valid = Object.values(messages).filter((message) => message?.messageId);
  const accountCounts = countBy(valid, (message) => message.businessAccountId || "");
  if (dryRun) {
    console.log(JSON.stringify({ dryRun, sourceRows: Object.keys(messages).length, validRows: valid.length, targetTable: processedMessagesTableName, overwrite, accountCounts }, null, 2));
  } else {
    const imported = await adapter.importProcessedMessageRows(valid, { overwrite });
    console.log(JSON.stringify({ dryRun, sourceRows: Object.keys(messages).length, validRows: valid.length, importedRows: imported, targetTable: processedMessagesTableName, overwrite, accountCounts }, null, 2));
  }
} finally {
  await adapter.close();
}

function countBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}
