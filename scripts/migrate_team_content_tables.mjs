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
const teamContentAccountsTableName = getEnv("WHATSAPP_TEAM_CONTENT_ACCOUNTS_TABLE", "team_content_accounts");
const teamContentProductsTableName = getEnv("WHATSAPP_TEAM_CONTENT_PRODUCTS_TABLE", "team_content_products");

if (!connectionString) throw new Error("DATABASE_URL or WHATSAPP_POSTGRES_URL is required.");

const adapter = new PostgresJsonAdapter(dataDir, {
  connectionString,
  tableName,
  teamContentTableEnabled: true,
  teamContentAccountsTableName,
  teamContentProductsTableName,
});

try {
  const accounts = {};
  const legacy = await adapter.readJsonIfExists(path.join(dataDir, "team_content.json"));
  for (const [accountId, content] of Object.entries(legacy?.accounts || {})) {
    accounts[accountId] = content;
  }
  for (const key of await adapter.listJsonDocumentKeys("team_content_")) {
    const document = await adapter.readJsonIfExists(path.join(dataDir, `${key}.json`));
    const accountId = accountIdFromTeamContentKey(key);
    if (accountId && document?.catalog) accounts[accountId] = document;
  }
  const report = Object.fromEntries(Object.entries(accounts).map(([accountId, content]) => [
    accountId,
    {
      products: Array.isArray(content?.catalog?.products) ? content.catalog.products.length : 0,
      hasFollowups: Boolean(content?.followupSettings && Object.keys(content.followupSettings).length),
      faqCount: Array.isArray(content?.faqLibrary?.approved_faqs) ? content.faqLibrary.approved_faqs.length : 0,
      salesReplyCount: Array.isArray(content?.salesReplyLibrary?.sales_replies) ? content.salesReplyLibrary.sales_replies.length : 0,
    },
  ]));
  if (dryRun) {
    console.log(JSON.stringify({ dryRun, accounts: Object.keys(accounts).length, targetTables: [teamContentAccountsTableName, teamContentProductsTableName], overwrite, report }, null, 2));
  } else {
    const imported = await adapter.importTeamContentRecords(accounts, { overwrite });
    console.log(JSON.stringify({ dryRun, accounts: Object.keys(accounts).length, importedAccounts: imported, targetTables: [teamContentAccountsTableName, teamContentProductsTableName], overwrite, report }, null, 2));
  }
} finally {
  await adapter.close();
}

function accountIdFromTeamContentKey(key = "") {
  const raw = String(key || "").replace(/^team_content_/, "");
  if (!raw || raw === "default") return "default";
  return raw;
}
