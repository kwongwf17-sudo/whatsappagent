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
const outboxTableName = getEnv("WHATSAPP_OUTBOX_TABLE", "outbox_messages");

if (!connectionString) {
  throw new Error("DATABASE_URL or WHATSAPP_POSTGRES_URL is required.");
}

const adapter = new PostgresJsonAdapter(dataDir, {
  connectionString,
  tableName,
  outboxTableEnabled: true,
  outboxTableName,
});

try {
  const outboxPath = path.join(dataDir, "outbox.json");
  const document = await adapter.readJson(outboxPath, { messages: [] });
  const messages = Array.isArray(document.messages) ? document.messages : [];
  const valid = messages.filter((message) => message?.id);
  const accountCounts = valid.reduce((acc, message) => {
    const account = message.businessAccountId || "";
    acc[account] = (acc[account] || 0) + 1;
    return acc;
  }, {});

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      sourceRows: messages.length,
      validRows: valid.length,
      targetTable: outboxTableName,
      overwrite,
      accountCounts,
    }, null, 2));
  } else {
    const imported = await adapter.importOutboxMessages(valid, { overwrite });
    console.log(JSON.stringify({
      dryRun: false,
      sourceRows: messages.length,
      validRows: valid.length,
      importedRows: imported,
      targetTable: outboxTableName,
      overwrite,
      accountCounts,
    }, null, 2));
  }
} finally {
  await adapter.close();
}
