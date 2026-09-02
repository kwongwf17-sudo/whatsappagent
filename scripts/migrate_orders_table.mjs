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
const ordersTableName = getEnv("WHATSAPP_ORDERS_TABLE", "orders");

if (!connectionString) throw new Error("DATABASE_URL or WHATSAPP_POSTGRES_URL is required.");

const adapter = new PostgresJsonAdapter(dataDir, {
  connectionString,
  tableName,
  ordersTableEnabled: true,
  ordersTableName,
});

try {
  const document = await adapter.readJson(path.join(dataDir, "orders.json"), { orders: [] });
  const orders = Array.isArray(document.orders) ? document.orders : [];
  const valid = orders.filter((order) => order?.id);
  const accountCounts = countBy(valid, (order) => order.businessAccountId || "");
  if (dryRun) {
    console.log(JSON.stringify({ dryRun, sourceRows: orders.length, validRows: valid.length, targetTable: ordersTableName, overwrite, accountCounts }, null, 2));
  } else {
    const imported = await adapter.importOrderRows(valid, { overwrite });
    console.log(JSON.stringify({ dryRun, sourceRows: orders.length, validRows: valid.length, importedRows: imported, targetTable: ordersTableName, overwrite, accountCounts }, null, 2));
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
