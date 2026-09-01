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
const followupQueueTableName = getEnv("WHATSAPP_FOLLOWUP_QUEUE_TABLE", "followup_dispatch_queue_rows");

if (!connectionString) {
  throw new Error("DATABASE_URL or WHATSAPP_POSTGRES_URL is required.");
}

const adapter = new PostgresJsonAdapter(dataDir, {
  connectionString,
  tableName,
  followupQueueTableEnabled: true,
  followupQueueTableName,
});

try {
  const queuePath = path.join(dataDir, "followup_dispatch_queue.json");
  const document = await adapter.readJson(queuePath, { items: [] });
  const items = Array.isArray(document.items) ? document.items : Array.isArray(document.queue) ? document.queue : [];
  const valid = items.filter((item) => item?.id && item?.customerId && item?.followupKey);
  const statusCounts = valid.reduce((acc, item) => {
    const status = item.status || "unknown";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      sourceRows: items.length,
      validRows: valid.length,
      targetTable: followupQueueTableName,
      overwrite,
      statusCounts,
    }, null, 2));
  } else {
    const imported = await adapter.importFollowupDispatches(valid, { overwrite });
    console.log(JSON.stringify({
      dryRun: false,
      sourceRows: items.length,
      validRows: valid.length,
      importedRows: imported,
      targetTable: followupQueueTableName,
      overwrite,
      statusCounts,
    }, null, 2));
  }
} finally {
  await adapter.close();
}
