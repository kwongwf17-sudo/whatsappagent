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
const operationalEventsTableName = getEnv("WHATSAPP_OPERATIONAL_EVENTS_TABLE", "operational_events");
const auditEventsTableName = getEnv("WHATSAPP_AUDIT_EVENTS_TABLE", "audit_events");

if (!connectionString) throw new Error("DATABASE_URL or WHATSAPP_POSTGRES_URL is required.");

const adapter = new PostgresJsonAdapter(dataDir, {
  connectionString,
  tableName,
  operationalEventsTableEnabled: true,
  operationalEventsTableName,
  auditEventsTableEnabled: true,
  auditEventsTableName,
});

try {
  const errors = await readArray("error_log.json", "errors");
  const failedMessages = await readArray("failed_messages.json", "messages");
  const noReplyReviews = await readArray("no_reply_reviews.json", "reviews");
  const audit = await readArray("audit_log.json", "events");
  const report = {
    error_log: summarize(errors, "accountId"),
    failed_messages: summarize(failedMessages, "businessAccountId"),
    no_reply_reviews: summarize(noReplyReviews, "businessAccountId"),
    audit_log: summarize(audit, "businessAccountId"),
  };
  if (dryRun) {
    console.log(JSON.stringify({ dryRun, targetTable: operationalEventsTableName, auditTargetTable: auditEventsTableName, overwrite, report }, null, 2));
  } else {
    const imported = {
      error_log: await adapter.importOperationalEvents("error_log", normalizeBusinessAccount(errors, "accountId"), { overwrite, maxRows: 300 }),
      failed_messages: await adapter.importOperationalEvents("failed_messages", failedMessages, { overwrite, maxRows: 300 }),
      no_reply_reviews: await adapter.importOperationalEvents("no_reply_reviews", noReplyReviews, { overwrite, maxRows: 300 }),
      audit_log: await adapter.importAuditEvents(audit, { overwrite, maxRows: 200 }),
    };
    console.log(JSON.stringify({ dryRun, targetTable: operationalEventsTableName, auditTargetTable: auditEventsTableName, overwrite, imported, report }, null, 2));
  }
} finally {
  await adapter.close();
}

async function readArray(fileName, property) {
  const document = await adapter.readJson(path.join(dataDir, fileName), { [property]: [] });
  return Array.isArray(document[property]) ? document[property].filter((item) => item?.id) : [];
}

function normalizeBusinessAccount(items, field) {
  return items.map((item) => ({
    ...item,
    businessAccountId: String(item.businessAccountId || item[field] || ""),
  }));
}

function summarize(items, accountField) {
  return {
    sourceRows: items.length,
    accountCounts: countBy(items, (item) => item.businessAccountId || item[accountField] || ""),
  };
}

function countBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}
