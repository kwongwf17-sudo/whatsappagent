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
const customersTableName = getEnv("WHATSAPP_CUSTOMERS_TABLE", "customers");

if (!connectionString) {
  throw new Error("DATABASE_URL or WHATSAPP_POSTGRES_URL is required.");
}

const adapter = new PostgresJsonAdapter(dataDir, {
  connectionString,
  tableName,
  customersTableEnabled: true,
  customersTableName,
});

try {
  const customersPath = path.join(dataDir, "customers.json");
  const document = await adapter.readJson(customersPath, { customers: {} });
  const customers = document.customers && typeof document.customers === "object" && !Array.isArray(document.customers)
    ? Object.values(document.customers)
    : [];
  const valid = customers.filter((customer) => customer?.id);
  const accountCounts = valid.reduce((acc, customer) => {
    const account = customer.businessAccountId || "";
    acc[account] = (acc[account] || 0) + 1;
    return acc;
  }, {});

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      sourceRows: customers.length,
      validRows: valid.length,
      targetTable: customersTableName,
      overwrite,
      accountCounts,
    }, null, 2));
  } else {
    const imported = await adapter.importCustomerRows(valid, { overwrite });
    console.log(JSON.stringify({
      dryRun: false,
      sourceRows: customers.length,
      validRows: valid.length,
      importedRows: imported,
      targetTable: customersTableName,
      overwrite,
      accountCounts,
    }, null, 2));
  }
} finally {
  await adapter.close();
}
