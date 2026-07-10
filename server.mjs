import crypto from "node:crypto";
import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildConversationPlan,
  classifyFaqSalesPromptResponse,
  approvedFaqRecordsForProduct,
  extractOrderDetails,
  findApprovedFaqLocalMatch,
  findProduct,
  findProductMatch,
  isGeneralBusinessQuestion,
  isProductNameMessage,
  findSalesReplyExactMatch,
  normalizeCustomerMessage,
  salesReplyRecordsForProduct,
  formatStockArrivalMessage,
  textMessage,
  usesFixedOpeningFlow,
} from "./lib/conversation.mjs";
import { getEnv, loadEnvFile, requireEnv } from "./lib/env.mjs";
import {
  classifyCustomerMessageRoute,
  createCustomerServiceResponse,
  createComplaintHandoffReply,
  createSalesIntentRepeatReply,
  detectComplaintIntent,
  detectOrderStatusIntent,
  extractProductKnowledgeFromImage,
  rerankKnowledgeRecords,
  searchVectorStore,
  selectSalesReply,
} from "./lib/openai.mjs";
import { JsonStore } from "./lib/store.mjs";
import { SqliteJsonAdapter } from "./lib/sqlite_adapter.mjs";
import { PostgresJsonAdapter } from "./lib/postgres_adapter.mjs";
import { AdminAccountStore } from "./lib/admin_accounts.mjs";
import { OperationsStore } from "./lib/operations.mjs";
import { TeamContentStore } from "./lib/team_content.mjs";
import { WebWhatsAppManager } from "./lib/web_whatsapp_manager.mjs";
import {
  customerOrderStatusReply,
  deliveryRescheduleReply,
  isDeliveryRescheduleRequest,
  isLikelyOrderStatusQuestion,
  ORDER_STATUS_OPTIONS,
  orderStatusDisplay,
  renderOrderStatusReply,
} from "./lib/order_tracking.mjs";
import {
  complaintCategoryDisplay,
  detectObviousComplaint,
} from "./lib/complaints.mjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

await loadEnvFile(path.join(__dirname, ".env"));
await loadEnvFile();

const demoMode = parseBool(getEnv("DEMO_MODE", "true"));
const transportMode = getEnv("WHATSAPP_TRANSPORT", demoMode ? "demo" : "cloud").toLowerCase();
function resolveSeedPath(envName, fileName) {
  const bundledPath = path.join(__dirname, "data", fileName);
  const configuredPath = path.resolve(getEnv(envName, bundledPath));
  if (existsSync(configuredPath)) {
    return configuredPath;
  }
  if (existsSync(bundledPath)) {
    if (configuredPath !== path.resolve(bundledPath)) {
      console.warn(`${envName} points to missing file ${configuredPath}; using ${bundledPath}`);
    }
    return bundledPath;
  }
  return configuredPath;
}

const config = {
  demoMode,
  transportMode,
  port: Number(getEnv("PORT", "3000")),
  webhookPath: normalizePath(getEnv("WHATSAPP_WEBHOOK_PATH", "/webhook")),
  verifyToken: getEnv("WHATSAPP_VERIFY_TOKEN", "demo_verify_token"),
  appSecret: process.env.WHATSAPP_APP_SECRET,
  graphVersion: getEnv("WHATSAPP_GRAPH_VERSION", "v25.0"),
  phoneNumberId: demoMode || transportMode === "web" ? getEnv("WHATSAPP_PHONE_NUMBER_ID", "") : requireEnv("WHATSAPP_PHONE_NUMBER_ID"),
  accessToken: demoMode || transportMode === "web" ? getEnv("WHATSAPP_ACCESS_TOKEN", "") : requireEnv("WHATSAPP_ACCESS_TOKEN"),
  adminWhatsAppNumber: getEnv("ADMIN_WHATSAPP_NUMBER", ""),
  openaiApiKey: usableEnv("OPENAI_API_KEY"),
  openaiModel: getEnv("OPENAI_MODEL", "gpt-5.4-mini"),
  extractionModel: getEnv("OPENAI_EXTRACTION_MODEL", "gpt-5.4-mini"),
  embeddingModel: getEnv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
  vectorStoreId: usableEnv("OPENAI_VECTOR_STORE_ID"),
  accountId: getEnv("ACCOUNT_ID", "demo"),
  businessName: getEnv("BUSINESS_NAME", "our store"),
  supportLanguage: getEnv("SUPPORT_LANGUAGE", "the customer's language when possible"),
  maxReplyChars: Number(getEnv("MAX_REPLY_CHARS", "3500")),
  dataDir: path.resolve(getEnv("WHATSAPP_DATA_DIR", path.join(__dirname, "data"))),
  storeBackend: getEnv("WHATSAPP_STORE", "json").toLowerCase(),
  sqlitePath: getEnv("WHATSAPP_SQLITE_PATH", "agent.sqlite"),
  postgresUrl: getEnv("WHATSAPP_POSTGRES_URL", getEnv("DATABASE_URL", "")),
  postgresTable: getEnv("WHATSAPP_POSTGRES_TABLE", "json_documents"),
  assetsDir: path.resolve(getEnv("WHATSAPP_ASSETS_DIR", path.join(__dirname, "assets"))),
  webSessionDir: path.resolve(getEnv("WHATSAPP_WEB_SESSION_DIR", path.join(__dirname, "data", "whatsapp-web-session"))),
  catalogPath: resolveSeedPath("PRODUCT_CATALOG_PATH", "product_catalog.json"),
  generalFaqsPath: resolveSeedPath("GENERAL_FAQS_PATH", "general_faqs.json"),
  salesRepliesPath: resolveSeedPath("SALES_REPLIES_PATH", "sales_replies.json"),
  publicBaseUrl: getEnv("PUBLIC_BASE_URL", ""),
  followupAutorun: parseBool(getEnv("FOLLOWUP_AUTORUN", "false")),
  followupIntervalMinutes: Number(getEnv("FOLLOWUP_INTERVAL_MINUTES", "15")),
  followupSendsPerMinute: Number(getEnv("FOLLOWUP_SENDS_PER_MINUTE", "10")),
  followupSendDelayMinMs: Number(getEnv("FOLLOWUP_SEND_DELAY_MIN_MS", "2000")),
  followupSendDelayMaxMs: Number(getEnv("FOLLOWUP_SEND_DELAY_MAX_MS", "5000")),
  followupActiveWindowMinutes: Number(getEnv("FOLLOWUP_ACTIVE_WINDOW_MINUTES", "10")),
  followupPauseWindowMinutes: Number(getEnv("FOLLOWUP_PAUSE_WINDOW_MINUTES", "5")),
  followupRetryMinutes: Number(getEnv("FOLLOWUP_RETRY_MINUTES", "5")),
  businessTimeZone: getEnv("BUSINESS_TIME_ZONE", "Asia/Kuala_Lumpur"),
  openingFlowInitialDelayMs: Number(getEnv("OPENING_FLOW_INITIAL_DELAY_MS", "5000")),
  statusReplyDelayMs: Number(getEnv("STATUS_REPLY_DELAY_MS", "5000")),
  messageSequenceDelayMs: Number(getEnv("WHATSAPP_SEQUENCE_DELAY_MS", "1500")),
  orderDetailBufferMs: Number(getEnv("ORDER_DETAIL_BUFFER_MS", "60000")),
  messageMergeBufferMs: Number(getEnv("MESSAGE_MERGE_BUFFER_MS", "10000")),
  deliveryWaitTimeoutMs: Number(getEnv("WHATSAPP_DELIVERY_WAIT_TIMEOUT_MS", "15000")),
  webProcessFromMeMessages: parseBool(getEnv("WHATSAPP_WEB_PROCESS_FROM_ME", "false")),
  adminPassword: getEnv("ADMIN_PASSWORD", "admin123"),
  adminSessionSecret: getEnv("ADMIN_SESSION_SECRET", getEnv("WHATSAPP_APP_SECRET", "demo_session_secret")),
  superAdminPassword: usableSecretEnv("SUPER_ADMIN_PASSWORD"),
  appVersion: getEnv("APP_VERSION", "0.1.0-demo"),
  skipHttpServer: parseBool(getEnv("WHATSAPP_SKIP_HTTP", "false")),
};

const FOLLOWUP_TEMPLATE_LANGUAGE = "en";
const FOLLOWUP_TEMPLATE_BY_KEY = {
  first_day_followup: "dayone_followup",
  day_1_followup: "daytwo_followup",
  day_3_followup: "daythree_followup",
  day_4_followup: "dayfour_followup",
  day_5_followup: "dayfive_followup",
  day_6_followup: "daysix_followup",
  day_7_followup: "dayseven_followup",
  day_8_followup: "dayeight_followup",
  day_9_followup: "daynine_followup",
  day_10_followup: "dayten_followup",
};
const FOLLOWUP_EDITOR_STAGES = [
  { key: "first_day_followup", label: "First Follow-Up", dayOffset: 0, defaultSendHour: 20, firstChatCutoffHour: 19 },
  ...Array.from({ length: 10 }, (_, index) => {
    const day = index + 1;
    return { key: `day_${day}_followup`, label: `Day ${day}`, dayOffset: day, defaultSendHour: 20 };
  }),
];
const FOLLOWUP_MEDIA_MAX_BYTES = 30 * 1024 * 1024;
const FOLLOWUP_MEDIA_TYPES = new Map([
  ["image/jpeg", { extension: "jpg", type: "image" }],
  ["image/png", { extension: "png", type: "image" }],
  ["image/webp", { extension: "webp", type: "image" }],
  ["video/mp4", { extension: "mp4", type: "video" }],
  ["video/webm", { extension: "webm", type: "video" }],
  ["video/quicktime", { extension: "mov", type: "video" }],
]);
const DEFAULT_ORDER_CLOSING_MESSAGES = [
  "Sorry Dear our stock just finish , I will take order again, will take around 15-18 days for arrived brunei new stock 🥰 But i will try my best to get it quick for you ya.",
  "REMINDER ✨: \n-Order after 1 hour cannot be canceled. \n-Brg Sampai baru byr runner",
  "Terima kasih❤️",
];

const DEFAULT_ORDER_FORM = {
  intro: "Can you help me fill up this details for hold promo? \uD83E\uDD70",
  nameLabel: "Full name",
  addressLabel: "Full address",
  phoneLabel: "Phone number",
  optionLabel: "Order option",
};

const catalog = JSON.parse(await readSeedFile(config.catalogPath, "product_catalog.json"));
const faqLibrary = await loadFaqLibrary();
const salesReplyLibrary = await loadSalesReplyLibrary();
const defaultTeamContent = { catalog, faqLibrary, salesReplyLibrary };
const sqliteAdapter = config.storeBackend === "sqlite"
  ? new SqliteJsonAdapter(config.dataDir, config.sqlitePath)
  : null;
const postgresAdapter = config.storeBackend === "postgres"
  ? new PostgresJsonAdapter(config.dataDir, {
      connectionString: config.postgresUrl,
      tableName: config.postgresTable,
    })
  : null;
const storageAdapter = sqliteAdapter || postgresAdapter;
const store = new JsonStore(config.dataDir, { adapter: storageAdapter });
const adminAccounts = new AdminAccountStore(config.dataDir, {
  adapter: storageAdapter,
  encryptionSecret: config.adminSessionSecret,
});
const operations = new OperationsStore(config.dataDir, { adapter: storageAdapter });
const teamContentStore = new TeamContentStore(config.dataDir, { adapter: storageAdapter });
const webTransportManager = config.transportMode === "web"
  ? new WebWhatsAppManager({
      sessionRootDir: config.webSessionDir,
      logger: console,
      processFromMeMessages: config.webProcessFromMeMessages,
    })
  : null;
await adminAccounts.ensureInitialAccount({
  id: config.accountId,
  name: config.businessName,
  password: config.adminPassword,
});
await operations.ensureState({ version: config.appVersion });
let catalogWriteQueue = Promise.resolve();
const processedMessageIds = new Map();
const pendingOrderDetailBuffers = new Map();
const pendingMessageMergeBuffers = new Map();
const deliveredOutboundMessages = new Map();
const submittedOutboundMessages = new Map();
const outboundDeliveryWaiters = new Map();
const outboundQueues = new Map();
let testCustomerGenerationActive = false;
let simulatedOutboxBuffer = null;
let followupRunPromise = null;
const knowledgeSyncRuns = new Map();
const followupPacingStartedAt = new Date();
const webhookDiagnostics = {
  received: 0,
  invalidSignature: 0,
  processed: 0,
  messages: 0,
  statuses: 0,
  lastAt: "",
  lastSignature: "",
  lastObject: "",
  lastField: "",
  lastMessageFrom: "",
  lastMessageType: "",
  lastError: "",
};
const DAY_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_DEMO_ORDER_IDS = new Set([
  "ord_1781332861319",
  "ord_1781332388644",
]);

async function readSeedFile(configuredPath, fileName) {
  try {
    return await readFile(configuredPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }

    const bundledPath = path.join(__dirname, "data", fileName);
    if (path.resolve(configuredPath) === path.resolve(bundledPath)) {
      throw error;
    }

    console.warn(`Seed file not found at ${configuredPath}; falling back to ${bundledPath}`);
    return readFile(bundledPath, "utf8");
  }
}
const OPT_OUT_PATTERN =
  /\b(stop|unsubscribe|remove|jangan message|jangan msg|jgn message|jgn msg|nda minat|ndak minat|tidak minat|tak minat|no longer interested|do not message|dont message)\b/i;

async function loadFaqLibrary() {
  try {
    const parsed = JSON.parse(await readSeedFile(config.generalFaqsPath, "general_faqs.json"));
    return {
      approved_faqs: Array.isArray(parsed.approved_faqs) ? parsed.approved_faqs : [],
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const migrated = migrateCatalogGeneralFaqs();
    await writeFile(config.generalFaqsPath, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
    return migrated;
  }
}

function migrateCatalogGeneralFaqs() {
  const byId = new Map();
  for (const faq of catalog.approved_faqs || []) {
    const id = String(faq.id || "").trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, faq);
  }
  return { approved_faqs: [...byId.values()] };
}

async function persistFaqLibrary() {
  await writeFile(config.generalFaqsPath, `${JSON.stringify(faqLibrary, null, 2)}\n`, "utf8");
}

async function loadSalesReplyLibrary() {
  try {
    const parsed = JSON.parse(await readSeedFile(config.salesRepliesPath, "sales_replies.json"));
    return {
      sales_replies: Array.isArray(parsed.sales_replies) ? parsed.sales_replies : [],
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const migrated = migrateCatalogSalesReplies();
    await writeFile(config.salesRepliesPath, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
    return migrated;
  }
}

function migrateCatalogSalesReplies() {
  const replies = [
    ...(catalog.sales_replies || []).map((reply) => ({
      ...reply,
      scope: reply.scope || "business",
      productId: "",
    })),
    ...catalog.products.flatMap((product) =>
      (product.sales_replies || []).map((reply) => ({
        ...reply,
        scope: "product",
        productId: product.id,
      }))
    ),
  ];
  const byId = new Map();
  for (const reply of replies) {
    const id = String(reply.id || "").trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, reply);
  }
  return { sales_replies: [...byId.values()] };
}
const OPT_OUT_INTENT_PATTERNS = [
  /\b(jangan|jgn|inda|nda|ndak|tidak|tak)\b.*\b(message|msg|mesej|contact|hubungi|whatsapp|wa|chat|follow\s*up|kacau)\b/i,
  /\b(jangan|jgn)\b.*\b(lagi|again)\b/i,
  /\b(inda|nda|ndak|tidak|tak)\b.*\b(mau|mahu|nak|want)\b.*\b(contact|hubungi|message|msg|mesej|whatsapp|wa)\b/i,
  /\b(stop|berhenti)\b.*\b(message|msg|mesej|contact|hubungi|whatsapp|wa|follow\s*up)\b/i,
  /\b(remove|delete|padam|buang)\b.*\b(number|nombor|contact|list|database|data)\b/i,
  /\b(not|no|bukan|nda|ind?a|tidak|tak)\b.*\b(interested|minat|berminat)\b/i,
  /\b(sudah|suda)\b.*\b(tidak|tak|nda|ind?a)\b.*\b(minat|berminat)\b/i,
  /\b(no need|dont need|don't need|x payah|tak payah|nda payah|inda payah)\b/i,
  /\b(jangan kacau|stop kacau|nda mau kana contact|inda mau kana contact|inda mahu kana contact)\b/i,
];
const OPT_OUT_UNCERTAIN_PATTERNS = [
  /\b(kacau|annoying|spam|terlalu banyak|banyak message|banyak msg)\b/i,
];
const DEMO_ACCOUNT_ID = "__demo__";
const SALES_INTENT_OPTIONS = [
  { key: "price_objection_negotiation", label: "Price objection / negotiation" },
  { key: "thinking_first", label: "Thinking first" },
  { key: "payday_only_pay", label: "Payday / only pay later" },
  { key: "too_expensive", label: "Too expensive" },
  { key: "not_interested", label: "Not interested" },
  { key: "another_date_purchase", label: "Another date purchase" },
];
const SALES_INTENT_LABELS = new Map(SALES_INTENT_OPTIONS.map((item) => [item.key, item.label]));
const SALES_REPEAT_ACTION_OPTIONS = [
  { key: "openai_acknowledge", label: "OpenAI acknowledge" },
  { key: "opt_out", label: "Opt out customer" },
  { key: "handoff", label: "Handoff to admin" },
];
const SALES_REPEAT_ACTION_LABELS = new Map(SALES_REPEAT_ACTION_OPTIONS.map((item) => [item.key, item.label]));

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/admin")) {
      res.writeHead(303, { Location: "/admin/dashboard" });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin/login") {
      return sendHtml(res, 200, loginHtml(url.searchParams.get("next") || "/admin/dashboard", "", config.accountId));
    }

    if (req.method === "POST" && url.pathname === "/admin/login") {
      const body = await readFormBody(req);
      const next = String(body.get("next") || "/admin/dashboard");
      const accountId = String(body.get("accountId") || config.accountId).trim();
      const account = await adminAccounts.authenticate(accountId, String(body.get("password") || ""), "business_admin");
      if (!account) {
        return sendHtml(res, 401, loginHtml(next, "Wrong account ID or password.", accountId));
      }
      return sendLoginSession(res, next, account);
    }

    if (req.method === "POST" && url.pathname === "/admin/logout") {
      res.writeHead(303, {
        Location: "/admin/login",
        "Set-Cookie": "wa_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
      });
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/internal/followups/customer/run") {
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: "Local requests only." });
      const body = await readJsonBody(req);
      const result = await sendCustomerFollowupNow(body.customerId || body.customer, {
        businessAccountId: body.businessAccountId || body.account,
        followupKey: body.followupKey || body.key,
        allowAlreadySent: Boolean(body.allowAlreadySent),
        respectOperationalControl: body.respectOperationalControl !== false,
      });
      return sendJson(res, result.sent ? 200 : 409, result);
    }

    if (req.method === "POST" && url.pathname === "/internal/followups/run") {
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: "Local requests only." });
      const body = await readJsonBody(req);
      const result = await requestFollowupRun(body.now ? new Date(body.now) : new Date(), {
        respectOperationalControl: body.respectOperationalControl !== false,
      });
      return sendJson(res, 200, result);
    }

    if (url.pathname.startsWith("/admin/") && !(await isAdminAuthenticated(req))) {
      return redirectToLogin(res, url.pathname + url.search);
    }

    if (req.method === "GET" && url.pathname === "/order-admin/login") {
      return sendHtml(res, 200, orderAdminLoginHtml("", ""));
    }

    if (req.method === "POST" && url.pathname === "/order-admin/login") {
      const body = await readFormBody(req);
      const accountId = String(body.get("accountId") || "").trim();
      const account = await adminAccounts.authenticate(accountId, String(body.get("password") || ""), "order_admin");
      if (!account) return sendHtml(res, 401, orderAdminLoginHtml("Wrong account ID or password.", accountId));
      return sendOrderAdminSession(res, account);
    }

    if (req.method === "POST" && url.pathname === "/order-admin/logout") {
      res.writeHead(303, {
        Location: "/order-admin/login",
        "Set-Cookie": "wa_order_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
      });
      res.end();
      return;
    }

    if (url.pathname.startsWith("/order-admin/") && !(await isOrderAdminAuthenticated(req))) {
      return redirectToOrderAdminLogin(res);
    }

    if (req.method === "GET" && url.pathname === "/order-admin/dashboard") {
      return sendHtml(res, 200, orderAdminDashboardHtml());
    }

    if (req.method === "GET" && url.pathname === "/order-admin/orders-data") {
      return sendJson(res, 200, { orders: (await store.listOrders()).map(formatOrderAdminRow) });
    }

    if (req.method === "POST" && url.pathname === "/order-admin/orders/status") {
      const body = await readJsonBody(req);
      const session = readSessionToken(parseCookies(req.headers.cookie || "").wa_order_admin);
      try {
        const order = await store.updateOrderStatus(String(body.orderId || ""), String(body.status || ""), session.accountId);
        await store.appendAuditLog({
          actor: `order_admin:${session.accountId}`,
          action: "order_status_updated",
          result: `${order.id}:${order.status}`,
        });
        return sendJson(res, 200, { order: formatOrderAdminRow(order) });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/superadmin/login") {
      return sendHtml(res, 200, superAdminLoginHtml(""));
    }

    if (req.method === "POST" && url.pathname === "/superadmin/login") {
      const body = await readFormBody(req);
      if (!config.superAdminPassword) {
        return sendHtml(res, 503, superAdminLoginHtml("Set SUPER_ADMIN_PASSWORD in .env before signing in."));
      }
      if (!timingSafeTextEqual(String(body.get("password") || ""), config.superAdminPassword)) {
        return sendHtml(res, 401, superAdminLoginHtml("Wrong password."));
      }
      return sendSuperAdminSession(res);
    }

    if (req.method === "POST" && url.pathname === "/superadmin/logout") {
      res.writeHead(303, {
        Location: "/superadmin/login",
        "Set-Cookie": "wa_superadmin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
      });
      res.end();
      return;
    }

    if (url.pathname.startsWith("/superadmin/") && !isSuperAdminAuthenticated(req)) {
      return redirectToSuperAdminLogin(res);
    }

    if (req.method === "GET" && url.pathname === "/superadmin/accounts") {
      return sendHtml(res, 200, superAdminAccountsHtml());
    }

    if (req.method === "GET" && url.pathname === "/superadmin/accounts-data") {
      return sendJson(res, 200, { accounts: await adminAccounts.listAccounts() });
    }

    if (req.method === "POST" && url.pathname === "/superadmin/accounts/create") {
      const body = await readJsonBody(req);
      try {
        const account = await adminAccounts.createAccount({
          id: String(body.id || "").trim(),
          name: String(body.name || "").trim(),
          password: String(body.password || ""),
          role: String(body.role || "business_admin"),
        });
        await store.appendAuditLog({
          actor: "super_admin",
          action: "admin_account_created",
          result: account.id,
        });
        return sendJson(res, 201, { account });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/superadmin/accounts/password") {
      const body = await readJsonBody(req);
      try {
        const account = await adminAccounts.resetPassword(String(body.id || ""), String(body.password || ""));
        await store.appendAuditLog({
          actor: "super_admin",
          action: "admin_password_reset",
          result: account.id,
        });
        return sendJson(res, 200, { account });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/superadmin/accounts/status") {
      const body = await readJsonBody(req);
      try {
        const account = await adminAccounts.setActive(String(body.id || ""), Boolean(body.active));
        await store.appendAuditLog({
          actor: "super_admin",
          action: account.active ? "admin_account_enabled" : "admin_account_disabled",
          result: account.id,
        });
        return sendJson(res, 200, { account });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/superadmin/system") {
      return sendHtml(res, 200, superAdminSystemHtml());
    }

    if (req.method === "GET" && url.pathname === "/superadmin/system-data") {
      return sendJson(res, 200, await buildSystemManagementData());
    }

    if (req.method === "POST" && url.pathname === "/superadmin/system/account-control") {
      const body = await readJsonBody(req);
      try {
        const account = await adminAccounts.setOperationalControl(String(body.id || ""), {
          automationPaused: Boolean(body.automationPaused),
          testMode: Boolean(body.testMode),
        });
        await store.appendAuditLog({
          actor: "super_admin",
          action: "automation_control_updated",
          result: `${account.id}:${account.automationPaused ? "paused" : account.testMode ? "test_mode" : "live"}`,
        });
        return sendJson(res, 200, { account });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/superadmin/system/team-settings") {
      const body = await readJsonBody(req);
      try {
        const account = await adminAccounts.updateTeamSettings(String(body.id || ""), body.settings || {});
        await store.appendAuditLog({
          actor: "super_admin",
          action: "team_settings_updated",
          result: account.id,
        });
        return sendJson(res, 200, { account });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/superadmin/system/release") {
      const body = await readJsonBody(req);
      try {
        const state = await operations.recordRelease({ version: body.version, notes: body.notes });
        await store.appendAuditLog({
          actor: "super_admin",
          action: "system_release_recorded",
          result: state.version,
        });
        return sendJson(res, 200, { state });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/superadmin/system/retry-message") {
      const body = await readJsonBody(req);
      const failure = await operations.getFailedMessage(String(body.id || ""));
      if (!failure) return sendJson(res, 404, { error: "Failed message not found." });
      try {
        await sendOutbound(failure.to, failure.messages, {
          ...failure.meta,
          businessAccountId: failure.businessAccountId,
          skipFailureRecord: true,
        });
        const message = await operations.markRetry(failure.id, { success: true });
        await store.appendAuditLog({
          actor: "super_admin",
          action: "failed_message_retried",
          result: failure.id,
        });
        return sendJson(res, 200, { message });
      } catch (error) {
        const message = await operations.markRetry(failure.id, { success: false, error: error.message });
        return sendJson(res, 502, { error: error.message, message });
      }
    }

    if (req.method === "GET" && url.pathname === "/superadmin/system/backup") {
      const backup = await buildSystemBackup();
      await store.appendAuditLog({
        actor: "super_admin",
        action: "system_backup_exported",
        result: backup.exportedAt,
      });
      return sendJsonDownload(res, `whatsapp-agent-backup-${new Date().toISOString().slice(0, 10)}.json`, backup);
    }

    if (req.method === "GET" && url.pathname === config.webhookPath) {
      return handleVerification(url, res);
    }

    if (req.method === "GET" && url.pathname.startsWith("/persisted-assets/")) {
      return handlePersistedAsset(url, res);
    }

    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      return handleAsset(url, res);
    }

    if (req.method === "POST" && url.pathname === config.webhookPath) {
      const rawBody = await readBody(req);
      noteWebhookReceived(req.headers, rawBody);
      if (!isValidSignature(req.headers, rawBody)) {
        noteWebhookInvalidSignature();
        await store.appendAuditLog({
          action: "webhook_invalid_signature",
          result: "rejected",
        }).catch(() => {});
        return sendText(res, 403, "Invalid signature");
      }

      sendText(res, 200, "OK");
      void handleWebhookPayload(rawBody).catch((error) => {
        void recordSystemError("webhook_processing", error);
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/demo/message") {
      const body = await readJsonBody(req);
      const source = { ...(body.source || {}) };
      if (body.productId && !source.productId) source.productId = body.productId;
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const result = await processInboundMessage({
        id: `demo_${Date.now()}`,
        from: body.from || "demo_customer_1",
        text: String(body.text || ""),
        source,
        businessAccountId: DEMO_ACCOUNT_ID,
        contentAccountId: adminSession?.accountId || config.accountId,
        knowledgeAccountId: adminSession?.accountId || config.accountId,
      });
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/admin/followups/run") {
      const body = await readJsonBody(req);
      const result = await requestFollowupRun(body.now ? new Date(body.now) : new Date(), {
        respectOperationalControl: true,
      });
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/admin/followups/customer/run") {
      const body = await readJsonBody(req);
      const result = await sendCustomerFollowupNow(body.customerId || body.customer, {
        businessAccountId: body.businessAccountId || body.account,
        followupKey: body.followupKey || body.key,
        allowAlreadySent: Boolean(body.allowAlreadySent),
        respectOperationalControl: body.respectOperationalControl !== false,
      });
      return sendJson(res, result.sent ? 200 : 409, result);
    }

    if (req.method === "GET" && url.pathname === "/admin/follow-up-settings") {
      return sendHtml(res, 200, followupSettingsPageHtml());
    }

    if (req.method === "GET" && url.pathname === "/admin/followup-settings-data") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      try {
        return sendJson(res, 200, await buildFollowupSettingsData(adminSession.accountId));
      } catch (error) {
        await recordSystemError("followup_settings_load", error, "", adminSession?.accountId || config.accountId);
        return sendJson(res, 500, { error: error.message || "Unable to load follow-up settings." });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/followup-settings/media") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      const media = decodeUploadedFollowupMedia(body.dataUrl);
      if (!media) return sendJson(res, 400, { error: "Please upload an image or video file." });
      if (media.bytes.length > FOLLOWUP_MEDIA_MAX_BYTES) {
        return sendJson(res, 400, { error: "Media must be 30 MB or smaller." });
      }
      const accountAssetId = safeAssetSegment(adminSession.accountId);
      const targetDirectory = path.join(config.assetsDir, accountAssetId, "followups");
      await mkdir(targetDirectory, { recursive: true });
      const originalName = String(body.originalName || "").trim();
      const originalBase = safeAssetSegment(path.basename(originalName, path.extname(originalName))) || "followup";
      const filename = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${originalBase}.${media.extension}`;
      await writeFile(path.join(targetDirectory, filename), media.bytes);
      return sendJson(res, 200, {
        block: {
          id: `block_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
          type: media.type,
          url: `/assets/${accountAssetId}/followups/${filename}`,
          caption: "",
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/admin/followup-settings/save") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      try {
        const body = await readJsonBody(req);
        const content = await getTeamContent(adminSession.accountId);
        const saved = updateTeamFollowupMessages(content, body.followups || body.stages || []);
        const anotherDatePurchaseFollowup = updateAnotherDatePurchaseFollowup(content, body.anotherDatePurchaseFollowup || {});
        await saveTeamContent(adminSession.accountId, content);
        await saveFollowupRuntimeSettings(adminSession.accountId, body.settings);
        await store.appendAuditLog({
          actor: `business_admin:${adminSession.accountId}`,
          action: "followup_messages_updated",
          result: `${saved.updatedProducts} product(s)`,
          businessAccountId: adminSession.accountId,
        });
        return sendJson(res, 200, { ...(await buildFollowupSettingsData(adminSession.accountId, content)), saved: { ...saved, anotherDatePurchaseFollowup } });
      } catch (error) {
        await recordSystemError("followup_settings_save", error, "", adminSession?.accountId || config.accountId);
        return sendJson(res, 500, { error: error.message || "Unable to save follow-up settings." });
      }
    }

    if (req.method === "POST" && url.pathname === "/demo/followups/run") {
      const body = await readJsonBody(req);
      const result = await requestFollowupRun(body.now ? new Date(body.now) : new Date(), {
        respectOperationalControl: false,
      });
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/demo/customer/time") {
      const body = await readJsonBody(req);
      const customerId = String(body.customerId || "");
      if (!customerId) return sendText(res, 400, "Missing customerId");
      const firstSeenAt = String(body.firstSeenAt || new Date().toISOString());
      const customer = await store.updateCustomer(customerId, () => ({
        firstSeenAt,
        lastMessageAt: firstSeenAt,
        lastInboundAt: firstSeenAt,
        inboundCount: 1,
        followupsSent: {},
        orderIds: [],
        businessAccountId: DEMO_ACCOUNT_ID,
      }), DEMO_ACCOUNT_ID);
      return sendJson(res, 200, { customer });
    }

    if (req.method === "POST" && url.pathname === "/admin/stock-arrival") {
      const body = await readJsonBody(req);
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const result = await handleStockArrival(body.productId || catalog.default_product_id, adminSession.accountId);
      return sendJson(res, 200, result);
    }

    if (req.method === "GET" && url.pathname === "/admin/orders") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const orders = (await store.listOrders()).filter(
        (order) => (order.businessAccountId || config.accountId) === adminSession.accountId
      );
      return sendJson(res, 200, { orders });
    }

    if (req.method === "POST" && url.pathname === "/admin/orders/reached-warehouse") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      const orderId = String(body.orderId || "");
      try {
        const existing = (await store.listOrders()).find(
          (order) =>
            order.id === orderId &&
            ((order.businessAccountId || config.accountId) === adminSession.accountId ||
              DASHBOARD_DEMO_ORDER_IDS.has(order.id))
        );
        if (!existing) return sendJson(res, 404, { error: "Order not found." });
        if (existing.status !== "pending_admin_order") {
          return sendJson(res, 400, { error: "Only Order Submitted orders can be marked as Reached Warehouse." });
        }
        const order = await store.updateOrderStatus(orderId, "reached_warehouse", adminSession.accountId);
        const outboundAccountId = order.businessAccountId || adminSession.accountId;
        const statusReplies = await store.getOrderStatusReplies(outboundAccountId);
        const message = reachedWarehouseCustomerMessage(order, statusReplies.reached_warehouse);
        await delayBeforeStatusReply(order.customerId, "reached warehouse status reply");
        await sendOutbound(order.customerId, [textMessage(message)], {
          businessAccountId: outboundAccountId,
          purpose: "order_reached_warehouse",
          channel: "business_admin",
          from: `business_admin:${adminSession.accountId}`,
        });
        await store.appendAuditLog({
          actor: `admin:${adminSession.accountId}`,
          action: "order_reached_warehouse",
          customerId: order.customerId,
          result: order.id,
          businessAccountId: outboundAccountId,
        });
        return sendJson(res, 200, { order: formatOrderAdminRow(order), message });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/admin/order-status-replies") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      return sendJson(res, 200, {
        options: ORDER_STATUS_OPTIONS,
        replies: await store.getOrderStatusReplies(adminSession.accountId),
      });
    }

    if (req.method === "POST" && url.pathname === "/admin/order-status-replies") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      try {
        const replies = await store.saveOrderStatusReplies(adminSession.accountId, body.replies || {});
        await store.appendAuditLog({
          actor: `admin:${adminSession.accountId}`,
          action: "order_status_replies_updated",
          result: adminSession.accountId,
        });
        return sendJson(res, 200, { options: ORDER_STATUS_OPTIONS, replies });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/admin/dashboard-data") {
      const selectedDate = parseSelectedDate(url.searchParams.get("date"));
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      return sendJson(res, 200, await buildDashboardData(new Date(), selectedDate, adminSession.accountId));
    }

    if (req.method === "POST" && url.pathname === "/admin/profile") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      try {
        const profile = await operations.updateDashboardProfile({
          name: body.name,
          accentColor: body.accentColor,
        });
        await store.appendAuditLog({
          actor: `admin:${adminSession.accountId}`,
          action: "dashboard_profile_updated",
          result: profile.name,
        });
        return sendJson(res, 200, { profile });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/admin/dashboard") {
      return sendHtml(res, 200, adminDashboardHtml());
    }

    if (req.method === "GET" && url.pathname === "/admin/chat") {
      return sendHtml(res, 200, adminChatPageHtml());
    }

    if (req.method === "GET" && url.pathname === "/admin/whatsapp-web") {
      return sendHtml(res, 200, whatsappWebStatusHtml());
    }

    if (req.method === "GET" && url.pathname === "/admin/whatsapp-web/status") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      return sendJson(res, 200, await webTransportStatusForAccount(adminSession.accountId));
    }

    if (req.method === "GET" && url.pathname === "/admin/whatsapp-web/qr.svg") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      return sendQrSvg(res, adminSession.accountId);
    }

    if (req.method === "GET" && url.pathname === "/admin/whatsapp-web/qr-only") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      return sendHtml(res, 200, whatsappWebQrOnlyHtml(adminSession.accountId));
    }

    if (req.method === "POST" && url.pathname === "/admin/whatsapp-web/pairing-code") {
      if (!webTransportManager) {
        return sendJson(res, 400, { error: "WhatsApp Web transport is not enabled." });
      }
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      try {
        const code = await webTransportManager.requestPairingCode(adminSession.accountId, body.phoneNumber || "");
        return sendJson(res, 200, { code, status: webTransportManager.getStatus(adminSession.accountId) });
      } catch (error) {
        return sendJson(res, 400, { error: error.message, status: webTransportManager.getStatus(adminSession.accountId) });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/whatsapp-web/disconnect") {
      if (!webTransportManager) {
        return sendJson(res, 400, { error: "WhatsApp Web transport is not enabled." });
      }
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      try {
        await webTransportManager.disconnect(adminSession.accountId, { reconnect: true });
        return sendJson(res, 200, { ok: true, status: webTransportManager.getStatus(adminSession.accountId) });
      } catch (error) {
        return sendJson(res, 500, { error: error.message, status: webTransportManager.getStatus(adminSession.accountId) });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/handoff/complaint/resolve") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      try {
        const complaint = await store.resolveComplaintCase(
          String(body.caseId || ""),
          adminSession.accountId,
          `admin:${adminSession.accountId}`
        );
        const hasOpenComplaint = (await store.listComplaintCases(adminSession.accountId)).some(
          (item) => item.customerId === complaint.customerId && item.status !== "resolved"
        );
        if (!hasOpenComplaint) {
          await store.updateCustomer(complaint.customerId, (customer) => ({
            complaintStatus: "resolved",
            complaintResolvedAt: complaint.resolvedAt,
            handoffStatus: customer.handoffReason?.startsWith("Complaint") ? "" : customer.handoffStatus,
            handoffReason: customer.handoffReason?.startsWith("Complaint") ? "" : customer.handoffReason,
            followupBlocked: Boolean(customer.optedOut),
            followupBlockedReason: customer.optedOut ? customer.followupBlockedReason : "",
          }), adminSession.accountId);
        }
        await store.appendAuditLog({
          actor: `admin:${adminSession.accountId}`,
          action: "complaint_resolved",
          customerId: complaint.customerId,
          result: complaint.id,
        });
        return sendJson(res, 200, { complaint });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/handoff/acknowledge") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      const customerId = String(body.customerId || "").trim();
      const caseId = String(body.caseId || "").trim();
      const type = String(body.type || "conversation").trim();
      try {
        if (type === "complaint" || caseId) {
          const complaint = await store.resolveComplaintCase(
            caseId,
            adminSession.accountId,
            `admin:${adminSession.accountId}`
          );
          const hasOpenComplaint = (await store.listComplaintCases(adminSession.accountId)).some(
            (item) => item.customerId === complaint.customerId && item.status !== "resolved"
          );
          if (!hasOpenComplaint) {
            await store.updateCustomer(complaint.customerId, (customer) => ({
              complaintStatus: "resolved",
              complaintResolvedAt: complaint.resolvedAt,
              handoffStatus: customer.handoffReason?.startsWith("Complaint") ? "" : customer.handoffStatus,
              handoffReason: customer.handoffReason?.startsWith("Complaint") ? "" : customer.handoffReason,
              handoffAcknowledgedAt: new Date().toISOString(),
              handoffAcknowledgedBy: `admin:${adminSession.accountId}`,
              followupBlocked: Boolean(customer.optedOut),
              followupBlockedReason: customer.optedOut ? customer.followupBlockedReason : "",
            }), adminSession.accountId);
          }
          await store.appendAuditLog({
            actor: `admin:${adminSession.accountId}`,
            action: "handoff_acknowledged",
            customerId: complaint.customerId,
            result: complaint.id,
          });
          return sendJson(res, 200, { acknowledged: true, customerId: complaint.customerId, caseId: complaint.id });
        }

        if (!customerId) return sendJson(res, 400, { error: "Customer ID is required." });
        const customer = await store.updateCustomer(customerId, () => ({
          handoffStatus: "",
          handoffReason: "",
          handoffAcknowledgedAt: new Date().toISOString(),
          handoffAcknowledgedBy: `admin:${adminSession.accountId}`,
        }), adminSession.accountId);
        await store.appendAuditLog({
          actor: `admin:${adminSession.accountId}`,
          action: "handoff_acknowledged",
          customerId,
          result: customer.handoffAcknowledgedAt || "",
          businessAccountId: adminSession.accountId,
        });
        return sendJson(res, 200, { acknowledged: true, customerId });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/manual-reply") {
      const body = await readJsonBody(req);
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const customerId = String(body.customerId || "").trim();
      const replyText = String(body.text || "").trim();
      if (!replyText) return sendJson(res, 400, { error: "Reply message is required." });
      if (replyText.length > config.maxReplyChars) {
        return sendJson(res, 400, { error: `Reply must be ${config.maxReplyChars} characters or fewer.` });
      }
      const customer = (await store.listCustomers()).find(
        (item) => item.id === customerId && (item.businessAccountId || config.accountId) === adminSession.accountId
      );
      if (!customer) return sendJson(res, 404, { error: "Customer not found." });
      const lastInboundAt = new Date(customer.lastInboundAt || customer.firstSeenAt || 0).getTime();
      if (config.transportMode === "cloud" && !config.demoMode && (!Number.isFinite(lastInboundAt) || Date.now() - lastInboundAt > DAY_MS)) {
        return sendJson(res, 409, {
          error: "The 24-hour customer service window has ended. Send an approved WhatsApp template instead.",
        });
      }
      try {
        await sendOutbound(customerId, [textMessage(replyText)], {
          channel: "business_admin",
          from: `business_admin:${adminSession.accountId}`,
          businessAccountId: adminSession.accountId,
        });
        let learnedFaq = null;
        try {
          learnedFaq = await maybeLearnFromManualReply(customer, replyText, adminSession.accountId);
        } catch (learningError) {
          await recordSystemError("manual_reply_learning", learningError, `Customer: ${customerId}`, adminSession.accountId);
        }
        await store.updateCustomer(customerId, () => ({
          handoffStatus: "",
          handoffReason: "",
          lastLearnedFaqId: learnedFaq?.id || customer.lastLearnedFaqId || "",
        }), adminSession.accountId);
        await store.appendAuditLog({
          actor: `admin:${adminSession.accountId}`,
          action: "manual_reply_sent",
          customerId,
          result: learnedFaq ? `sent_via_whatsapp_api; learned_faq:${learnedFaq.id}` : "sent_via_whatsapp_api",
        });
        return sendJson(res, 200, { ok: true, customerId, learnedFaq });
      } catch (error) {
        const detail = String(error.message || "Unknown send error").trim();
        const failedId = error.failedMessageId || "";
        return sendJson(res, 502, {
          error: failedId
            ? `Message was not sent: ${detail} (failed queue: ${failedId})`
            : `Message was not sent: ${detail}`,
          failedMessageId: failedId,
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/chat/delete-conversation") {
      const body = await readJsonBody(req);
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const customerId = String(body.customerId || "").trim();
      if (!customerId) return sendJson(res, 400, { error: "Customer ID is required." });
      const customer = (await store.listCustomers(new Date(), adminSession.accountId)).find((item) => item.id === customerId);
      if (!customer) return sendJson(res, 404, { error: "Customer not found." });
      try {
        const result = await store.deleteConversationMessages(customerId, adminSession.accountId);
        await store.appendAuditLog({
          actor: `admin:${adminSession.accountId}`,
          action: "chat_conversation_deleted",
          customerId,
          businessAccountId: adminSession.accountId,
          result: `${result.deleted} message(s) deleted`,
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/admin/product-flow") {
      return sendHtml(res, 200, productFlowPageHtml());
    }

    if (req.method === "GET" && url.pathname === "/admin/product-flow-data") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const content = await getTeamContent(adminSession.accountId);
      const settings = await adminAccounts.getTeamSettings(adminSession.accountId);
      return sendJson(res, 200, {
        products: content.catalog.products.map(productFlowEditorData),
        vectorStoreId: settings.openaiVectorStoreId || config.vectorStoreId || "",
        orderStatusReplies: await store.getOrderStatusReplies(adminSession.accountId),
      });
    }

    if (req.method === "POST" && url.pathname === "/admin/product-flow/knowledge/sync-vector-store") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      if (!(await openAiApiKeyForAccount(adminSession.accountId))) {
        return sendJson(res, 400, { error: "OpenAI API key is not configured for this team or Railway." });
      }
      if (knowledgeSyncRuns.has(adminSession.accountId)) {
        return sendJson(res, 409, { error: "Knowledge sync is already running for this team." });
      }
      const run = runTeamKnowledgeIngest(adminSession.accountId);
      knowledgeSyncRuns.set(adminSession.accountId, run);
      try {
        const result = await run;
        const settings = await adminAccounts.getTeamSettings(adminSession.accountId);
        await store.appendAuditLog({
          actor: `admin:${adminSession.accountId}`,
          action: "vector_store_knowledge_synced",
          result: settings.openaiVectorStoreId || config.vectorStoreId || result.vectorStoreId || "",
        });
        return sendJson(res, 200, {
          ...result,
          vectorStoreId: settings.openaiVectorStoreId || config.vectorStoreId || result.vectorStoreId || "",
        });
      } catch (error) {
        await recordSystemError("vector_store_knowledge_sync", error, "", adminSession.accountId);
        return sendJson(res, 500, { error: error.message || "Knowledge sync failed." });
      } finally {
        knowledgeSyncRuns.delete(adminSession.accountId);
      }
    }

    if (req.method === "GET" && (url.pathname === "/admin/reply-library" || url.pathname === "/admin/faq-library")) {
      return sendHtml(res, 200, replyLibraryPageHtml());
    }

    if (req.method === "GET" && url.pathname === "/admin/faq-library-data") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const content = await getTeamContent(adminSession.accountId);
      return sendJson(res, 200, faqLibraryData(content));
    }

    if (req.method === "POST" && url.pathname === "/admin/faq-library/save") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      try {
        const content = await getTeamContent(adminSession.accountId);
        const faq = saveApprovedFaq(body, content);
        await saveTeamContent(adminSession.accountId, content);
        return sendJson(res, 200, { faq, data: faqLibraryData(content) });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/faq-library/delete") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      try {
        const content = await getTeamContent(adminSession.accountId);
        const deleted = deleteApprovedFaq(body, content);
        await saveTeamContent(adminSession.accountId, content);
        return sendJson(res, 200, { deleted, data: faqLibraryData(content) });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/admin/sales-replies") {
      return sendHtml(res, 200, replyLibraryPageHtml());
    }

    if (req.method === "GET" && url.pathname === "/admin/sales-replies-data") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const content = await getTeamContent(adminSession.accountId);
      return sendJson(res, 200, salesRepliesData(content));
    }

if (req.method === "POST" && url.pathname === "/admin/sales-replies/save") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      try {
        const content = await getTeamContent(adminSession.accountId);
        const salesReply = saveSalesReply(body, content);
        await saveTeamContent(adminSession.accountId, content);
        return sendJson(res, 200, { salesReply, data: salesRepliesData(content) });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/sales-replies/delete") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      try {
        const content = await getTeamContent(adminSession.accountId);
        const deleted = deleteSalesReply(body, content);
        await saveTeamContent(adminSession.accountId, content);
        return sendJson(res, 200, { deleted, data: salesRepliesData(content) });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/product-flow/create") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      const name = String(body.name || "").trim();
      if (!name) return sendJson(res, 400, { error: "Product name is required." });
      const content = await getTeamContent(adminSession.accountId);
      const product = createCatalogProduct(name);
      content.catalog.products.push(product);
      await saveTeamContent(adminSession.accountId, content);
      return sendJson(res, 201, { product: productFlowEditorData(product) });
    }

    if (req.method === "POST" && url.pathname === "/admin/product-flow/delete") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      const content = await getTeamContent(adminSession.accountId);
      try {
        const deleted = deleteCatalogProduct(String(body.productId || ""), content.catalog);
        await saveTeamContent(adminSession.accountId, content);
        return sendJson(res, 200, {
          deleted,
          products: content.catalog.products.map(productFlowEditorData),
        });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/product-flow/save") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      const content = await getTeamContent(adminSession.accountId);
      const product = findCatalogProduct(body.productId, content.catalog);
      if (!product) return sendJson(res, 404, { error: "Product not found." });
      try {
        updateProductFlowText(product, body);
        await saveTeamContent(adminSession.accountId, content);
        return sendJson(res, 200, { product: productFlowEditorData(product) });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/product-flow/image") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      const content = await getTeamContent(adminSession.accountId);
      const product = findCatalogProduct(body.productId, content.catalog);
      if (!product) return sendJson(res, 404, { error: "Product not found." });
      const existingBlocks = Object.prototype.hasOwnProperty.call(body, "openingFlowBlocks")
        ? normalizeOpeningFlowBlocks(body.openingFlowBlocks, productFlowEditorData(product, { skipReady: true }))
        : null;
      if (existingBlocks) {
        product.opening_flow_blocks = existingBlocks;
        product.opening_flow = buildProductOpeningFlowFromBlocks(product.opening_flow_blocks);
      }
      const slot = productFlowImageSlotForUpload(product, body.slot);
      if (!slot) return sendJson(res, 400, { error: "Unknown image slot." });
      const image = decodeUploadedImage(body.dataUrl);
      if (!image) return sendJson(res, 400, { error: "Please upload a PNG, JPG, or WEBP image." });
      if (image.bytes.length > 10 * 1024 * 1024) {
        return sendJson(res, 400, { error: "Image must be 10 MB or smaller." });
      }
      const accountAssetId = safeAssetSegment(adminSession.accountId);
      const productAssetId = safeAssetSegment(product.id);
      const targetDirectory = path.join(config.assetsDir, accountAssetId, productAssetId);
      await mkdir(targetDirectory, { recursive: true });
      const originalName = String(body.originalName || "").trim();
      const originalBase = safeAssetSegment(path.basename(originalName, path.extname(originalName)));
      const filename = originalBase && !["file", "image", "blob"].includes(originalBase)
        ? `${slot.filename}-${originalBase}.${image.extension}`
        : `${slot.filename}.${image.extension}`;
      await writeFile(path.join(targetDirectory, filename), image.bytes);
      const assetUrl = `/assets/${accountAssetId}/${productAssetId}/${filename}`;
      const durableUrl = persistedProductImageUrl(adminSession.accountId, product.id, slot.key, image.extension);
      persistProductFlowImage(product, slot, {
        dataUrl: body.dataUrl,
        image,
        originalName,
        assetUrl,
        durableUrl,
      });
      updateProductFlowImage(product, slot, durableUrl);
      const extraction = await ingestProductImageKnowledge(product, {
        slot,
        assetUrl: durableUrl,
        originalName,
        dataUrl: body.dataUrl,
        businessAccountId: adminSession.accountId,
      });
      await saveTeamContent(adminSession.accountId, content);
      return sendJson(res, 200, { product: productFlowEditorData(product), extraction });
    }

    if (req.method === "POST" && url.pathname === "/admin/product-flow/knowledge/extract-existing") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      const content = await getTeamContent(adminSession.accountId);
      const product = findCatalogProduct(body.productId, content.catalog);
      if (!product) return sendJson(res, 404, { error: "Product not found." });
      const extraction = await extractExistingProductImageKnowledge(product, adminSession.accountId);
      await saveTeamContent(adminSession.accountId, content);
      return sendJson(res, 200, { product: productFlowEditorData(product), extraction });
    }

    if (req.method === "POST" && url.pathname === "/admin/product-flow/knowledge/clean-pending") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      const content = await getTeamContent(adminSession.accountId);
      const product = findCatalogProduct(body.productId, content.catalog);
      if (!product) return sendJson(res, 404, { error: "Product not found." });
      const result = cleanPendingExtractedFacts(product);
      await saveTeamContent(adminSession.accountId, content);
      return sendJson(res, 200, { product: productFlowEditorData(product), result });
    }

    if (req.method === "POST" && url.pathname === "/admin/product-flow/knowledge/approve") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      const content = await getTeamContent(adminSession.accountId);
      const product = findCatalogProduct(body.productId, content.catalog);
      if (!product) return sendJson(res, 404, { error: "Product not found." });
      const result = approveExtractedProductFact(product, String(body.factId || ""));
      await saveTeamContent(adminSession.accountId, content);
      return sendJson(res, 200, { product: productFlowEditorData(product), result });
    }

    if (req.method === "POST" && url.pathname === "/admin/product-flow/knowledge/delete") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const body = await readJsonBody(req);
      const content = await getTeamContent(adminSession.accountId);
      const product = findCatalogProduct(body.productId, content.catalog);
      if (!product) return sendJson(res, 404, { error: "Product not found." });
      const result = deleteExtractedProductFact(product, String(body.factId || ""), String(body.status || "pending"));
      await saveTeamContent(adminSession.accountId, content);
      return sendJson(res, 200, { product: productFlowEditorData(product), result });
    }

    if (req.method === "GET" && url.pathname === "/admin/analytics") {
      return sendHtml(res, 200, analyticsPageHtml());
    }

    if (req.method === "GET" && url.pathname === "/admin/compliance") {
      return sendHtml(res, 200, compliancePageHtml());
    }

    if (req.method === "GET" && url.pathname === "/admin/compliance-data") {
      return sendJson(res, 200, await buildComplianceData());
    }

    if (req.method === "GET" && url.pathname === "/admin/customer/export") {
      const customerId = url.searchParams.get("customerId") || "";
      if (!customerId) return sendText(res, 400, "Missing customerId");
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const data = await store.exportCustomerData(customerId, adminSession.accountId);
      await store.appendAuditLog({
        action: "customer_export",
        customerId,
        result: data.status,
      });
      return sendJson(res, 200, data);
    }

    if (req.method === "POST" && url.pathname === "/admin/customer/delete") {
      const body = await readJsonBody(req);
      const customerId = String(body.customerId || "");
      if (!customerId) return sendText(res, 400, "Missing customerId");
      const reason = String(body.reason || "Manual admin deletion");
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const deleted = await store.deleteCustomer(customerId, reason, new Date(), adminSession.accountId);
      await store.appendAuditLog({
        action: "customer_delete",
        customerId,
        result: deleted ? "deleted" : "not_found",
        reason,
      });
      return sendJson(res, 200, { deleted: Boolean(deleted), customer: deleted });
    }

    if (req.method === "POST" && url.pathname === "/admin/customer/opt-out") {
      const body = await readJsonBody(req);
      const customerId = String(body.customerId || "");
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      if (!customerId) return sendJson(res, 400, { error: "Missing customerId." });
      const updated = await store.updateCustomer(customerId, () => ({
        optedOut: true,
        optedOutAt: new Date().toISOString(),
        followupBlocked: true,
        followupBlockedReason: "manual_admin_opt_out",
        handoffStatus: "",
        handoffReason: "",
      }), adminSession.accountId);
      await store.appendAuditLog({
        actor: `business_admin:${adminSession.accountId}`,
        action: "customer_opt_out",
        customerId,
        result: "opted_out",
        businessAccountId: adminSession.accountId,
      });
      return sendJson(res, 200, { customer: updated });
    }

    if (req.method === "POST" && url.pathname === "/admin/customer/mark-order-submitted") {
      const body = await readJsonBody(req);
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      const customerId = String(body.customerId || "").trim();
      if (!customerId) return sendJson(res, 400, { error: "Missing customerId." });
      const customer = await store.getOrCreateCustomer(customerId, { businessAccountId: adminSession.accountId });
      const content = await getTeamContent(adminSession.accountId);
      const product =
        findCatalogProduct(body.productId, content.catalog) ||
        findCatalogProduct(customer.productId, content.catalog) ||
        content.catalog.products.find((item) => item.id === content.catalog.default_product_id) ||
        content.catalog.products[0];
      if (!product) return sendJson(res, 400, { error: "No product available for this order." });
      const option = dashboardOrderOptions(product).find((item) => item.id === String(body.orderOptionId || ""));
      const quantity = Math.max(1, Number(body.quantity || option?.quantity || 1) || 1);
      const name = String(body.name || "").trim();
      const phone = String(body.phone || customerId).trim();
      const address = String(body.address || "").trim();
      if (!name || !phone || !address) {
        return sendJson(res, 400, { error: "Name, phone, and address are required to submit the order." });
      }
      const order = await store.addOrder({
        businessAccountId: adminSession.accountId,
        customerId,
        productId: product.id,
        productName: product.name,
        shoppingLink: product.shopping_link || "",
        packageId: option?.legacyPackage ? legacyPackageIdForDashboardOption(option) : "",
        packageName: option?.legacyPackage ? option.name : "",
        packagePrice: option?.legacyPackage ? option.price : "",
        orderOptionId: option?.legacyPackage ? "" : option?.id || "",
        orderOptionName: option?.legacyPackage ? "" : option?.name || String(body.orderOptionName || "").trim(),
        orderOptionPrice: option?.legacyPackage ? "" : option?.price || String(body.orderOptionPrice || "").trim(),
        addOnChoice: String(body.addOnChoice || "").trim(),
        quantity,
        name,
        phone,
        address,
        rawMessage: String(body.rawMessage || "Manual admin order submission").trim(),
        statusHistory: [{ status: "pending_admin_order", at: new Date().toISOString(), actor: `admin:${adminSession.accountId}` }],
      });
      const updatedCustomer = await store.updateCustomer(customerId, () => ({
        productId: product.id,
        pendingOrder: null,
        awaitingPackageBInterest: false,
        handoffStatus: "human_required",
        handoffReason: "Customer submitted complete order details.",
        complaintCaseId: "",
        complaintStatus: "",
        complaintCategory: "",
        complaintAt: "",
        status: "order_submitted",
        salesStatus: "",
        anotherDatePurchaseDate: "",
        anotherDatePurchaseText: "",
        followupBlocked: true,
        followupBlockedReason: "order_submitted",
      }), adminSession.accountId);
      await store.appendAuditLog({
        action: "manual_order_submitted",
        customerId,
        result: order.id,
        businessAccountId: adminSession.accountId,
      });
      return sendJson(res, 200, { order: formatOrderAdminRow(order), customer: updatedCustomer });
    }

    if (req.method === "POST" && url.pathname === "/admin/reset-demo-data") {
      await store.resetDemoData();
      return sendJson(res, 200, { ok: true, resetAt: new Date().toISOString() });
    }

    if (req.method === "POST" && url.pathname === "/admin/generate-test-customers") {
      if (testCustomerGenerationActive) {
        return sendJson(res, 409, {
          ok: false,
          error: "Test customer generation is already running. Please wait for it to finish.",
        });
      }
      const body = await readJsonBody(req).catch(() => ({}));
      const count = Math.max(1, Math.min(Number(body.count || 100), 500));
      testCustomerGenerationActive = true;
      try {
        const result = await generateTestCustomers(count);
        return sendJson(res, 200, result);
      } finally {
        testCustomerGenerationActive = false;
      }
    }

    if (req.method === "GET" && url.pathname === "/demo/state") {
      return sendJson(res, 200, {
        customers: await store.listCustomers(),
        deletedCustomers: await store.listDeletedCustomers(),
        orders: await store.listOrders(),
        outbox: await store.listOutbox(),
      });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        demoMode: config.demoMode,
        transportMode: config.transportMode,
        webTransport: await webTransportHealthData(),
        webhookPath: config.webhookPath,
        model: config.openaiModel,
        extractionModel: config.extractionModel,
        embeddingModel: config.embeddingModel,
        approvedKnowledgeVectorStoreRagEnabled: Boolean(config.openaiApiKey && config.vectorStoreId),
        webhookDiagnostics,
        products: catalog.products.map((product) => ({ id: product.id, name: product.name })),
      });
    }

    if (req.method === "GET" && url.pathname === "/privacy") {
      return sendHtml(res, 200, publicPrivacyHtml());
    }

    if (req.method === "GET" && url.pathname === "/data-deletion") {
      return sendHtml(res, 200, publicDataDeletionHtml());
    }

    if (req.method === "GET" && url.pathname === "/demo/chat") {
      const adminSession = readSessionToken(parseCookies(req.headers.cookie || "").wa_admin);
      return sendHtml(res, 200, await demoChatHtml(adminSession?.accountId || config.accountId));
    }

    sendText(res, 404, "Not found");
  } catch (error) {
    await recordSystemError("http_request", error, `${req.method} ${req.url}`);
    sendText(res, 500, "Internal server error");
  }
});

if (!config.skipHttpServer) {
  server.listen(config.port, () => {
    console.log(`WhatsApp AI customer service agent listening on http://localhost:${config.port}`);
    console.log(`Mode: ${config.demoMode ? "demo/local outbox" : config.transportMode === "web" ? "WhatsApp Web QR" : "WhatsApp Cloud API"}`);
    console.log(`Webhook endpoint: ${config.webhookPath}`);
  });
}

if (!config.skipHttpServer && webTransportManager) {
  void adminAccounts.listAccounts()
    .then((accounts) => webTransportManager.start({
      accounts,
      onMessage: async (message) => {
        if (alreadyProcessed(message.id)) return;
        if (message.source?.fromMe) {
          await handleManualBusinessMessage(message);
          return;
        }
        if (!message.text && message.mediaType) {
          await recordInboundMediaHandoff({
            id: message.id,
            from: message.from,
            mediaType: message.mediaType,
            source: message.source || {},
            businessAccountId: message.businessAccountId || config.accountId,
          });
          return;
        }
        await processInboundMessage(message);
      },
    }))
    .catch((error) => recordSystemError("web_transport_start", error));
}

if (!config.skipHttpServer && config.followupAutorun) {
  scheduleFollowupAutorun();
}

async function followupAutorunIntervalMinutes() {
  try {
    const accounts = await adminAccounts.listAccounts();
    const intervals = accounts
      .map((account) => Number(account.settings?.followupIntervalMinutes || 0))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (intervals.length) return Math.min(...intervals);
  } catch (error) {
    await recordSystemError("followup_interval_settings", error);
  }
  return Math.max(config.followupIntervalMinutes, 1);
}

function scheduleFollowupAutorun() {
  void (async () => {
    const intervalMinutes = await followupAutorunIntervalMinutes();
    setTimeout(async () => {
      try {
        await requestFollowupRun();
      } catch (error) {
        await recordSystemError("followup_run", error);
      } finally {
        scheduleFollowupAutorun();
      }
    }, Math.max(intervalMinutes, 1) * 60 * 1000);
  })();
}

function handleVerification(url, res) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === config.verifyToken && challenge) {
    return sendText(res, 200, challenge);
  }

  return sendText(res, 403, "Verification failed");
}

function noteWebhookReceived(headers, rawBody) {
  webhookDiagnostics.received += 1;
  webhookDiagnostics.lastAt = new Date().toISOString();
  webhookDiagnostics.lastSignature = headers["x-hub-signature-256"] ? "present" : "missing";
  webhookDiagnostics.lastError = "";
  console.log(`Webhook POST received (${rawBody.length} bytes, signature ${webhookDiagnostics.lastSignature})`);
}

function noteWebhookInvalidSignature() {
  webhookDiagnostics.invalidSignature += 1;
  webhookDiagnostics.lastError = "invalid_signature";
  console.warn("Webhook POST rejected: invalid signature");
}

function noteWebhookPayload(payload, { statuses = [], messages = [] } = {}) {
  webhookDiagnostics.processed += 1;
  webhookDiagnostics.statuses += statuses.length;
  webhookDiagnostics.messages += messages.length;
  webhookDiagnostics.lastObject = String(payload?.object || "");
  const firstChange = payload?.entry?.[0]?.changes?.[0];
  webhookDiagnostics.lastField = String(firstChange?.field || "");
  const firstMessage = messages[0];
  webhookDiagnostics.lastMessageFrom = String(firstMessage?.from || "");
  webhookDiagnostics.lastMessageType = String(firstMessage?.type || "");
  console.log(`Webhook payload processed: ${messages.length} message(s), ${statuses.length} status update(s)`);
}

function noteWebhookError(error) {
  webhookDiagnostics.lastError = error?.message || String(error);
  console.error("Webhook payload processing failed:", webhookDiagnostics.lastError);
}

async function handleWebhookPayload(rawBody) {
  try {
    const payload = JSON.parse(rawBody.toString("utf8"));
    const statuses = extractOutboundStatuses(payload);
    const messages = extractInboundMessages(payload);
    noteWebhookPayload(payload, { statuses, messages });
    for (const status of statuses) {
      noteOutboundStatus(status);
    }

    for (const message of messages) {
      if (alreadyProcessed(message.id)) continue;
      const businessAccountId = await businessAccountIdForPhoneNumber(message.phoneNumberId);
      const text = getMessageText(message);
      if (!text) {
        await recordInboundMediaHandoff({
          id: message.id,
          from: message.from,
          mediaType: inboundWebhookMediaType(message),
          source: extractMessageSource(message),
          businessAccountId,
        });
        continue;
      }

      await processInboundMessage({
        id: message.id,
        from: message.from,
        text,
        source: extractMessageSource(message),
        live: true,
        businessAccountId,
      });
    }
  } catch (error) {
    noteWebhookError(error);
    throw error;
  }
}

async function recentConversationContext(customerId, businessAccountId, limit = 10) {
  const messages = await store.listOutbox(businessAccountId);
  return messages
    .filter((message) =>
      message.channel === "customer" &&
      String(message.businessAccountId || config.accountId) === String(businessAccountId || config.accountId) &&
      (message.from === customerId || message.to === customerId)
    )
    .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")))
    .slice(-limit)
    .map((message) => ({
      role: message.direction === "inbound" ? "customer" : "agent",
      text: message.body || message.caption || "",
      type: message.type || "text",
      at: message.createdAt || "",
    }))
    .filter((message) => String(message.text || "").trim());
}

async function recentProductContextMatch(customerId, businessAccountId, catalog, source = {}, limit = 12) {
  const directMatch = findProductMatch(catalog, "", source);
  if (directMatch) return directMatch;
  const messages = await store.listOutbox(businessAccountId);
  const contextText = messages
    .filter((message) =>
      String(message.businessAccountId || config.accountId) === String(businessAccountId || config.accountId) &&
      (message.from === customerId || message.to === customerId) &&
      ["customer", "business_admin"].includes(String(message.channel || ""))
    )
    .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")))
    .slice(-limit)
    .map((message) => message.body || message.caption || "")
    .filter(Boolean)
    .join("\n");
  return findProductMatch(catalog, contextText, source);
}

function shouldStartNewProductJourney(customer = {}, product = null) {
  return Boolean(
    product?.id &&
    customer.productId &&
    product.id !== customer.productId &&
    !customer.pendingOrder &&
    customer.complaintStatus !== "open"
  );
}

function newProductJourneyPatch(customer = {}, product = null, now = new Date()) {
  if (!shouldStartNewProductJourney(customer, product)) return {};
  const nowIso = now.toISOString();
  return {
    firstSeenAt: nowIso,
    lastMessageAt: nowIso,
    lastInboundAt: nowIso,
    productId: product.id,
    followupsSent: {},
    pendingOrder: null,
    awaitingPackageBInterest: false,
    lastSalesReplyId: "",
    lastApprovedFaqId: "",
    handoffStatus: "",
    handoffReason: "",
    source: {
      ...(customer.source || {}),
      previousProductId: customer.productId || "",
      productJourneyResetAt: nowIso,
    },
    ...(customer.optedOut
      ? {}
      : {
          followupBlocked: false,
          followupBlockedReason: "",
        }),
  };
}

function customerContactPatch(customerId, source = {}) {
  const phone = phoneFromCustomerSource(customerId, source);
  return phone ? { phone } : {};
}

function phoneFromCustomerSource(customerId, source = {}) {
  return (
    cleanCustomerPhone(source.phone) ||
    cleanCustomerPhone(source.phoneNumber) ||
    cleanCustomerPhone(source.senderPhone) ||
    phoneFromJid(source.remoteJid) ||
    phoneFromJid(source.senderJid) ||
    phoneFromJid(source.participant) ||
    cleanCustomerPhone(customerId)
  );
}

function phoneFromJid(value) {
  const text = String(value || "").trim();
  if (!text || text.endsWith("@lid")) return "";
  if (!/@/.test(text)) return cleanCustomerPhone(text);
  const [user, server] = text.split("@");
  if (!["s.whatsapp.net", "c.us"].includes(server)) return "";
  return cleanCustomerPhone(user);
}

function cleanCustomerPhone(value) {
  const text = String(value || "").trim();
  if (!text || text.includes("@lid")) return "";
  const digits = text.replace(/\D/g, "");
  if (digits.length < 5 || digits.length > 18) return "";
  return digits;
}

function normalizeInboundMediaType(mediaType = "") {
  const type = String(mediaType || "").toLowerCase();
  if (type === "voice" || type === "audio") return "audio";
  if (type === "image") return "image";
  if (type === "video") return "video";
  return "media";
}

function inboundMediaPlaceholder(mediaType = "media") {
  if (mediaType === "audio") return "[Customer sent a voice message]";
  if (mediaType === "image") return "[Customer sent an image]";
  if (mediaType === "video") return "[Customer sent a video]";
  return "[Customer sent a media message]";
}

async function recordInboundMediaHandoff({
  id = "",
  from,
  mediaType = "media",
  source = {},
  businessAccountId = config.accountId,
}) {
  const normalizedMediaType = normalizeInboundMediaType(mediaType);
  const contactPatch = customerContactPatch(from, source);
  if (id && await store.hasOutboxMessageId(id, businessAccountId)) {
    console.log(`Skipping duplicate inbound ${normalizedMediaType} message ${id} from ${from}.`);
    return {
      customer: await store.getOrCreateCustomer(from, { businessAccountId, ...contactPatch }),
      messages: [],
    };
  }
  console.log(`Incoming WhatsApp ${normalizedMediaType} message from ${from}; routed to handoff.`);
  await store.appendOutbox({
    ...(id ? { id } : {}),
    direction: "inbound",
    from,
    to: "agent",
    businessAccountId,
    channel: "customer",
    type: normalizedMediaType,
    body: inboundMediaPlaceholder(normalizedMediaType),
  });
  const nowIso = new Date().toISOString();
  const customer = await store.getOrCreateCustomer(from, {
    lastInboundMessageId: id,
    lastMessageAt: nowIso,
    lastInboundAt: nowIso,
    recordInbound: true,
    businessAccountId,
    source,
    ...contactPatch,
    handoffStatus: "human_required",
    handoffReason: `Customer sent ${normalizedMediaType}; manual reply required.`,
  });
  await store.appendAuditLog({
    actor: "ai_agent",
    action: "media_message_handoff",
    customerId: from,
    businessAccountId,
    result: normalizedMediaType,
  });
  return { customer, messages: [] };
}

async function processInboundMessage({
  id,
  from,
  text,
  source = {},
  live = false,
  businessAccountId = config.accountId,
  contentAccountId = businessAccountId,
  knowledgeAccountId = contentAccountId,
  skipOrderDetailBuffer = false,
  skipMessageMergeBuffer = false,
  skipInboundRecord = false,
}) {
  console.log(`Incoming WhatsApp message from ${from}: ${text}`);
  const contactPatch = customerContactPatch(from, source);
  if (!skipInboundRecord && id && await store.hasOutboxMessageId(id, businessAccountId)) {
    console.log(`Skipping duplicate inbound message ${id} from ${from}.`);
    return {
      customer: await store.getOrCreateCustomer(from, { businessAccountId, ...contactPatch }),
      order: null,
      messages: [],
      handoffRequired: false,
      handoffReason: "Duplicate inbound message skipped.",
    };
  }
  const content = await getTeamContent(contentAccountId);
  const teamCatalog = content.catalog;
  const teamFaqLibrary = content.faqLibrary;
  const teamSalesReplyLibrary = content.salesReplyLibrary;
  if (!skipInboundRecord) {
    await store.appendOutbox({
      ...(id ? { id } : {}),
      direction: "inbound",
      from,
      to: "agent",
      businessAccountId,
      channel: "customer",
      type: "text",
      body: text,
    });
  }
  const nowIso = new Date().toISOString();
  const customer = skipInboundRecord
    ? await store.getOrCreateCustomer(from, { businessAccountId, ...contactPatch })
    : await store.getOrCreateCustomer(from, {
        lastInboundMessageId: id,
        lastMessageAt: nowIso,
        lastInboundAt: nowIso,
        recordInbound: true,
        businessAccountId,
        source,
        ...contactPatch,
      });

  if (!skipInboundRecord && !skipMessageMergeBuffer && businessAccountId !== DEMO_ACCOUNT_ID && shouldBufferMergedCustomerMessage(text)) {
    return bufferMergedCustomerMessage({
      id,
      from,
      text,
      source,
      live,
      businessAccountId,
      contentAccountId,
      knowledgeAccountId,
    }, customer);
  }

  const conversationContext = await recentConversationContext(from, businessAccountId);
  const sourceMatchedProduct = findProductMatch(teamCatalog, "", source);
  const contextMatchedProduct = customer.productId
    ? sourceMatchedProduct
    : await recentProductContextMatch(from, businessAccountId, teamCatalog, source);
  const bufferProduct = findProduct(teamCatalog, text, source, customer.productId);
  const explicitTextMatchedProduct = findProductMatch(teamCatalog, text, {});
  const textMatchedProduct = explicitTextMatchedProduct || findProduct(teamCatalog, text, {}, "");
  const isProductNameOnlyOpening = isProductNameMessage(textMatchedProduct, text);
  const contextStartsNewProductJourney = shouldStartNewProductJourney(customer, contextMatchedProduct);
  const shouldPrioritizeOpeningFlow =
    !customer.pendingOrder &&
    (
      isProductNameOnlyOpening ||
      (contextMatchedProduct && (Number(customer.inboundCount || 0) <= 1 || contextStartsNewProductJourney))
    );
  if (!shouldPrioritizeOpeningFlow && !skipOrderDetailBuffer && shouldBufferIncompleteOrderDetails(customer, text, bufferProduct)) {
    return bufferIncompleteOrderDetails({
      id,
      from,
      text,
      source,
      live,
      businessAccountId,
      contentAccountId,
      knowledgeAccountId,
    }, customer, bufferProduct);
  }

  if (live) {
    const blocked = await liveAutomationBlock(businessAccountId);
    if (blocked) {
      const updatedCustomer = await store.updateCustomer(from, () => ({
        handoffStatus: "human_required",
        handoffReason: blocked.message,
      }), businessAccountId);
      await store.appendAuditLog({
        action: "live_reply_suppressed",
        customerId: from,
        result: blocked.code,
      });
      return {
        customer: updatedCustomer,
        order: null,
        messages: [],
        handoffRequired: true,
        handoffReason: blocked.message,
      };
    }
  }

  const faqSalesResponse = classifyFaqSalesPromptResponse(customer, text);
  const optOutIntent = detectOptOutIntent(text);
  if (!customer.pendingOrder && !isProductNameOnlyOpening && contextMatchedProduct && (Number(customer.inboundCount || 0) <= 1 || contextStartsNewProductJourney)) {
    const messageSource = {
      ...source,
      productId: contextMatchedProduct.id,
      productNameMatch: true,
      adContextProductMatch: true,
    };
    const plan = await buildConversationPlan({
      catalog: teamCatalog,
      customer,
      customerMessage: text,
      source: messageSource,
      faqLibrary: teamFaqLibrary,
      salesReplyLibrary: teamSalesReplyLibrary,
      approvedFaqMatch: null,
      salesReplyMatch: null,
      ragAnswer: null,
      conversationContext,
    });
    console.log(`Skipping OpenAI for ad-context opening flow to ${from}: ${contextMatchedProduct.id}`);
    const updatedCustomer = await store.updateCustomer(from, () => ({
      ...newProductJourneyPatch(customer, contextMatchedProduct),
      ...(plan.customerPatch || {}),
      productId: contextMatchedProduct.id,
      conversationState: "opening_flow_sent",
      openingFlowSentAt: new Date().toISOString(),
      openingFlowProductId: contextMatchedProduct.id,
      complaintCaseId: "",
      complaintStatus: "",
      complaintCategory: "",
      complaintAt: "",
      followupBlocked: false,
      followupBlockedReason: "",
      handoffStatus: "",
      handoffReason: "",
    }), businessAccountId);
    const outbound = clampMessages(plan.messages);
    await delayBeforeNewCustomerOpeningFlow(customer, "ad-context opening flow");
    await sendOutbound(from, outbound, { businessAccountId });
    return {
      customer: updatedCustomer,
      order: null,
      messages: outbound,
      handoffRequired: Boolean(plan.handoffRequired),
      handoffReason: plan.handoffReason || "",
    };
  }
  if (!customer.pendingOrder && isProductNameOnlyOpening) {
    const messageSource = {
      ...source,
      productId: textMatchedProduct.id,
      productNameMatch: true,
    };
    const plan = await buildConversationPlan({
      catalog: teamCatalog,
      customer,
      customerMessage: text,
      source: messageSource,
      faqLibrary: teamFaqLibrary,
      salesReplyLibrary: teamSalesReplyLibrary,
      approvedFaqMatch: null,
      salesReplyMatch: null,
      ragAnswer: null,
      conversationContext,
    });
    console.log(`Skipping OpenAI for product-name opening flow to ${from}`);
    const updatedCustomer = await store.updateCustomer(from, () => ({
      ...newProductJourneyPatch(customer, textMatchedProduct),
      ...(plan.customerPatch || {}),
      conversationState: "opening_flow_sent",
      openingFlowSentAt: new Date().toISOString(),
      openingFlowProductId: textMatchedProduct.id,
      complaintCaseId: "",
      complaintStatus: "",
      complaintCategory: "",
      complaintAt: "",
      followupBlocked: false,
      followupBlockedReason: "",
      handoffStatus: "",
      handoffReason: "",
    }), businessAccountId);
    const outbound = clampMessages(plan.messages);
    await delayBeforeNewCustomerOpeningFlow(customer, "product-name opening flow");
    await sendOutbound(from, outbound, { businessAccountId });
    return {
      customer: updatedCustomer,
      order: null,
      messages: outbound,
      handoffRequired: Boolean(plan.handoffRequired),
      handoffReason: plan.handoffReason || "",
    };
  }
  if (customer.complaintStatus === "open" && !optOutIntent.optedOut) {
    await store.appendAuditLog({
      actor: "ai_agent",
      action: "complaint_followup_received",
      customerId: from,
      result: customer.complaintCaseId || "open_complaint",
      businessAccountId,
    });
    return {
      customer,
      order: null,
      messages: [],
      handoffRequired: true,
      handoffReason: customer.handoffReason || "Complaint requires human reply.",
    };
  }
  if (!faqSalesResponse && optOutIntent.optedOut) {
    const updatedCustomer = await store.updateCustomer(from, () => ({
      optedOut: true,
      optedOutAt: new Date().toISOString(),
      followupBlocked: true,
      followupBlockedReason: optOutIntent.reason,
      handoffStatus: "",
      handoffReason: "",
    }), businessAccountId);
    await store.appendAuditLog({
      action: "customer_opt_out",
      customerId: from,
      result: "followups_blocked",
      reason: `${optOutIntent.reason}: ${text}`,
    });
    const outbound = [textMessage("Noted kita, kami tidak akan follow up lagi. Terima kasih.")];
    await sendOutbound(from, outbound, { businessAccountId });
    return {
      customer: updatedCustomer,
      order: null,
      messages: outbound,
      handoffRequired: false,
      handoffReason: "Customer opted out.",
    };
  }

  if (!faqSalesResponse && optOutIntent.uncertain) {
    const updatedCustomer = await store.updateCustomer(from, () => ({
      followupBlockedReason: optOutIntent.reason,
      handoffStatus: "",
      handoffReason: "",
    }), businessAccountId);
    await store.appendAuditLog({
      action: "possible_opt_out_review",
      customerId: from,
      result: "noted_followups_continue",
      reason: `${optOutIntent.reason}: ${text}`,
    });
    const outbound = [textMessage("Baik kita, no worries. Kalau berminat nanti, kita boleh message kami semula.")];
    await sendOutbound(from, outbound, { businessAccountId });
    return {
      customer: updatedCustomer,
      order: null,
      messages: outbound,
      handoffRequired: false,
      handoffReason: "",
    };
  }

  const routedProduct = shouldStartNewProductJourney(customer, explicitTextMatchedProduct)
    ? explicitTextMatchedProduct
    : findProduct(teamCatalog, text, source, customer.productId);
  const routeClassification = await maybeClassifyCustomerMessageRoute({
    customerMessage: text,
    customerId: from,
    product: routedProduct,
    catalog: teamCatalog,
    faqLibrary: teamFaqLibrary,
    salesReplyLibrary: teamSalesReplyLibrary,
    conversationContext,
    businessAccountId: knowledgeAccountId,
  });

  const initialAdOpening =
    Boolean(source.sourceUrl || source.adId || source.referralHeadline) ||
    /\b(berminat|interested|saya berminat|mau info|nak info)\b/i.test(text);
  const obviousComplaint = detectObviousComplaint(text);
  const classifiedComplaint = routeClassification?.messageType === "complaint" && routeClassification.confidence !== "low";
  const complaintIntent = faqSalesResponse || (initialAdOpening && !obviousComplaint)
    ? null
    : obviousComplaint || (classifiedComplaint ? await maybeDetectComplaintIntent(text, businessAccountId) : null) || (routeAllowsFallback(routeClassification) ? await maybeDetectComplaintIntent(text, businessAccountId) : null);
  if (complaintIntent) {
    const product = routedProduct;
    const complaint = await store.addComplaintCase({
      businessAccountId,
      customerId: from,
      productId: product.id,
      category: complaintIntent.category,
      reason: complaintIntent.reason,
      customerMessage: text,
      inboundMessageId: id,
    });
    const complaintReply = complaintIntent.reply || await maybeCreateComplaintHandoffReply({
      customerMessage: text,
      category: complaintIntent.category,
      businessAccountId,
    });
    const outbound = complaintReply ? [textMessage(complaintReply)] : [];
    const categoryLabel = complaintCategoryDisplay(complaint.category);
    const updatedCustomer = await store.updateCustomer(from, () => ({
      productId: product.id,
      awaitingPackageBInterest: false,
      pendingOrder: null,
      complaintCaseId: complaint.id,
      complaintStatus: "open",
      complaintCategory: complaint.category,
      complaintAt: complaint.createdAt,
      followupBlocked: true,
      followupBlockedReason: "complaint_handoff",
      handoffStatus: "human_required",
      handoffReason: `Complaint - ${categoryLabel}`,
    }), businessAccountId);
    await store.appendAuditLog({
      actor: "ai_agent",
      action: "complaint_handoff_created",
      customerId: from,
      result: `${complaint.id}:${complaint.category}`,
      businessAccountId,
    });
    if (businessAccountId !== DEMO_ACCOUNT_ID) await notifyAdmin(`Complaint handoff for ${from} (${categoryLabel}): ${text}`);
    if (outbound.length) {
      await sendOutbound(from, outbound, {
        businessAccountId,
        purpose: "complaint_acknowledgement",
      });
    }
    return {
      customer: updatedCustomer,
      order: null,
      messages: outbound,
      handoffRequired: true,
      handoffReason: updatedCustomer.handoffReason,
    };
  }

  if (!faqSalesResponse && !initialAdOpening && isDeliveryRescheduleRequest(text)) {
    const latestOrder = await store.findLatestOrderForCustomer(from, businessAccountId);
    const outbound = [textMessage(deliveryRescheduleReply())];
    const updatedCustomer = await store.updateCustomer(from, () => ({
      awaitingPackageBInterest: false,
      handoffStatus: "human_required",
      handoffReason: "Customer requested delivery reschedule.",
      lastDeliveryRescheduleRequestAt: new Date().toISOString(),
    }), businessAccountId);
    await store.appendAuditLog({
      actor: "ai_agent",
      action: "delivery_reschedule_handoff",
      customerId: from,
      result: latestOrder ? latestOrder.id : "no_linked_order",
      businessAccountId,
    });
    if (businessAccountId !== DEMO_ACCOUNT_ID) {
      await notifyAdmin(`Delivery reschedule requested for ${from}: ${text}`);
    }
    await sendOutbound(from, outbound, {
      businessAccountId,
      purpose: "delivery_reschedule_handoff",
    });
    return {
      customer: updatedCustomer,
      order: latestOrder,
      messages: outbound,
      handoffRequired: true,
      handoffReason: updatedCustomer.handoffReason,
    };
  }

  const classifiedOrderStatus = routeClassification?.messageType === "order_status" && routeClassification.confidence !== "low";
  if (!faqSalesResponse && !initialAdOpening && (classifiedOrderStatus || (routeAllowsFallback(routeClassification) && await maybeDetectOrderStatusIntent(text, businessAccountId)))) {
    const latestOrder = await store.findLatestOrderForCustomer(from, businessAccountId);
    const statusReplies = await store.getOrderStatusReplies(businessAccountId);
    const outbound = [textMessage(customerOrderStatusReply(latestOrder, statusReplies))];
    const updatedCustomer = await store.updateCustomer(from, () => ({
      awaitingPackageBInterest: false,
      handoffStatus: "",
      handoffReason: "",
      lastOrderStatusEnquiryAt: new Date().toISOString(),
    }), businessAccountId);
    await store.appendAuditLog({
      actor: "ai_agent",
      action: "customer_order_status_reply",
      customerId: from,
      result: latestOrder ? `${latestOrder.id}:${latestOrder.status}` : "no_linked_order",
      businessAccountId,
    });
    await delayBeforeStatusReply(from, "order status reply");
    await sendOutbound(from, outbound, {
      businessAccountId,
      purpose: "order_status_reply",
    });
    return {
      customer: updatedCustomer,
      order: latestOrder,
      messages: outbound,
      handoffRequired: false,
      handoffReason: "",
    };
  }

  const product = routedProduct;
  const productNameOpening = isProductNameMessage(product, text);
  const messageSource = productNameOpening ? { ...source, productNameMatch: true } : source;
  const fixedOpeningFlow = usesFixedOpeningFlow(customer, text, messageSource);
  const allowSalesReplyRoute = routeAllowsSalesReply(routeClassification);
  const allowKnowledgeRoute = routeAllowsKnowledgeAnswer(routeClassification);
  const classifiedKnowledgeRoute =
    routeClassification?.confidence !== "low" &&
    ["general_faq", "product_question"].includes(routeClassification?.messageType);
  const exactSalesReply = fixedOpeningFlow || faqSalesResponse
    ? null
    : (allowSalesReplyRoute ? findSalesReplyExactMatch(teamCatalog, product, text, { salesReplyLibrary: teamSalesReplyLibrary }) : null);
  const vectorSalesReply = fixedOpeningFlow || faqSalesResponse || exactSalesReply || !allowSalesReplyRoute
    ? null
    : await maybeSelectApprovedSalesReply({
        customerMessage: text,
        routeClassification,
        product,
        catalog: teamCatalog,
        salesReplyLibrary: teamSalesReplyLibrary,
        businessAccountId: knowledgeAccountId,
      });
  const selectedSalesReply = exactSalesReply || vectorSalesReply;
  const exactApprovedFaq = fixedOpeningFlow || faqSalesResponse || selectedSalesReply
    ? null
    : (allowKnowledgeRoute && !classifiedKnowledgeRoute ? findApprovedFaqLocalMatch(teamCatalog, product, text, { faqLibrary: teamFaqLibrary, customer, conversationContext }) : null);
  const approvedFaqMatch = exactApprovedFaq
    ? {
        faqId: exactApprovedFaq.id,
        topic: exactApprovedFaq.topic || "",
        approvedReply: exactApprovedFaq.approved_reply || exactApprovedFaq.answer || "",
      }
    : null;
  const salesReplyMatch = selectedSalesReply
    ? {
        salesReplyId: selectedSalesReply.id,
        salesIntent: selectedSalesReply.sales_intent || selectedSalesReply.objection_type || "",
        objectionType: selectedSalesReply.objection_type || "",
        intent: selectedSalesReply.intent || "",
        approvedReply: selectedSalesReply.approved_reply,
        repeatAction: selectedSalesReply.repeat_action,
      }
    : null;
  const ragAnswer = fixedOpeningFlow || faqSalesResponse || exactApprovedFaq || selectedSalesReply || !allowKnowledgeRoute
    ? null
    : await maybeCreateApprovedKnowledgeRagAnswer({
        customerMessage: text,
        customerId: from,
        routeClassification,
        catalog: teamCatalog,
        faqLibrary: teamFaqLibrary,
        product,
        businessAccountId: knowledgeAccountId,
      });
  if (fixedOpeningFlow) {
    console.log(`Skipping OpenAI for fixed opening flow to ${from}`);
  }
  if (faqSalesResponse) {
    console.log(`Skipping OpenAI for Package B interest response from ${from}: ${faqSalesResponse}`);
  }
  const planningCustomer = shouldStartNewProductJourney(customer, product)
    ? { ...customer, productId: product.id, followupsSent: {}, pendingOrder: null, awaitingPackageBInterest: false }
    : customer;
  const plan = await buildConversationPlan({
    catalog: teamCatalog,
    customer: planningCustomer,
    customerMessage: text,
    source: messageSource,
    faqLibrary: teamFaqLibrary,
    salesReplyLibrary: teamSalesReplyLibrary,
    approvedFaqMatch,
    salesReplyMatch,
    ragAnswer,
    routeClassification,
    conversationContext,
  });

  let repeatPatch = {};
  let repeatMessages = null;
  let repeatHandoffRequired = false;
  let repeatHandoffReason = "";
  if (plan.repeatedSalesReply) {
    const repeatAction = normalizeSalesRepeatAction(plan.repeatedSalesReply.action);
    const repeatReply = await maybeCreateSalesIntentRepeatReply({
      customerMessage: text,
      salesIntent: plan.repeatedSalesReply.salesIntent,
      approvedReply: plan.repeatedSalesReply.approvedReply,
      repeatAction,
      productName: product.name,
      businessAccountId: knowledgeAccountId,
    });
    if (repeatAction === "opt_out") {
      repeatPatch = {
        optedOut: true,
        optedOutAt: new Date().toISOString(),
        followupBlocked: true,
        followupBlockedReason: "repeated_sales_intent_opt_out",
        handoffStatus: "",
        handoffReason: "",
      };
      repeatMessages = repeatReply ? [textMessage(repeatReply)] : [];
    } else if (repeatAction === "handoff") {
      repeatPatch = {
        followupBlockedReason: "repeated_sales_intent_handoff",
        handoffStatus: "human_required",
        handoffReason: "Repeated sales intent needs admin review.",
      };
      repeatMessages = repeatReply ? [textMessage(repeatReply)] : [];
      repeatHandoffRequired = true;
      repeatHandoffReason = "Repeated sales intent needs admin review.";
    } else {
      repeatPatch = {
        handoffStatus: "",
        handoffReason: "",
      };
      repeatMessages = repeatReply ? [textMessage(repeatReply)] : [];
    }
  }

  const anotherDatePatch = plan.customerPatch?.salesStatus === "another_date_purchase" || plan.customerPatch?.status === "another_date_purchase"
    ? anotherDatePurchaseCustomerPatch(text)
    : {};

  const updatedCustomer = await store.updateCustomer(from, () => ({
    ...newProductJourneyPatch(customer, product),
    ...(plan.customerPatch || {}),
    ...anotherDatePatch,
    ...repeatPatch,
    ...(fixedOpeningFlow
      ? {
          conversationState: "opening_flow_sent",
          openingFlowSentAt: new Date().toISOString(),
          openingFlowProductId: product?.id || "",
        }
      : {}),
  }), businessAccountId);
  let order = null;
  if (plan.order) {
    order = await store.addOrder({ ...plan.order, businessAccountId });
  }

  if (plan.adminMessage && businessAccountId !== DEMO_ACCOUNT_ID) {
    await notifyAdmin(plan.adminMessage);
  }

  if ((plan.handoffRequired || repeatHandoffRequired) && !plan.adminMessage && businessAccountId !== DEMO_ACCOUNT_ID) {
    await notifyAdmin(`Human handoff requested for ${from}: ${repeatHandoffReason || plan.handoffReason || "No reason supplied."}`);
  }

  const outbound = clampMessages(order ? orderSubmittedCustomerMessages(product) : (repeatMessages ?? plan.messages));
  if (!order && fixedOpeningFlow) {
    await delayBeforeNewCustomerOpeningFlow(customer, "fixed opening flow");
  }
  await sendOutbound(from, outbound, { businessAccountId });

  return {
    customer: updatedCustomer,
    order,
    messages: outbound,
    handoffRequired: Boolean(plan.handoffRequired || repeatHandoffRequired),
    handoffReason: repeatHandoffReason || plan.handoffReason || "",
  };
}

async function handleManualBusinessMessage({ id, from, text, source = {}, businessAccountId = config.accountId }) {
  const body = String(text || "").trim();
  if (!from || !body) return;
  console.log(`Manual WhatsApp business message to ${from}: ${body}`);
  const now = new Date().toISOString();
  const contactPatch = customerContactPatch(from, source);
  await store.getOrCreateCustomer(from, {
    lastMessageAt: now,
    businessAccountId,
    source: {
      transport: "web",
      ...(source || {}),
      manualBusinessMessage: true,
    },
    ...contactPatch,
  });
  await store.appendOutbox({
    id,
    direction: "outbound",
    from: `business_admin:${businessAccountId}`,
    to: from,
    businessAccountId,
    channel: "business_admin",
    type: "text",
    body,
    purpose: "manual_whatsapp_message",
  });
  await store.appendAuditLog({
    actor: `business_admin:${businessAccountId}`,
    action: "manual_whatsapp_message_recorded",
    customerId: from,
    result: id || "",
    businessAccountId,
  });
}

async function maybeSelectApprovedSalesReply({
  customerMessage,
  product,
  catalog: activeCatalog,
  salesReplyLibrary: activeSalesReplyLibrary,
  businessAccountId = config.accountId,
}) {
  const apiKey = await openAiApiKeyForAccount(businessAccountId);
  if (!apiKey) return null;
  const model = await openAiModelForAccount(businessAccountId);
  const records = salesReplyRecordsForProduct(activeCatalog, product, {
    salesReplyLibrary: activeSalesReplyLibrary,
  }).filter((reply) =>
    reply.active !== false &&
    SALES_INTENT_LABELS.has(String(reply.sales_intent || "").trim())
  );
  if (!records.length) return null;
  try {
    const selected = await selectSalesReply({
      apiKey,
      model,
      customerMessage,
      normalizedCustomerMessage: normalizeCustomerMessage(customerMessage),
      productName: product?.name || "",
      salesReplyRecords: records,
    });
    if (!selected?.salesReplyId) return null;
    const record = records.find((reply) => reply.id === selected.salesReplyId);
    if (!record) return null;
    return record;
  } catch (error) {
    await recordSystemError("sales_reply_intent_selection", error, `Customer message: ${customerMessage}`, businessAccountId);
    return null;
  }
}

async function maybeDetectOrderStatusIntent(customerMessage, businessAccountId = config.accountId) {
  const apiKey = await openAiApiKeyForAccount(businessAccountId);
  if (!apiKey) return isLikelyOrderStatusQuestion(customerMessage);
  try {
    const model = await openAiModelForAccount(businessAccountId);
    return await detectOrderStatusIntent({
      apiKey,
      model,
      customerMessage,
    });
  } catch (error) {
    await recordSystemError("order_status_intent", error, "Unable to classify order-status enquiry.");
    return isLikelyOrderStatusQuestion(customerMessage);
  }
}

async function maybeDetectComplaintIntent(customerMessage, businessAccountId = config.accountId) {
  const apiKey = await openAiApiKeyForAccount(businessAccountId);
  if (!apiKey) return detectObviousComplaint(customerMessage);
  try {
    const model = await openAiModelForAccount(businessAccountId);
    return await detectComplaintIntent({
      apiKey,
      model,
      customerMessage,
    });
  } catch (error) {
    await recordSystemError("complaint_intent", error, "Unable to classify complaint enquiry.");
    return detectObviousComplaint(customerMessage);
  }
}

async function maybeCreateComplaintHandoffReply({ customerMessage, category, businessAccountId = config.accountId }) {
  const apiKey = await openAiApiKeyForAccount(businessAccountId);
  if (!apiKey) return "";
  try {
    const model = await openAiModelForAccount(businessAccountId);
    return await createComplaintHandoffReply({
      apiKey,
      model,
      customerMessage,
      category,
    });
  } catch (error) {
    await recordSystemError("complaint_handoff_reply", error, "Unable to create complaint handoff reply.", businessAccountId);
    return "";
  }
}

async function maybeCreateSalesIntentRepeatReply({
  customerMessage,
  salesIntent,
  approvedReply,
  repeatAction = "openai_acknowledge",
  productName = "",
  businessAccountId = config.accountId,
}) {
  const apiKey = await openAiApiKeyForAccount(businessAccountId);
  if (!apiKey) return "";
  try {
    const model = await openAiModelForAccount(businessAccountId);
    return await createSalesIntentRepeatReply({
      apiKey,
      model,
      customerMessage,
      salesIntent,
      approvedReply,
      repeatAction,
      productName,
    });
  } catch (error) {
    await recordSystemError("sales_intent_repeat_reply", error, "Unable to create repeated-sales-intent reply.", businessAccountId);
    return "";
  }
}

async function maybeClassifyCustomerMessageRoute({
  customerMessage,
  customerId,
  product,
  catalog: activeCatalog,
  faqLibrary: activeFaqLibrary,
  salesReplyLibrary: activeSalesReplyLibrary,
  conversationContext = [],
  businessAccountId = config.accountId,
}) {
  const apiKey = await openAiApiKeyForAccount(businessAccountId);
  if (!apiKey) return null;
  try {
    const model = await openAiModelForAccount(businessAccountId);
    const faqTopics = faqTopicOptionsForClassifier(activeCatalog, product, activeFaqLibrary);
    const salesIntents = salesIntentOptionsForClassifier(activeCatalog, product, activeSalesReplyLibrary);
    const route = await classifyCustomerMessageRoute({
      apiKey,
      model,
      customerMessage,
      normalizedCustomerMessage: normalizeCustomerMessage(customerMessage),
      productName: product?.name || "",
      conversationContext,
      faqTopics,
      salesIntents,
    });
    await store.appendAuditLog({
      actor: "ai_agent",
      action: "message_route_classified",
      customerId,
      result: `${route.messageType}:${route.primaryIntent || "none"}:${route.confidence}`,
      businessAccountId,
    });
    return route;
  } catch (error) {
    await recordSystemError("message_route_classifier", error, `Customer message: ${customerMessage}`, businessAccountId);
    return null;
  }
}

function routeAllowsFallback(route) {
  return !route || route.confidence === "low" || route.messageType === "unknown";
}

function routeAllowsSalesReply(route) {
  return routeAllowsFallback(route) || route.messageType === "sales_reply";
}

function routeAllowsKnowledgeAnswer(route) {
  return routeAllowsFallback(route) || ["general_faq", "product_question"].includes(route.messageType);
}

function faqTopicOptionsForClassifier(activeCatalog, product, activeFaqLibrary) {
  return approvedFaqRecordsForProduct(activeCatalog, product, {
    faqLibrary: activeFaqLibrary,
    includeGeneral: true,
  })
    .filter((faq) => faq.active !== false)
    .map((faq) => ({
      id: stableFaqTopicId(faq),
      label: faq.topic || faq.brunei_malay_topic || faq.id || "",
      scope: faq.scope || "",
    }));
}

function salesIntentOptionsForClassifier(activeCatalog, product, activeSalesReplyLibrary) {
  const seen = new Set();
  return salesReplyRecordsForProduct(activeCatalog, product, {
    salesReplyLibrary: activeSalesReplyLibrary,
  })
    .filter((reply) => reply.active !== false && String(reply.sales_intent || "").trim())
    .map((reply) => ({
      id: String(reply.sales_intent || "").trim(),
      label: reply.objection_type || reply.intent || reply.sales_intent || "",
    }))
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
}

function stableFaqTopicId(faq) {
  return String(faq?.topic_key || faq?.topicKey || faq?.id || "").trim();
}

async function maybeCreateApprovedKnowledgeRagAnswer({
  customerMessage,
  customerId,
  routeClassification = null,
  catalog: activeCatalog,
  faqLibrary: activeFaqLibrary,
  product,
  businessAccountId = config.accountId,
}) {
  const apiKey = await openAiApiKeyForAccount(businessAccountId);
  if (!apiKey) return null;
  const vectorStoreId = await vectorStoreIdForAccount(businessAccountId);
  if (!vectorStoreId) return null;
  const model = await openAiModelForAccount(businessAccountId);
  try {
    const retrievalQuery = buildKnowledgeRetrievalQuery(customerMessage, product, routeClassification);
    const topKnowledgeRecords = await retrieveAndRerankVectorStoreKnowledge({
      apiKey,
      model,
      vectorStoreId,
      customerMessage,
      retrievalQuery,
      routeClassification,
      product,
      businessAccountId,
    });
    if (!topKnowledgeRecords.length) {
      await recordSystemError(
        "approved_knowledge_rag",
        new Error("Vector-store search returned no approved knowledge"),
        JSON.stringify({
          productId: product?.id || "",
          productName: product?.name || "",
          customerMessage: String(customerMessage || "").slice(0, 500),
          retrievalQuery,
        }),
        businessAccountId
      );
      return null;
    }
    const answer = await createCustomerServiceResponse({
      apiKey,
      model,
      vectorStoreId,
      businessName: config.businessName,
      supportLanguage: config.supportLanguage,
      customerId,
      customerMessage,
      normalizedCustomerMessage: normalizeCustomerMessage(customerMessage),
      retrievalQuery,
      rerankedKnowledgeContext: formatRerankedKnowledgeContext(topKnowledgeRecords.slice(0, 1)),
      productName: product?.name || "",
      productId: product?.id || "",
      maxResults: 0,
      useFileSearch: false,
    });
    const safeReply = sanitizeProductKnowledgeReply(answer?.reply || "");
    if (!answer || !safeReply) {
      await recordSystemError(
        "approved_knowledge_rag",
        new Error("Approved knowledge RAG no answer"),
        JSON.stringify({
          productId: product?.id || "",
          productName: product?.name || "",
          customerMessage: String(customerMessage || "").slice(0, 500),
          handoffReason: answer?.handoffReason || "",
          buyingIntent: answer?.buyingIntent || "",
          replyType: answer?.replyType || "",
        }),
        businessAccountId
      );
      return null;
    }
    return {
      ...answer,
      reply: safeReply,
      allowProductSpecific: true,
      rerankedKnowledgeIds: topKnowledgeRecords.map((record) => record.id).filter(Boolean),
    };
  } catch (error) {
    await recordSystemError("approved_knowledge_rag", error, `Product: ${product?.id || ""}`, businessAccountId);
    return null;
  }
}

async function retrieveAndRerankVectorStoreKnowledge({
  apiKey,
  model,
  vectorStoreId,
  customerMessage,
  retrievalQuery,
  routeClassification,
  product,
  businessAccountId,
}) {
  const candidates = boostKnowledgeCandidates(
    await searchVectorStore({
      apiKey,
      vectorStoreId,
      query: retrievalQuery,
      maxResults: 3,
    }),
    routeClassification
  );
  if (!candidates.length) return [];
  try {
    const reranked = await rerankKnowledgeRecords({
      apiKey,
      model,
      customerMessage,
      normalizedCustomerMessage: normalizeCustomerMessage(customerMessage),
      route: routeClassification,
      records: candidates,
      topK: 3,
    });
    return reranked.length ? reranked : candidates.slice(0, 3);
  } catch (error) {
    await recordSystemError("approved_knowledge_rerank", error, `Product: ${product?.id || ""}`, businessAccountId);
    return candidates.slice(0, 3);
  }
}

function boostKnowledgeCandidates(records, routeClassification) {
  const primaryIntent = String(routeClassification?.primaryIntent || "");
  return records.map((record) => {
    let score = Number(record.retrieval_score || 0);
    if (primaryIntent && (record.id === primaryIntent || stableFaqTopicId(record) === primaryIntent)) score += 0.2;
    if (routeClassification?.messageType === "general_faq" && record.knowledge_type === "general_faq") score += 0.1;
    if (routeClassification?.messageType === "product_question" && record.knowledge_type !== "general_faq") score += 0.1;
    return { ...record, retrieval_score: score };
  });
}

function formatRerankedKnowledgeContext(records = []) {
  return records.slice(0, 3).map((record, index) => [
    `Candidate #${index + 1}`,
    `ID: ${record.id || ""}`,
    `Type: ${record.knowledge_type || record.scope || record.kind || ""}`,
    `Topic/category: ${record.topic || record.category || record.title || ""}`,
    `Approved answer: ${record.approved_reply || record.brunei_malay_approved_reply || record.value || ""}`,
    `Examples: ${(record.example_questions || []).join(" | ")}`,
    `Brunei-Malay examples: ${(record.brunei_malay_example_questions || []).join(" | ")}`,
    `Summary: ${record.summary || record.brunei_malay_summary || ""}`,
    `Vector-store chunk: ${String(record.text || "").slice(0, 1800)}`,
    `Extracted/search text: ${[record.extracted_text, record.embedding_text, record.brunei_malay_search_text].filter(Boolean).join(" | ").slice(0, 1000)}`,
  ].filter((line) => !/:\s*$/.test(line)).join("\n")).join("\n\n");
}

function sanitizeProductKnowledgeReply(reply) {
  return String(reply || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter((sentence) => !/\b(claim\s*produk|claimed?|visible text|promotional image|poster|chunk|extracted)\b/i.test(sentence))
    .filter((sentence) => !/\bblackheads?\s*out\s*in\s*5\s*minutes?\b/i.test(sentence))
    .join(" ")
    .trim();
}

function buildKnowledgeRetrievalQuery(customerMessage, product = null, routeClassification = null) {
  const normalized = normalizeCustomerMessage(customerMessage);
  const productName = String(product?.name || "").trim();
  const sku = String(product?.sku || product?.skuCode || product?.productCode || "").trim();
  const intent = String(routeClassification?.primaryIntent || "").trim();
  const messageType = String(routeClassification?.messageType || "").trim();
  return [productName, sku, messageType, intent, normalized || customerMessage]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 800);
}

function orderSubmittedCustomerMessages(product) {
  const hasSavedMessages = Array.isArray(product?.order_closing_messages);
  const messages = hasSavedMessages ? product.order_closing_messages : DEFAULT_ORDER_CLOSING_MESSAGES;
  const cleaned = messages
    .map((message) => String(message || "").trim())
    .filter(Boolean);
  return cleaned.map(textMessage);
}

function followupTemplateName(followupKey) {
  return FOLLOWUP_TEMPLATE_BY_KEY[String(followupKey || "")] || "";
}

function templateMessage(name, languageCode = FOLLOWUP_TEMPLATE_LANGUAGE, components = []) {
  return {
    type: "template",
    name,
    languageCode,
    components,
  };
}

async function delayBeforeNewCustomerOpeningFlow(customer, reason = "opening flow") {
  if (Number(customer?.inboundCount || 0) !== 1) return;
  const delayMs = Math.max(0, Number(config.openingFlowInitialDelayMs) || 0);
  if (!delayMs) return;
  console.log(`Delaying ${reason} for new customer ${customer.id} by ${delayMs}ms`);
  await wait(delayMs);
}

async function delayBeforeStatusReply(customerId, reason = "status reply") {
  const delayMs = Math.max(0, Number(config.statusReplyDelayMs) || 0);
  if (!delayMs) return;
  console.log(`Delaying ${reason} for ${customerId} by ${delayMs}ms`);
  await wait(delayMs);
}

function randomFollowupDelayMs() {
  const min = Math.max(0, Number(config.followupSendDelayMinMs) || 0);
  const max = Math.max(min, Number(config.followupSendDelayMaxMs) || min);
  return min + Math.floor(Math.random() * (max - min + 1));
}

function followupPauseUntil(now = new Date()) {
  const activeMs = Math.max(1, Number(config.followupActiveWindowMinutes) || 10) * 60 * 1000;
  const pauseMs = Math.max(0, Number(config.followupPauseWindowMinutes) || 0) * 60 * 1000;
  return followupPauseUntilForWindow(now, activeMs, pauseMs);
}

function followupPauseUntilForSettings(now = new Date(), settings = {}) {
  const activeMs = Math.max(
    1,
    Number(settings.followupActiveWindowMinutes || 0) || Number(config.followupActiveWindowMinutes) || 10
  ) * 60 * 1000;
  const pauseMs = Math.max(
    0,
    Number(settings.followupPauseWindowMinutes || 0) || Number(config.followupPauseWindowMinutes) || 0
  ) * 60 * 1000;
  return followupPauseUntilForWindow(now, activeMs, pauseMs);
}

function followupPauseUntilForWindow(now = new Date(), activeMs = 10 * 60 * 1000, pauseMs = 0) {
  if (!pauseMs) return null;

  const cycleMs = activeMs + pauseMs;
  const elapsedMs = Math.max(0, now.getTime() - followupPacingStartedAt.getTime());
  const cyclePositionMs = elapsedMs % cycleMs;
  if (cyclePositionMs < activeMs) return null;

  return new Date(now.getTime() + (cycleMs - cyclePositionMs));
}

function rotateFollowupBatch(batch = []) {
  const groups = new Map();
  for (const item of shuffleItems(batch)) {
    const key = item.followupKey || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const rotated = [];
  const keys = shuffleItems([...groups.keys()]);
  while (keys.length) {
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      const next = groups.get(key)?.shift();
      if (next) rotated.push(next);
      if (!groups.get(key)?.length) keys.splice(index, 1);
    }
  }
  return rotated;
}

function shuffleItems(items = []) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function requestFollowupRun(now = new Date(), options = {}) {
  if (followupRunPromise) return followupRunPromise;
  followupRunPromise = runDueFollowups(now, options).finally(() => {
    followupRunPromise = null;
  });
  return followupRunPromise;
}

async function sendCustomerFollowupNow(customerId, options = {}) {
  const id = String(customerId || "").trim();
  if (!id) throw new Error("Customer ID is required.");
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const businessAccountId = String(options.businessAccountId || config.accountId);
  const respectOperationalControl = options.respectOperationalControl !== false;
  const followupKey = String(options.followupKey || "").trim();
  const allowAlreadySent = Boolean(options.allowAlreadySent);
  const customers = await store.listCustomers(now, businessAccountId);
  const customer = customers.find((item) => item.id === id);
  if (!customer) {
    return { sent: false, customerId: id, skipped: "customer_not_found" };
  }
  if ((customer.orderIds || []).length > 0) {
    return { sent: false, customerId: id, skipped: "order_submitted" };
  }
  if (customer.optedOut) {
    return { sent: false, customerId: id, skipped: "opted_out" };
  }
  if (customer.followupBlocked) {
    return { sent: false, customerId: id, skipped: "followup_blocked" };
  }
  if (respectOperationalControl) {
    const blocked = await liveAutomationBlock(customer.businessAccountId || businessAccountId);
    if (blocked) {
      return { sent: false, customerId: id, skipped: blocked.code, blocked };
    }
  }
  const teamContent = await getTeamContent(customer.businessAccountId || businessAccountId);
  const product = teamContent.catalog.products.find((item) => item.id === customer.productId);
  if (!product) {
    return { sent: false, customerId: id, skipped: "product_not_found", productId: customer.productId || "" };
  }
  const sequence = productFollowupSequence(product);
  let item = followupKey
    ? sequence.find((entry) => entry.key === followupKey)
    : sequence.find((entry) => !customer.followupsSent?.[entry.key]);
  if (!item && allowAlreadySent) item = sequence[0];
  if (!item) {
    return { sent: false, customerId: id, skipped: "all_followups_already_sent" };
  }
  if (customer.followupsSent?.[item.key] && !allowAlreadySent) {
    return {
      sent: false,
      customerId: id,
      followupKey: item.key,
      skipped: "followup_already_sent",
      sentAt: customer.followupsSent[item.key],
    };
  }
  const outsideCustomerServiceWindow =
    config.transportMode === "cloud" && !config.demoMode && !isWithinCustomerServiceWindow(customer, now);
  const templateName = outsideCustomerServiceWindow ? followupTemplateName(item.key) : "";
  if (outsideCustomerServiceWindow && !templateName) {
    return {
      sent: false,
      customerId: id,
      followupKey: item.key,
      skipped: "approved_template_required",
    };
  }
  const outboundMessages = templateName
    ? templateMessage(templateName, FOLLOWUP_TEMPLATE_LANGUAGE)
    : followupOutboundMessages(item.followup);
  await sendOutbound(id, Array.isArray(outboundMessages) ? outboundMessages : [outboundMessages], {
    businessAccountId: customer.businessAccountId || businessAccountId,
    purpose: "followup",
    followupKey: item.key,
    templateName,
    skipFailureRecord: true,
  });
  await store.markFollowupSent(id, item.key, now, customer.businessAccountId || businessAccountId);
  return {
    sent: true,
    customerId: id,
    businessAccountId: customer.businessAccountId || businessAccountId,
    productId: product.id,
    followupKey: item.key,
    templateName,
    message: item.followup.message,
  };
}

async function runDueFollowups(now = new Date(), { respectOperationalControl = true } = {}) {
  const deletedCustomers = await store.deleteStaleUnresponsiveCustomers(now);
  const due = await getDueFollowupsForTeams(now);
  const operationalDue = respectOperationalControl
    ? await filterOperationalFollowups(due)
    : due;
  const sendable = due.filter((item) =>
    config.demoMode ||
    isWithinCustomerServiceWindow(item.customer, now) ||
    Boolean(followupTemplateName(item.followupKey))
  );
  const operationalSendable = sendable.filter((item) => operationalDue.includes(item));
  const templateRequired = operationalDue.filter((item) =>
    !config.demoMode &&
    !isWithinCustomerServiceWindow(item.customer, now) &&
    !followupTemplateName(item.followupKey)
  );
  const queued = await operations.enqueueFollowups(
    operationalSendable.map((item) => ({
      businessAccountId: item.customer.businessAccountId || config.accountId,
      customerId: item.customer.id,
      productId: item.product.id,
      labelDisplay: item.customer.labelDisplay,
      followupKey: item.followupKey,
      message: item.followup.message,
      messages: item.followup.messages,
    })),
    now
  );
  const dispatched = await dispatchFollowupQueue(now);
  return {
    sent: dispatched.sent.length,
    queued: queued.length,
    queueFailed: dispatched.failed.length,
    queueCancelled: dispatched.cancelled.length,
    queuePaused: dispatched.paused.length,
    queueHeldForApprovedTemplate: dispatched.heldForApprovedTemplate.length,
    heldForApprovedTemplate: templateRequired.length,
    deleted: deletedCustomers.length,
    skipped: await buildFollowupSkippedSummary(now),
    checkedAt: now.toISOString(),
    deletedCustomers: deletedCustomers.map((customer) => ({
      customerId: customer.id,
      label: customer.label,
      labelDisplay: customer.labelDisplay,
      deleteReason: customer.deleteReason,
    })),
    customers: dispatched.sent,
    templateRequired: templateRequired.map((item) => ({
      customerId: item.customer.id,
      label: item.customer.label,
      labelDisplay: item.customer.labelDisplay,
      followupKey: item.followupKey,
      productId: item.product.id,
    })),
    templateRequiredCustomers: templateRequired.map((item) => ({
      customerId: item.customer.id,
      label: item.customer.label,
      labelDisplay: item.customer.labelDisplay,
      followupKey: item.followupKey,
      productId: item.product.id,
      message: item.followup.message,
    })),
    ...(dispatched.paused.length
      ? {
          paused: dispatched.paused,
          blockedReason: "Follow-up pacing cooldown is active.",
        }
      : {}),
  };
}

async function getDueFollowupsForTeams(now = new Date()) {
  const customers = await store.listCustomers(now);
  const contentByAccount = new Map();
  const due = [];
  for (const customer of customers) {
    const accountId = customer.businessAccountId || config.accountId;
    if (!contentByAccount.has(accountId)) {
      contentByAccount.set(accountId, await getTeamContent(accountId));
    }
    const teamContent = contentByAccount.get(accountId);
    const teamCatalog = teamContent.catalog;
    const product = teamCatalog.products.find((item) => item.id === customer.productId);
    if (!product) continue;
    if (customer.handoffStatus === "human_required") continue;
    const anotherDateItem = anotherDatePurchaseFollowupItem(customer, product, teamContent, now);
    if (anotherDateItem) {
      due.push(anotherDateItem);
      continue;
    }
    if ((customer.orderIds || []).length > 0 || customer.optedOut || customer.followupBlocked) continue;
    const sequence = productFollowupSequence(product);
    const item = currentFollowupStage(customer, sequence, now);
    if (!item || customer.followupsSent?.[item.key]) continue;
    if (isCurrentFollowupSendWindow(customer, item, sequence, now)) {
      due.push({ customer, product, followup: item.followup, followupKey: item.key });
    }
  }
  return due;
}

async function filterOperationalFollowups(due = []) {
  const allowed = [];
  const blockByAccount = new Map();
  for (const item of due) {
    const accountId = item.customer.businessAccountId || config.accountId;
    if (!blockByAccount.has(accountId)) {
      blockByAccount.set(accountId, await liveAutomationBlock(accountId));
    }
    if (!blockByAccount.get(accountId)) allowed.push(item);
  }
  return allowed;
}

async function dispatchFollowupQueue(now = new Date()) {
  const batch = rotateFollowupBatch(await claimFollowupDispatchBatch(now));
  const customers = await store.listCustomers(now);
  const customerById = new Map(customers.map((customer) => [customerKey(customer.businessAccountId || config.accountId, customer.id), customer]));
  const contentByAccount = new Map();
  const accountSettingsById = new Map();
  const result = { sent: [], failed: [], cancelled: [], heldForApprovedTemplate: [], paused: [] };

  for (const item of batch) {
    const itemAccountId = item.businessAccountId || config.accountId;
    if (!accountSettingsById.has(itemAccountId)) {
      try {
        accountSettingsById.set(itemAccountId, await adminAccounts.getTeamSettings(itemAccountId));
      } catch {
        accountSettingsById.set(itemAccountId, {});
      }
    }
    const pauseUntil = followupPauseUntilForSettings(now, accountSettingsById.get(itemAccountId));
    if (pauseUntil) {
      await operations.updateFollowupDispatch(item.id, {
        status: "queued",
        availableAt: pauseUntil.toISOString(),
        lastError: "Follow-up pacing cooldown is active.",
      });
      result.paused.push({
        customerId: item.customerId,
        followupKey: item.followupKey,
        productId: item.productId,
        pausedUntil: pauseUntil.toISOString(),
      });
      continue;
    }
    const customer = customerById.get(customerKey(itemAccountId, item.customerId));
    const sentItem = {
      customerId: item.customerId,
      labelDisplay: customer?.labelDisplay || item.labelDisplay,
      followupKey: item.followupKey,
      productId: item.productId,
      message: item.message,
    };
    const specialAnotherDateFollowup = item.followupKey === "another_date_purchase_followup";
    if (!customer || (customer.orderIds || []).length > 0 || customer.optedOut || customer.handoffStatus === "human_required" || (customer.followupBlocked && !specialAnotherDateFollowup)) {
      await operations.updateFollowupDispatch(item.id, {
        status: "cancelled",
        lastError: !customer ? "Customer no longer exists." : "Customer no longer eligible for follow-up.",
      });
      result.cancelled.push(sentItem);
      continue;
    }
    if (customer.followupsSent?.[item.followupKey]) {
      await operations.updateFollowupDispatch(item.id, { status: "sent", sentAt: customer.followupsSent[item.followupKey] });
      continue;
    }
    if (!contentByAccount.has(itemAccountId)) {
      contentByAccount.set(itemAccountId, await getTeamContent(itemAccountId));
    }
    const teamContent = contentByAccount.get(itemAccountId);
    const product = teamContent.catalog.products.find((entry) => entry.id === customer.productId);
    if (specialAnotherDateFollowup) {
      const specialItem = anotherDatePurchaseFollowupItem(customer, product, teamContent, now);
      if (!specialItem || customer.followupsSent?.[item.followupKey]) {
        await operations.updateFollowupDispatch(item.id, {
          status: "cancelled",
          lastError: "Another-date purchase follow-up is no longer due.",
        });
        result.cancelled.push(sentItem);
        continue;
      }
      try {
        await wait(randomFollowupDelayMs());
        const outboundMessages = followupOutboundMessages({ message: item.message, messages: item.messages });
        await sendOutbound(item.customerId, Array.isArray(outboundMessages) ? outboundMessages : [outboundMessages], {
          businessAccountId: itemAccountId,
          purpose: "another_date_purchase_followup",
          followupKey: item.followupKey,
          skipFailureRecord: true,
        });
        await store.markFollowupSent(item.customerId, item.followupKey, now, itemAccountId);
        await operations.updateFollowupDispatch(item.id, { status: "sent", sentAt: now.toISOString(), lastError: "" });
        result.sent.push(sentItem);
      } catch (error) {
        const retryAt = new Date(now.getTime() + Math.max(config.followupRetryMinutes, 1) * 60 * 1000);
        await operations.updateFollowupDispatch(item.id, {
          status: "retry_pending",
          availableAt: retryAt.toISOString(),
          lastError: error.message,
        });
        result.failed.push(sentItem);
      }
      continue;
    }
    const followupSequence = productFollowupSequence(product);
    const sequenceItem = followupSequence.find((entry) => entry.key === item.followupKey);
    const currentStage = currentFollowupStage(customer, followupSequence, now);
    if (!sequenceItem || currentStage?.key !== sequenceItem.key || !isCurrentFollowupSendWindow(customer, sequenceItem, followupSequence, now)) {
      await operations.updateFollowupDispatch(item.id, {
        status: "cancelled",
        lastError: "Follow-up send window missed or customer moved to another stage.",
      });
      result.cancelled.push(sentItem);
      continue;
    }
    const outsideCustomerServiceWindow = config.transportMode === "cloud" && !config.demoMode && !isWithinCustomerServiceWindow(customer, now);
    const templateName = outsideCustomerServiceWindow ? followupTemplateName(item.followupKey) : "";
    if (outsideCustomerServiceWindow) {
      if (templateName) {
        sentItem.templateName = templateName;
      } else {
        await operations.updateFollowupDispatch(item.id, {
          status: "held_template",
          lastError: "Approved WhatsApp template required outside the 24-hour customer service window.",
        });
        result.heldForApprovedTemplate.push(sentItem);
        continue;
      }
    }
    try {
      await wait(randomFollowupDelayMs());
      const outboundMessages = templateName
        ? templateMessage(templateName, FOLLOWUP_TEMPLATE_LANGUAGE)
        : followupOutboundMessages({ message: item.message, messages: item.messages });
      await sendOutbound(item.customerId, Array.isArray(outboundMessages) ? outboundMessages : [outboundMessages], {
        businessAccountId: itemAccountId,
        purpose: "followup",
        followupKey: item.followupKey,
        templateName,
        skipFailureRecord: true,
      });
      await store.markFollowupSent(item.customerId, item.followupKey, now, itemAccountId);
      await operations.updateFollowupDispatch(item.id, { status: "sent", sentAt: now.toISOString(), lastError: "" });
      result.sent.push(sentItem);
    } catch (error) {
      const retryAt = new Date(now.getTime() + Math.max(config.followupRetryMinutes, 1) * 60 * 1000);
      await operations.updateFollowupDispatch(item.id, {
        status: "retry_pending",
        availableAt: retryAt.toISOString(),
        lastError: error.message,
      });
      result.failed.push(sentItem);
    }
  }
  return result;
}

async function claimFollowupDispatchBatch(now = new Date()) {
  const claimed = [];
  const seenAccounts = new Set();
  try {
    const accounts = await adminAccounts.listAccounts();
    for (const account of accounts) {
      const accountId = String(account.id || "");
      if (!accountId || seenAccounts.has(accountId)) continue;
      seenAccounts.add(accountId);
      const limit = Number(account.settings?.followupSendsPerMinute || 0) || config.followupSendsPerMinute;
      claimed.push(...await operations.claimFollowupBatch(Math.max(limit, 1), now, accountId));
    }
  } catch (error) {
    await recordSystemError("followup_batch_settings", error);
  }
  if (!seenAccounts.has(config.accountId)) {
    claimed.push(...await operations.claimFollowupBatch(Math.max(config.followupSendsPerMinute, 1), now, config.accountId));
  }
  return claimed;
}

function customerKey(businessAccountId, customerId) {
  return `${businessAccountId || ""}::${customerId || ""}`;
}

async function buildFollowupSkippedSummary(now = new Date()) {
  const customers = await store.listCustomers(now);
  const rows = customers.map((customer) => followupGuardrailStatus(customer, now));
  return {
    optedOut: rows.filter((row) => row.reason === "opted_out").length,
    outside24HourWindow: rows.filter((row) => row.reason === "outside_24_hour_window").length,
    ordered: rows.filter((row) => row.reason === "order_submitted").length,
  };
}

async function handleStockArrival(productId, businessAccountId = config.accountId) {
  const content = await getTeamContent(businessAccountId);
  const product = content.catalog.products.find((item) => item.id === productId);
  if (!product) throw new Error(`Unknown product: ${productId}`);
  const orders = await store.updateOrdersForStockArrival(productId, businessAccountId, `admin:${businessAccountId}`);
  const customerIds = [...new Set(orders.map((order) => order.customerId))];
  for (const customerId of customerIds) {
    await sendOutbound(customerId, [textMessage(formatStockArrivalMessage(product))], { businessAccountId });
  }
  await notifyAdmin(`Stock arrival message sent to ${customerIds.length} customer(s) for ${product.name}.`);
  return { productId, notifiedCustomers: customerIds, updatedOrders: orders.length };
}

async function generateTestCustomers(count = 100, now = new Date()) {
  const product = catalog.products.find((item) => item.id === catalog.default_product_id) || catalog.products[0];
  const packageB = product.packages?.find((item) => item.id === "B") || product.packages?.[0] || {};
  const outboxBuffer = [];
  const stats = {
    requested: count,
    createdCustomers: 0,
    orders: 0,
    optedOut: 0,
    replied: 0,
    ignored: 0,
    followupFirstSent: 0,
    followupSecondSent: 0,
    followupLaterSent: 0,
    followupReplies: 0,
    handoff: 0,
    lowInterestBlocked: 0,
    scenarios: {},
  };
  const batchId = Date.now();

  simulatedOutboxBuffer = outboxBuffer;
  try {
    for (let index = 0; index < count; index += 1) {
    const customerId = `sim_customer_${batchId}_${String(index + 1).padStart(3, "0")}`;
    const firstSeenAt = randomDateWithinDays(now, 10, index);
    const scenario = testScenario(index);
    stats.scenarios[scenario] = (stats.scenarios[scenario] || 0) + 1;
    const basePatch = {
      businessAccountId: config.accountId,
      firstSeenAt: firstSeenAt.toISOString(),
      lastMessageAt: firstSeenAt.toISOString(),
      lastInboundAt: firstSeenAt.toISOString(),
      inboundCount: 1,
      source: { referralHeadline: "Facebook ad blackhead remover", testBatchId: String(batchId) },
      productId: product.id,
      followupsSent: {},
      orderIds: [],
      pendingOrder: null,
      handoffStatus: "",
      handoffReason: "",
    };

    await store.getOrCreateCustomer(customerId, basePatch);
    await appendSimInbound(customerId, firstSeenAt, "Assalamualaikum, saya berminat");
    const flowEndAt = await appendSimOpeningFlow(customerId, firstSeenAt, product);
    stats.createdCustomers += 1;

    if (scenario === "order_complete") {
      const intentAt = addMinutes(flowEndAt, 6);
      const detailsAt = addMinutes(intentAt, 3);
      const order = await appendSimOrderConversation({
        batchId,
        index,
        customerId,
        product,
        packageItem: packageB,
        intentAt,
        detailsAt,
      });
      await store.updateCustomer(customerId, () => ({
        lastMessageAt: detailsAt.toISOString(),
        lastInboundAt: detailsAt.toISOString(),
        inboundCount: 3,
        handoffStatus: "human_required",
        handoffReason: "Customer submitted complete order details.",
      }));
      await appendSimAdmin(
        addSeconds(detailsAt, 14),
        `New simulated order needs human processing for ${customerId}: ${order.packageName} ${order.packagePrice}.`
      );
      stats.orders += 1;
      stats.replied += 1;
      stats.handoff += 1;
      continue;
    }

    if (scenario === "order_after_followup") {
      const followupResult = await appendSimDueFollowups({
        customerId,
        product,
        firstSeenAt,
        now,
        maxMessages: 10,
        simulateTemplateWindow: true,
      });
      const intentAt = addMinutes(followupResult.lastSentAt || flowEndAt, 42);
      const detailsAt = addMinutes(intentAt, 4);
      const order = await appendSimOrderConversation({
        batchId,
        index,
        customerId,
        product,
        packageItem: packageB,
        intentAt,
        detailsAt,
      });
      await store.updateCustomer(customerId, () => ({
        followupsSent: followupResult.followupsSent,
        lastMessageAt: detailsAt.toISOString(),
        lastInboundAt: detailsAt.toISOString(),
        inboundCount: 3,
        handoffStatus: "human_required",
        handoffReason: "Customer submitted complete order details.",
      }));
      await appendSimAdmin(
        addSeconds(detailsAt, 14),
        `New simulated order after follow-up for ${customerId}: ${order.packageName} ${order.packagePrice}.`
      );
      stats.orders += 1;
      stats.replied += 1;
      stats.followupReplies += 1;
      stats.handoff += 1;
      stats.followupFirstSent += followupResult.firstSent;
      stats.followupSecondSent += followupResult.secondSent;
      stats.followupLaterSent += followupResult.laterSent;
      continue;
    }

    if (scenario === "opted_out_exact" || scenario === "opted_out_semantic") {
      const optOutAt = addMinutes(flowEndAt, 8);
      const optOutText = scenario === "opted_out_exact" ? "stop" : "saya inda mau kana contact lagi";
      await appendSimInbound(customerId, optOutAt, optOutText);
      await appendSimOutbound(customerId, addSeconds(optOutAt, 5), "Noted kita, kami tidak akan follow up lagi. Terima kasih.");
      await store.updateCustomer(customerId, () => ({
        optedOut: true,
        optedOutAt: optOutAt.toISOString(),
        followupBlocked: true,
        followupBlockedReason: "simulated opt-out",
        lastMessageAt: optOutAt.toISOString(),
        lastInboundAt: optOutAt.toISOString(),
        inboundCount: 2,
      }));
      stats.optedOut += 1;
      stats.replied += 1;
      continue;
    }

    if (scenario === "low_interest") {
      const replyAt = addMinutes(flowEndAt, 9);
      await appendSimInbound(customerId, replyAt, "Nanti dulu saya fikir dulu");
      await appendSimOutbound(
        customerId,
        addSeconds(replyAt, 5),
        "Baik kita, no worries. Kalau berminat nanti, kita boleh message kami semula."
      );
      const followupResult = await appendSimDueFollowups({
        customerId,
        product,
        firstSeenAt,
        now,
        maxMessages: 10,
        simulateTemplateWindow: true,
      });
      await store.updateCustomer(customerId, () => ({
        followupsSent: followupResult.followupsSent,
        lastMessageAt: replyAt.toISOString(),
        lastInboundAt: replyAt.toISOString(),
        inboundCount: 2,
        followupBlockedReason: "possible_opt_out_or_low_interest",
      }));
      stats.replied += 1;
      stats.followupFirstSent += followupResult.firstSent;
      stats.followupSecondSent += followupResult.secondSent;
      stats.followupLaterSent += followupResult.laterSent;
      continue;
    }

    if (scenario === "sales_response") {
      const replyAt = addMinutes(flowEndAt, 7);
      await appendSimInbound(customerId, replyAt, "Tanya dulu");
      await appendSimOutbound(customerId, addSeconds(replyAt, 5), "Buleh tau apa yg kita fikir? Ada rasa nak tunggu payday?");
      const followupResult = await appendSimDueFollowups({
        customerId,
        product,
        firstSeenAt,
        now,
        maxMessages: 10,
        simulateTemplateWindow: true,
      });
      await store.updateCustomer(customerId, () => ({
        followupsSent: followupResult.followupsSent,
        lastMessageAt: replyAt.toISOString(),
        lastInboundAt: replyAt.toISOString(),
        inboundCount: 2,
      }));
      stats.replied += 1;
      stats.followupFirstSent += followupResult.firstSent;
      stats.followupSecondSent += followupResult.secondSent;
      stats.followupLaterSent += followupResult.laterSent;
      continue;
    }

    if (scenario === "faq_location") {
      const replyAt = addMinutes(flowEndAt, 7);
      await appendSimInbound(customerId, replyAt, "Business location kat mana?");
      await appendSimOutbound(
        customerId,
        addSeconds(replyAt, 5),
        "Warehouse at bandar. Tapi skrg buleh proceed delivery dgn MP service saja"
      );
      const followupResult = await appendSimDueFollowups({
        customerId,
        product,
        firstSeenAt,
        now,
        maxMessages: 10,
        simulateTemplateWindow: true,
      });
      await store.updateCustomer(customerId, () => ({
        followupsSent: followupResult.followupsSent,
        lastMessageAt: replyAt.toISOString(),
        lastInboundAt: replyAt.toISOString(),
        inboundCount: 2,
      }));
      stats.replied += 1;
      stats.followupFirstSent += followupResult.firstSent;
      stats.followupSecondSent += followupResult.secondSent;
      stats.followupLaterSent += followupResult.laterSent;
      continue;
    }

    if (scenario === "normal_faq") {
      const replyAt = addMinutes(flowEndAt, 7);
      await appendSimInbound(customerId, replyAt, "Boleh COD kah?");
      await appendSimOutbound(customerId, addSeconds(replyAt, 5), "Boleh, COD to all Brunei.");
      const followupResult = await appendSimDueFollowups({
        customerId,
        product,
        firstSeenAt,
        now,
        maxMessages: 10,
        simulateTemplateWindow: true,
      });
      await store.updateCustomer(customerId, () => ({
        followupsSent: followupResult.followupsSent,
        lastMessageAt: replyAt.toISOString(),
        lastInboundAt: replyAt.toISOString(),
        inboundCount: 2,
      }));
      stats.replied += 1;
      stats.followupFirstSent += followupResult.firstSent;
      stats.followupSecondSent += followupResult.secondSent;
      stats.followupLaterSent += followupResult.laterSent;
      continue;
    }

    if (scenario === "unknown_handoff") {
      const replyAt = addMinutes(flowEndAt, 7);
      await appendSimInbound(customerId, replyAt, "Boleh guna kalau ada skin allergy teruk?");
      await appendSimAdmin(
        addSeconds(replyAt, 8),
        `Human handoff requested for ${customerId}: No matching sales response, FAQ, or RAG answer.`
      );
      await store.updateCustomer(customerId, () => ({
        lastMessageAt: replyAt.toISOString(),
        lastInboundAt: replyAt.toISOString(),
        inboundCount: 2,
        handoffStatus: "human_required",
        handoffReason: "No matching sales response, FAQ, or RAG answer.",
      }));
      stats.replied += 1;
      stats.handoff += 1;
      continue;
    }

    if (scenario === "followup_reply") {
      const followupResult = await appendSimDueFollowups({
        customerId,
        product,
        firstSeenAt,
        now,
        maxMessages: 10,
        simulateTemplateWindow: true,
      });
      const replyAt = addMinutes(followupResult.lastSentAt || flowEndAt, 36);
      await appendSimInbound(customerId, replyAt, "Masih ada promo?");
      await appendSimOutbound(
        customerId,
        addSeconds(replyAt, 5),
        "Masih ada kita. Package B masih promo B$70 dapat 4 unit, free delivery & COD."
      );
      await store.updateCustomer(customerId, () => ({
        followupsSent: followupResult.followupsSent,
        lastMessageAt: replyAt.toISOString(),
        lastInboundAt: replyAt.toISOString(),
        inboundCount: 2,
      }));
      stats.replied += 1;
      stats.followupReplies += 1;
      stats.followupFirstSent += followupResult.firstSent;
      stats.followupSecondSent += followupResult.secondSent;
      stats.followupLaterSent += followupResult.laterSent;
      continue;
    }

    const followupResult = await appendSimDueFollowups({
      customerId,
      product,
      firstSeenAt,
      now,
      maxMessages: 10,
      simulateTemplateWindow: true,
    });
    await store.updateCustomer(customerId, () => ({ followupsSent: followupResult.followupsSent }));
    stats.followupFirstSent += followupResult.firstSent;
    stats.followupSecondSent += followupResult.secondSent;
    stats.followupLaterSent += followupResult.laterSent;
    stats.ignored += 1;
  }

    await store.appendOutboxMany(outboxBuffer);
    simulatedOutboxBuffer = null;

    await store.appendAuditLog({
      action: "generate_test_customers",
      result: "completed",
      reason: `Generated ${count} local simulated customer(s)`,
    });

    return { ok: true, generatedAt: new Date().toISOString(), batchId, outboxMessages: outboxBuffer.length, ...stats };
  } finally {
    simulatedOutboxBuffer = null;
  }
}

async function appendSimOpeningFlow(customerId, firstSeenAt, product) {
  const openingFlow = product.opening_flow?.length
    ? product.opening_flow
    : [{ type: "text", body: `Assalamualaikum kita nama saya Fadilah, skrg saya share info utk ${product.name}` }];
  let lastAt = addSeconds(firstSeenAt, 2);
  for (const [messageIndex, message] of openingFlow.entries()) {
    lastAt = addSeconds(firstSeenAt, 2 + messageIndex * 3);
    await appendSimMessage({
      createdAt: lastAt.toISOString(),
      direction: "outbound",
      from: "ai_agent",
      to: customerId,
      channel: "customer",
      type: message.type || "text",
      body: message.body || "",
      url: message.url || "",
      caption: message.caption || "",
    });
  }
  return lastAt;
}

async function appendSimOrderConversation({ batchId, index, customerId, product, packageItem, intentAt, detailsAt }) {
  await appendSimInbound(customerId, intentAt, `Saya mau order Package ${packageItem.id || "B"}`);
  await appendSimOutbound(customerId, addSeconds(intentAt, 5), "Noted and thank you.");
  await appendSimOutbound(
    customerId,
    addSeconds(intentAt, 9),
    "Can you help me fill up this details for hold promo? 🥰 \n\n✅ Full name : \n🏠 Full address : \n📱 Phone number : \n\nOrder Package :"
  );

  const phone = `6738${String(100000 + index).slice(-6)}`;
  const rawMessage = [
    `Full name: Test Customer ${index + 1}`,
    `Full address: Simpang ${index + 10}, Bandar Seri Begawan, Brunei`,
    `Phone number: ${phone}`,
    `Order Package: ${packageItem.id || "B"}`,
  ].join("\n");
  await appendSimInbound(customerId, detailsAt, rawMessage);
  await appendSimOutbound(
    customerId,
    addSeconds(detailsAt, 5),
    "Sorry Dear our stock just finish , it will take order again, will take around 15-18 days for arrived brunei new stock 🥰\n\nREMINDER : ORDER AFTER 1 HOURS CANNOT BE CANCEL"
  );
  await appendSimOutbound(
    customerId,
    addSeconds(detailsAt, 9),
    "But i will proceed system for COD service 🥰\n\nBrg Sampai baru byr runner"
  );

  return store.addOrder({
    businessAccountId: config.accountId,
    id: `ord_sim_${batchId}_${String(index + 1).padStart(3, "0")}`,
    customerId,
    productId: product.id,
    productName: product.name,
    shoppingLink: product.shopping_link || "",
    packageId: packageItem.id || "B",
    packageName: packageItem.name || "Package B",
    packagePrice: packageItem.price || "B$70",
    quantity: packageItem.total_units || 4,
    name: `Test Customer ${index + 1}`,
    phone,
    address: `Simpang ${index + 10}, Bandar Seri Begawan, Brunei`,
    rawMessage,
    createdAt: detailsAt.toISOString(),
    updatedAt: detailsAt.toISOString(),
  });
}

async function appendSimDueFollowups({
  customerId,
  product,
  firstSeenAt,
  now,
  maxMessages = 2,
  simulateTemplateWindow = false,
}) {
  const followupsSent = {};
  let sent = 0;
  let firstSent = 0;
  let secondSent = 0;
  let laterSent = 0;
  let lastSentAt = null;
  const baseCustomer = {
    firstSeenAt: firstSeenAt.toISOString(),
    lastInboundAt: firstSeenAt.toISOString(),
  };

  for (const item of productFollowupSequence(product)) {
    if (sent >= maxMessages) break;
    const dueAt = followupDueAt(firstSeenAt, item);
    if (dueAt > now) continue;
    if (!simulateTemplateWindow && !isWithinCustomerServiceWindow(baseCustomer, dueAt)) continue;
    await appendSimOutbound(customerId, dueAt, item.followup?.message || "");
    followupsSent[item.key] = dueAt.toISOString();
    sent += 1;
    lastSentAt = dueAt;
    if (item.key === "first_day_followup") firstSent += 1;
    else if (item.key === "day_1_followup") secondSent += 1;
    else laterSent += 1;
  }

  return { followupsSent, firstSent, secondSent, laterSent, lastSentAt };
}

async function appendSimInbound(customerId, createdAt, body) {
  await appendSimMessage({
    createdAt: createdAt.toISOString(),
    direction: "inbound",
    from: customerId,
    to: "agent",
    channel: "customer",
    type: "text",
    body,
  });
}

async function appendSimOutbound(customerId, createdAt, body) {
  await appendSimMessage({
    createdAt: createdAt.toISOString(),
    direction: "outbound",
    from: "ai_agent",
    to: customerId,
    channel: "customer",
    type: "text",
    body,
  });
}

async function appendSimAdmin(createdAt, body) {
  await appendSimMessage({
    createdAt: createdAt.toISOString(),
    direction: "outbound",
    from: "ai_agent",
    to: "admin",
    channel: "admin",
    type: "text",
    body,
  });
}

async function appendSimMessage(message) {
  if (simulatedOutboxBuffer) {
    simulatedOutboxBuffer.push(message);
    return;
  }
  await store.appendOutbox(message);
}

async function buildFollowupSettingsData(businessAccountId = config.accountId, content = null) {
  const teamContent = content || await getTeamContent(businessAccountId);
  const settings = await adminAccounts.getTeamSettings(businessAccountId);
  return {
    profile: normalizeDashboardProfile((await operations.getState()).dashboardProfile),
    followupMessages: teamFollowupMessages(teamContent),
    anotherDatePurchaseFollowup: teamAnotherDatePurchaseFollowup(teamContent),
    settings: {
      followupSendsPerMinute: Number(settings.followupSendsPerMinute || 0) || config.followupSendsPerMinute,
      followupIntervalMinutes: Number(settings.followupIntervalMinutes || 0) || config.followupIntervalMinutes,
      followupActiveWindowMinutes: Number(settings.followupActiveWindowMinutes || 0) || config.followupActiveWindowMinutes,
      followupPauseWindowMinutes: Number(settings.followupPauseWindowMinutes || 0) || config.followupPauseWindowMinutes,
    },
  };
}

async function saveFollowupRuntimeSettings(businessAccountId = config.accountId, settings = {}) {
  if (!settings || typeof settings !== "object") return null;
  const runtimeSettings = {
    followupSendsPerMinute: settings.followupSendsPerMinute,
    followupIntervalMinutes: settings.followupIntervalMinutes,
    followupActiveWindowMinutes: settings.followupActiveWindowMinutes,
    followupPauseWindowMinutes: settings.followupPauseWindowMinutes,
  };
  try {
    return await adminAccounts.updateTeamSettings(businessAccountId, runtimeSettings);
  } catch (error) {
    if (String(error?.message || "").toLowerCase().includes("account not found")) {
      console.warn(`Skipped follow-up runtime settings save for missing account ${businessAccountId}.`);
      return null;
    }
    throw error;
  }
}

async function buildDashboardData(now = new Date(), analyticsDate = now, businessAccountId = config.accountId) {
  const content = await getTeamContent(businessAccountId);
  const teamCatalog = content.catalog;
  const [
    allCustomers,
    allDeletedCustomers,
    allOrders,
    allOutbox,
    systemState,
    allFollowupQueue,
    orderStatusReplies,
    allComplaintCases,
  ] = await Promise.all([
    store.listCustomers(analyticsDate, businessAccountId),
    store.listDeletedCustomers(businessAccountId),
    store.listOrders(businessAccountId),
    store.listOutbox(businessAccountId),
    operations.getState(),
    operations.listFollowupQueue(businessAccountId),
    store.getOrderStatusReplies(businessAccountId),
    store.listComplaintCases(businessAccountId),
  ]);
  const belongsToBusiness = (item) => (item.businessAccountId || config.accountId) === businessAccountId;
  const belongsToDashboard = (item) =>
    belongsToBusiness(item) &&
    (item.businessAccountId || "") !== DEMO_ACCOUNT_ID &&
    !isDemoEnvironmentCustomerId(item.id || item.customerId || item.from || item.to);
  const belongsToDashboardOrder = (item) =>
    belongsToDashboard(item) || DASHBOARD_DEMO_ORDER_IDS.has(String(item.id || ""));
  const customers = allCustomers.filter(belongsToDashboard);
  const deletedCustomers = allDeletedCustomers.filter(belongsToDashboard);
  const orders = allOrders.filter(belongsToDashboardOrder);
  const followupQueue = allFollowupQueue.filter(belongsToDashboard);
  const complaintCases = allComplaintCases.filter(belongsToDashboard);
  const customerIds = new Set(customers.map((customer) => customer.id));
  const outbox = allOutbox.filter((message) =>
    !isDemoEnvironmentCustomerId(message.from) &&
    !isDemoEnvironmentCustomerId(message.to) &&
    (message.businessAccountId
      ? message.businessAccountId === businessAccountId && message.businessAccountId !== DEMO_ACCOUNT_ID
      : customerIds.has(message.to) || customerIds.has(message.from))
  );
  const productById = new Map(teamCatalog.products.map((product) => [product.id, product]));
  const ordersByCustomer = groupBy(orders, (order) => order.customerId);
  const customerById = new Map(customers.map((customer) => [customer.id, customer]));
  const latestOrderForCustomer = (customerId) => (ordersByCustomer.get(customerId) || []).at(-1) || null;
  const latestInboundForCustomer = (customerId) =>
    outbox
      .filter((message) => message.direction === "inbound" && message.from === customerId)
      .slice()
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
      .at(-1);
  const customerPhone = (customerId, order = null) => {
    const customer = customerById.get(customerId);
    const latestOrder = order || latestOrderForCustomer(customerId);
    return latestOrder?.phone || customer?.phone || phoneFromCustomerSource(customerId, customer?.source || {}) || customerId;
  };
  const handoffPhone = (customerId, order = null) => {
    return customerPhone(customerId, order);
  };
  const guardrails = buildGuardrailSummary(customers, now);
  const followupRows = buildFollowupRows(customers, productById, now, followupQueue);
  const pendingFollowupDispatches = followupQueue.filter((item) =>
    ["queued", "processing", "retry_pending"].includes(item.status)
  ).length;
  const customerRows = customers.map((customer) => {
    const customerOrders = ordersByCustomer.get(customer.id) || [];
    const latestOrder = customerOrders.at(-1) || {};
    return {
      id: customer.id,
      name: latestOrder.name || "",
      whatsappId: customer.id,
      phone: customerPhone(customer.id, latestOrder),
      address: latestOrder.address || "",
      productId: customer.productId || "",
      product: productById.get(customer.productId)?.name || customer.productId || "",
      skuCode: productById.get(customer.productId)?.sku_code || "",
      label: customer.label,
      labelDisplay: customer.labelDisplay,
      lastMessageAt: customer.lastMessageAt || "",
      firstSeenAt: customer.firstSeenAt || "",
      latestOrderCreatedAt: latestOrder.createdAt || "",
      inboundCount: Number(customer.inboundCount || 0),
      status: conversationStatus(customer, customerOrders),
      handoffReason: customer.handoffReason || "",
      guardrail: guardrailDisplay(customer, now),
      optedOut: Boolean(customer.optedOut),
      orderCount: customerOrders.length,
      anotherDatePurchaseDate: customer.anotherDatePurchaseDate || customer.plannedPurchaseDate || "",
      anotherDatePurchaseText: customer.anotherDatePurchaseText || "",
    };
  });
  const anotherDatePurchaseCustomers = customerRows
    .filter((customer) => customer.status === "another date purchase" && !customer.orderCount)
    .map((customer) => ({
      ...customer,
      plannedDate: customer.anotherDatePurchaseDate || "",
      note: customer.anotherDatePurchaseText || "",
    }));

  const handoffQueue = [
    ...complaintCases
      .filter((complaint) => complaint.status !== "resolved")
      .map((complaint) => ({
        type: "complaint",
        caseId: complaint.id,
        customerId: complaint.customerId,
        phone: handoffPhone(complaint.customerId),
        productId: complaint.productId || customerById.get(complaint.customerId)?.productId || "",
        product: productById.get(complaint.productId)?.name || complaint.productId || "",
        category: complaintCategoryDisplay(complaint.category),
        customerMessage: complaint.customerMessage,
        status: complaint.status,
        reason: complaint.reason || "Complaint requires human reply.",
        createdAt: complaint.createdAt,
      })),
    ...customers
      .filter((customer) =>
        customer.handoffStatus === "human_required" &&
        customer.complaintStatus !== "open" &&
        customer.handoffReason !== "Customer submitted complete order details."
      )
      .map((customer) => ({
        type: "conversation",
        customerId: customer.id,
        phone: handoffPhone(customer.id),
        productId: customer.productId || "",
        product: productById.get(customer.productId)?.name || customer.productId || "",
        category: "",
        customerMessage: latestInboundForCustomer(customer.id)?.body || "",
        reason: customer.handoffReason || "Human review needed",
        createdAt: customer.lastMessageAt || customer.firstSeenAt || "",
      })),
  ].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return {
    generatedAt: now.toISOString(),
    summary: {
      customers: customers.length,
      handoff: handoffQueue.length,
      complaints: complaintCases.filter((complaint) => complaint.status !== "resolved").length,
      orders: orders.length,
      followupsDue: followupRows.filter((row) => /^due\b/i.test(row.status || "")).length,
      followupsQueued: pendingFollowupDispatches,
      deleted: deletedCustomers.length,
      outbox: outbox.length,
      optedOut: guardrails.optedOut,
      blockedFollowups: guardrails.blockedFollowups,
    },
    analytics: buildAnalytics({ customers, orders, productById, now: analyticsDate, catalog: teamCatalog }),
    profile: normalizeDashboardProfile(systemState.dashboardProfile),
    orderStatusOptions: ORDER_STATUS_OPTIONS,
    orderStatusReplies,
    followupMessages: teamFollowupMessages({ catalog: teamCatalog }),
    guardrails,
    products: teamCatalog.products.map((product) => ({
      id: product.id,
      name: product.name,
      skuCode: product.sku_code || "",
      orderOptions: dashboardOrderOptions(product).map((option) => ({
        id: option.id,
        name: option.name,
        price: option.price,
        quantity: option.quantity,
        legacyPackage: option.legacyPackage,
      })),
    })),
    customers: customerRows,
    anotherDatePurchaseCustomers,
    handoffQueue,
    orders: orders.map((order) => ({
      id: order.id,
      customerId: order.customerId,
      businessAccountId: order.businessAccountId || "",
      package: order.orderOptionName || order.packageName || order.orderOptionId || order.packageId || "",
      packagePrice: order.orderOptionPrice || order.packagePrice || "",
      quantity: order.quantity || "",
      totalSales: formatCurrency(orderSalesAmount(order)),
      name: order.name || "",
      phone: order.phone || "",
      address: order.address || "",
      product: order.productName || productById.get(order.productId)?.name || order.productId || "",
      skuCode: productById.get(order.productId)?.sku_code || "",
      status: order.status || "",
      statusDisplay: orderStatusDisplay(order.status),
      statusUpdatedAt: order.statusUpdatedAt || order.updatedAt || "",
      statusHistory: order.statusHistory || [],
      acknowledgedAt: order.acknowledgedAt || "",
      completedAt: order.completedAt || "",
      createdAt: order.createdAt || "",
      orderTimestamp: order.createdAt || "",
      orderRecord: formatOrderRecord(order, productById),
      rawMessage: order.rawMessage || "",
    })),
    orderCustomers: orders.map((order) => ({
      id: order.id,
      customerId: order.customerId,
      businessAccountId: order.businessAccountId || "",
      product: order.productName || productById.get(order.productId)?.name || order.productId || "",
      skuCode: productById.get(order.productId)?.sku_code || "",
      package: order.orderOptionName || order.packageName || order.orderOptionId || order.packageId || "",
      packagePrice: order.orderOptionPrice || order.packagePrice || "",
      addOnChoice: order.addOnChoice || "",
      quantity: order.quantity || "",
      name: order.name || "",
      phone: order.phone || "",
      address: order.address || "",
      status: order.status || "",
      statusDisplay: orderStatusDisplay(order.status),
      statusUpdatedAt: order.statusUpdatedAt || order.updatedAt || "",
      createdAt: order.createdAt || "",
      orderTimestamp: order.createdAt || "",
    })),
    orderCustomerCount: new Set(orders.map((order) => order.customerId).filter(Boolean)).size,
    followups: followupRows,
    followupQueue: followupQueue.slice(0, 250),
    deletedCustomers: deletedCustomers.map((customer) => ({
      id: customer.id,
      product: productById.get(customer.productId)?.name || customer.productId || "",
      skuCode: productById.get(customer.productId)?.sku_code || "",
      label: customer.label,
      labelDisplay: customer.labelDisplay || "DELETE",
      firstSeenAt: customer.firstSeenAt || "",
      deletedAt: customer.deletedAt || "",
      deleteReason: customer.deleteReason || "",
    })),
    conversationMessages: outbox
      .slice()
      .slice(-5000)
      .map(formatDashboardMessage),
    outbox: outbox
      .slice()
      .reverse()
      .slice(0, 200)
      .map(formatDashboardMessage),
  };
}

async function buildComplianceData() {
  const customers = await store.listCustomers();
  const guardrails = buildGuardrailSummary(customers);
  return {
    generatedAt: new Date().toISOString(),
    retentionPolicy: [
      {
        item: "No-reply leads",
        rule: "Delete from active customers on DAY 11 if the customer never replied after the first product info/images flow and has no order.",
      },
      {
        item: "Message log",
        rule: "Demo keeps messages locally. Production recommendation: retain 30-90 days unless needed for disputes or legal/accounting reasons.",
      },
      {
        item: "Orders",
        rule: "Keep only data needed for fulfilment, delivery, refund, and accounting. Review retention before launch.",
      },
      {
        item: "Deleted customers",
        rule: "Keep minimal audit data only: customer id, deleted time, reason. Avoid keeping full chat forever.",
      },
    ],
    securityChecklist: [
      { item: "HTTPS in production", status: "required" },
      { item: "Meta webhook signature verification", status: config.appSecret ? "configured" : "needs WHATSAPP_APP_SECRET" },
      { item: "Secrets stored outside code", status: "use .env or production secret manager" },
      { item: "Admin login", status: "configured for demo; set ADMIN_PASSWORD before production" },
      { item: "Admin roles and 2FA", status: "production hardening step" },
      { item: "Database encryption and backups", status: "next production step" },
      { item: "Restrict dashboard access", status: "next production step" },
    ],
    automationGuardrails: [
      { item: "Opt-out detection", status: "enabled for exact keywords plus similar meaning in English, Malay, and Brunei Malay" },
      { item: "Possible opt-out or low-interest wording", status: "uncertain meanings are noted, but follow-up continues unless customer clearly opts out" },
      { item: "Opted-out customers", status: `${guardrails.optedOut} active customer(s)` },
      { item: "Follow-up cap", status: guardrails.followupCap },
      { item: "24-hour window", status: guardrails.windowRule },
      { item: "Template-required follow-ups", status: `${guardrails.outside24HourWindow} customer(s) currently outside 24h window` },
      { item: "Follow-up dispatch throttling", status: `queued, rotated by stage, delayed ${Math.round(config.followupSendDelayMinMs / 1000)}-${Math.round(config.followupSendDelayMaxMs / 1000)}s each, up to ${Math.max(config.followupSendsPerMinute, 1)} message(s) per minute for ${Math.max(config.followupActiveWindowMinutes, 1)} minutes, then ${Math.max(config.followupPauseWindowMinutes, 0)} minutes pause` },
      { item: "Human handoff", status: `${guardrails.humanRequired} customer(s) require human review; complaint cases pause follow-ups until resolved` },
      { item: "Order status lookup", status: "answers only from the current business account and customer WhatsApp ID" },
      { item: "Block/report risk monitor", status: "production step: connect Meta quality rating, blocks, and reports once WhatsApp API is live" },
      { item: "Message quality", status: "avoid misleading claims, fake scarcity, and restricted product claims" },
      { item: "Official API", status: "use WhatsApp Business Platform/API; avoid WhatsApp Web scraping/bulk sender tools" },
    ],
    whatsappReadiness: [
      { item: "Demo mode disabled", status: config.demoMode ? "not ready: DEMO_MODE=true" : "ready" },
      { item: "Phone number ID", status: config.phoneNumberId ? "configured" : "missing WHATSAPP_PHONE_NUMBER_ID" },
      { item: "Access token", status: config.accessToken ? "configured" : "missing WHATSAPP_ACCESS_TOKEN" },
      { item: "Webhook verify token", status: config.verifyToken ? "configured" : "missing WHATSAPP_VERIFY_TOKEN" },
      { item: "App secret signature check", status: config.appSecret ? "configured" : "missing WHATSAPP_APP_SECRET" },
      { item: "Public HTTPS base URL for images", status: config.publicBaseUrl ? "configured" : "missing PUBLIC_BASE_URL" },
      { item: "Admin WhatsApp alert number", status: config.adminWhatsAppNumber ? "configured" : "missing ADMIN_WHATSAPP_NUMBER" },
      { item: "Approved knowledge vector-store RAG", status: config.openaiApiKey && config.vectorStoreId ? "configured" : "optional: missing OpenAI key/vector store" },
    ],
    privacyNotice: [
      "We collect your WhatsApp number, messages, name, phone number, address, selected product/package, and order details to answer enquiries, process orders, arrange delivery, and provide customer support.",
      "We do not ask for passwords, OTPs, or full card details.",
      "You may request access, correction, or deletion of your personal data by contacting our team.",
      "Your data is kept only as long as needed for customer service, order fulfilment, legal/accounting needs, and fraud prevention.",
    ],
    handoffRules: [
      "AI cannot answer after checking sales responses, FAQ, and RAG.",
      "Customer submits complete order details.",
      "Refund, damaged item, complaint, legal threat, sensitive personal data, or payment confirmation.",
      "Customer opts out or asks not to be messaged.",
    ],
    auditLog: (await store.listAuditLog()).slice().reverse().slice(0, 200),
  };
}

function formatDashboardMessage(message) {
  return {
    id: message.id,
    createdAt: message.createdAt || "",
    direction: message.direction || "outbound",
    from: message.from || "",
    to: message.to || "",
    channel: message.channel || "customer",
    type: message.type || "text",
    sentFrom:
      message.direction === "inbound"
        ? message.from || "Customer"
        : message.channel === "admin"
          ? "Admin alert"
          : message.channel === "business_admin"
            ? "Business admin"
            : "AI agent",
    body: message.body || message.caption || message.url || (message.name ? `[template] ${message.name}` : ""),
  };
}

function conversationStatus(customer, customerOrders) {
  if (customer.optedOut) return "opted out";
  if (customerOrders.length > 0 && customer.handoffReason === "Customer submitted complete order details.") {
    return orderStatusDisplay(customerOrders.at(-1).status);
  }
  if (customerOrders.length > 0) return orderStatusDisplay(customerOrders.at(-1).status);
  if (customer.salesStatus === "another_date_purchase" || customer.status === "another_date_purchase") return "another date purchase";
  if (customer.complaintStatus === "open") return "complaint - human required";
  if (customer.handoffStatus === "human_required") return "human required";
  if (Number(customer.inboundCount || 0) <= 1) return "new lead";
  return "engaged";
}

function buildGuardrailSummary(customers, now = new Date()) {
  const rows = customers.map((customer) => followupGuardrailStatus(customer, now));
  const blockedReasons = rows.filter((row) => row.blocked);
  return {
    optedOut: rows.filter((row) => row.reason === "opted_out").length,
    blockedFollowups: blockedReasons.length,
    outside24HourWindow: rows.filter((row) => row.reason === "outside_24_hour_window").length,
    humanRequired: customers.filter((customer) => customer.handoffStatus === "human_required").length,
    followupCap: "follow-ups continue until order details are submitted, customer opts out, or sequence ends",
    optOutHandling: "enabled",
    windowRule: "outside the 24-hour customer service window, production WhatsApp follow-ups must use approved templates",
  };
}

function guardrailDisplay(customer, now = new Date()) {
  const status = followupGuardrailStatus(customer, now);
  if (!status.blocked) return "ok";
  if (status.reason === "opted_out") return "opted out: no follow-up";
  if (status.reason === "complaint_handoff") return "complaint: human required";
  if (status.reason === "human_handoff") return "human handoff: no follow-up";
  if (status.reason === "outside_24_hour_window") return "template follow-up required";
  if (status.reason === "order_submitted") return "order submitted";
  if (customer.followupBlockedReason === "another_date_purchase") return "another date purchase";
  return status.reason;
}

function followupGuardrailStatus(customer, now = new Date()) {
  if (customer.optedOut) return { blocked: true, reason: "opted_out" };
  if ((customer.orderIds || []).length > 0) return { blocked: true, reason: "order_submitted" };
  if (customer.complaintStatus === "open" || customer.followupBlockedReason === "complaint_handoff") {
    return { blocked: true, reason: "complaint_handoff" };
  }
  if (customer.handoffStatus === "human_required") return { blocked: true, reason: "human_handoff" };
  if (customer.followupBlocked) return { blocked: true, reason: "followup_blocked" };
  if (!isWithinCustomerServiceWindow(customer, now)) return { blocked: false, reason: "outside_24_hour_window" };
  return { blocked: false, reason: "ok" };
}

function buildFollowupRows(customers, productById, now, queueItems = []) {
  const queueByDispatchKey = new Map(queueItems.map((item) => [item.dispatchKey, item]));
  return customers.map((customer) => {
    const product = productById.get(customer.productId);
    const sent = customer.followupsSent || {};
    const hasOrder = (customer.orderIds || []).length > 0;
    const followups = productFollowupSequence(product);
    const nextItem = currentFollowupStage(customer, followups, now);
    let nextFollowup = nextItem?.key || "";
    let nextDueAt = nextItem ? effectiveFollowupDueAt(customer, nextItem, followups) : null;
    let status = nextDueAt && isCurrentFollowupSendWindow(customer, nextItem, followups, now) ? "due" : "scheduled";
    const dispatchKey = [
      customer.businessAccountId || config.accountId,
      customer.id,
      nextFollowup,
    ].join(":");
    const queuedItem = nextItem ? queueByDispatchKey.get(dispatchKey) : null;

    if (!nextItem) {
      status = "completed";
    } else if (sent[nextItem.key]) {
      status = "completed";
    }
    const guardrail = followupGuardrailStatus(customer, now);
    if (hasOrder) status = "skipped order";
    if (guardrail.reason === "opted_out") status = "blocked: opted out";
    if (guardrail.reason === "human_handoff") status = "blocked: human handoff";
    if (guardrail.reason === "complaint_handoff") status = "blocked: complaint";
    if (guardrail.reason === "followup_blocked") status = "blocked";
    if (guardrail.reason === "outside_24_hour_window") {
      status = status === "due" ? "due: send approved template" : `${status}: approved template`;
    }
    if (
      queuedItem &&
      ["queued", "processing", "retry_pending"].includes(queuedItem.status) &&
      !hasOrder &&
      (config.demoMode || guardrail.reason === "ok" || Boolean(followupTemplateName(nextFollowup)))
    ) {
      status =
        queuedItem.status === "processing"
          ? "sending"
          : queuedItem.status === "retry_pending"
            ? "queued: retry pending"
            : "queued";
    }

    return {
      customerId: customer.id,
      product: product?.name || customer.productId || "",
      labelDisplay: customer.labelDisplay,
      firstSeenAt: customer.firstSeenAt || "",
      nextFollowup,
      nextDueAt: nextDueAt ? nextDueAt.toISOString() : "",
      status,
      queueStatus: queuedItem?.status || "",
      queueAttempts: queuedItem?.attempts || 0,
      guardrail: guardrailDisplay(customer, now),
      sentFirst: sent.first_day_followup || "",
      sentDay1: sent.day_1_followup || "",
      sentCount: followups.filter((item) => sent[item.key]).length,
      totalFollowups: followups.length,
    };
  });
}

function buildAnalytics({ customers, orders, productById, now, catalog: activeCatalog = catalog }) {
  const selectedDateCustomers = customers.filter((customer) => isSameLocalDate(customer.firstSeenAt, now));
  const selectedDateCustomerIds = new Set(selectedDateCustomers.map((customer) => customer.id));
  const selectedDateOrders = orders.filter((order) => isSameLocalDate(order.createdAt, now));
  const selectedDateOrdersFromNewCustomers = selectedDateOrders.filter((order) =>
    selectedDateCustomerIds.has(order.customerId)
  );
  const productCounts = new Map();
  for (const customer of selectedDateCustomers) {
    const productName = productById.get(customer.productId)?.name || customer.productId || "Unknown product";
    productCounts.set(productName, (productCounts.get(productName) || 0) + 1);
  }
  const orderProductCounts = new Map();
  for (const order of selectedDateOrders) {
    const productName = order.productName || productById.get(order.productId)?.name || order.productId || "Unknown product";
    orderProductCounts.set(productName, (orderProductCounts.get(productName) || 0) + 1);
  }
  const totalSales = selectedDateOrders.reduce((sum, order) => sum + orderSalesAmount(order), 0);
  const followupPerformance = buildFollowupPerformance(customers, now, activeCatalog);
  const hourlyCustomerCounts = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: `${String(hour).padStart(2, "0")}:00`,
    count: 0,
  }));
  for (const customer of selectedDateCustomers) {
    const firstSeen = new Date(customer.firstSeenAt);
    if (!Number.isNaN(firstSeen.getTime())) {
      hourlyCustomerCounts[firstSeen.getHours()].count += 1;
    }
  }
  const sevenDayCustomerCounts = Array.from({ length: 7 }, (_, index) => {
    const date = addLocalDays(now, index - 6);
    const dateKey = formatLocalDate(date);
    const count = customers.filter((customer) => isSameLocalDate(customer.firstSeenAt, date)).length;
    return {
      date: dateKey,
      label: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      count,
    };
  });

  return {
    date: formatLocalDate(now),
    totalNewCustomersToday: selectedDateCustomers.length,
    totalOrdersFromNewCustomersToday: selectedDateOrdersFromNewCustomers.length,
    totalOrdersToday: selectedDateOrders.length,
    totalSalesToday: totalSales,
    totalSalesTodayDisplay: formatCurrency(totalSales),
    newCustomersByProductToday: [...productCounts.entries()]
      .map(([product, count]) => ({ product, count }))
      .sort((a, b) => b.count - a.count || a.product.localeCompare(b.product)),
    newOrdersByProductToday: [...orderProductCounts.entries()]
      .map(([product, count]) => ({ product, label: product, count }))
      .sort((a, b) => b.count - a.count || a.product.localeCompare(b.product)),
    customerCharts: {
      hourly: hourlyCustomerCounts,
      sevenDays: sevenDayCustomerCounts,
      followups: followupPerformance,
    },
  };
}

function buildFollowupPerformance(customers, now, activeCatalog = catalog) {
  const product = activeCatalog.products.find((item) => item.id === activeCatalog.default_product_id) || activeCatalog.products[0];
  return productFollowupSequence(product).map((stage) => {
    const sentCustomers = customers.filter((customer) => {
      const sentAt = customer.followupsSent?.[stage.key];
      return sentAt && isSameLocalDate(sentAt, now);
    });
    const replies = sentCustomers.filter((customer) => {
      const sentAt = new Date(customer.followupsSent?.[stage.key] || 0).getTime();
      const lastInbound = new Date(customer.lastInboundAt || customer.lastMessageAt || 0).getTime();
      return Number.isFinite(sentAt) && lastInbound > sentAt;
    }).length;
    const sent = sentCustomers.length;
    const replyRate = sent === 0 ? 0 : Math.round((replies / sent) * 1000) / 10;
    return {
      label: followupStageName(stage.key),
      sent,
      replies,
      replyRate,
      rateLabel: `${replyRate}%`,
    };
  });
}

function followupStageName(value) {
  if (value === "first_day_followup") return "First follow-up";
  if (value === "day_1_followup") return "Second follow-up";
  const dayMatch = String(value || "").match(/^day_(\d+)_followup$/);
  if (dayMatch) return `Day ${dayMatch[1]} follow-up`;
  return "-";
}

function orderSalesAmount(order) {
  if (Number.isFinite(Number(order.totalAmount))) return Number(order.totalAmount);
  const price = Number(String(order.orderOptionPrice || order.packagePrice || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(price) ? price : 0;
}

function formatOrderRecord(order, productById) {
  const productName = order.productName || productById.get(order.productId)?.name || order.productId || "Product";
  const quantity = order.quantity || "";
  const price = order.orderOptionPrice || order.packagePrice || formatCurrency(orderSalesAmount(order));
  const optionName = order.orderOptionName || order.packageName || "";
  return [
    `Name: ${order.name || ""}`,
    `Phone number: ${order.phone || ""}`,
    `Address: ${order.address || ""}`,
    ...(optionName ? [`Order option: ${optionName}`] : []),
    ...(order.addOnChoice ? [`Add-on choice: ${order.addOnChoice}`] : []),
    "",
    `${productName} x ${quantity} units , ${price}`,
    "Free delivery & COD",
  ].join("\n");
}

function reachedWarehouseCustomerMessage(order, template = "") {
  const text = String(template || "").trim() ||
    "Salam kita, dlm 1-3 ari runner will hantar brg '{quantity} unit {product}' utk kita ya \uD83E\uDD70\nKita ingat reply Runner text, Runner TOMU LOGISTIC. \uD83E\uDD70";
  return renderOrderStatusReply(text, order);
}

function formatOrderAdminRow(order) {
  const productById = new Map(catalog.products.map((product) => [product.id, product]));
  const product = productById.get(order.productId);
  return {
    id: order.id,
    businessAccountId: order.businessAccountId || config.accountId,
    customerId: order.customerId,
    product: order.productName || product?.name || order.productId || "",
    package: order.orderOptionName || order.packageName || order.orderOptionId || order.packageId || "",
    name: order.name || "",
    phone: order.phone || "",
    address: order.address || "",
    record: formatOrderRecord(order, productById),
    shoppingLink: order.shoppingLink || product?.shopping_link || "",
    status: order.status || "",
    statusDisplay: orderStatusDisplay(order.status),
    statusUpdatedAt: order.statusUpdatedAt || order.updatedAt || "",
    statusHistory: order.statusHistory || [],
    createdAt: order.createdAt || "",
    updatedAt: order.updatedAt || "",
    acknowledgedAt: order.acknowledgedAt || "",
    completedAt: order.completedAt || "",
  };
}

function dashboardOrderOptions(product = {}) {
  const explicit = Array.isArray(product.order_options) ? product.order_options : [];
  if (explicit.length) {
    const packageIds = new Set((product.packages || []).map((item) => String(item.id || "").toLowerCase()));
    return explicit.map((item) => dashboardOrderOption(item, packageIds.has(String(item.id || "").toLowerCase())));
  }
  return (product.packages || []).map((item) => dashboardOrderOption(item, true));
}

function dashboardOrderOption(item = {}, legacyPackage = false) {
  const name = String(item.name || item.label || item.id || "").trim();
  const id = String(item.id || item.name || name).trim();
  return {
    id,
    name,
    price: String(item.price || "").trim(),
    quantity: Number(item.quantity || item.total_units || 1) || 1,
    legacyPackage: Boolean(legacyPackage || /^package\s+[a-z0-9]+$/i.test(name)),
  };
}

function legacyPackageIdForDashboardOption(option = {}) {
  return String(option.name || "").match(/^package\s+([a-z0-9]+)$/i)?.[1] || String(option.id || "");
}

function formatCurrency(amount) {
  return `B$${Number(amount || 0).toFixed(2)}`;
}

function addLocalDays(value, days) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function addHours(value, hours) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  date.setHours(date.getHours() + hours);
  return date;
}

function addSeconds(value, seconds) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  date.setSeconds(date.getSeconds() + seconds);
  return date;
}

function addMinutes(value, minutes) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  date.setMinutes(date.getMinutes() + minutes);
  return date;
}

function randomDateWithinDays(now, days, seed) {
  const date = new Date(now);
  const dayOffset = seed % (days + 1);
  const hour = (seed * 7) % 24;
  const minute = (seed * 13) % 60;
  date.setDate(date.getDate() - dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date;
}

function testScenario(index) {
  const scenarios = [
    "order_complete",
    "sales_response",
    "faq_location",
    "normal_faq",
    "followup_reply",
    "order_after_followup",
    "opted_out_exact",
    "opted_out_semantic",
    "low_interest",
    "unknown_handoff",
    "ignored_short",
    "ignored_long",
  ];
  return scenarios[index % scenarios.length];
}

function isSameLocalDate(value, now) {
  if (!value) return false;
  return formatLocalDate(new Date(value)) === formatLocalDate(now);
}

function parseSelectedDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date();
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function normalizeDashboardProfile(profile = {}) {
  const name = String(profile.name || "AI Agent Monitor").trim().slice(0, 80) || "AI Agent Monitor";
  const accentColor = /^#[0-9a-fA-F]{6}$/.test(String(profile.accentColor || ""))
    ? String(profile.accentColor)
    : "#0071e3";
  return { name, accentColor };
}

function isDemoEnvironmentCustomerId(value) {
  return /^(customer_\d+|demo_|sim_customer_)/.test(String(value || ""));
}

function formatLocalDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function firstFollowupDueAt(firstSeenAt, options = {}) {
  const firstSeen = new Date(firstSeenAt);
  const cutoffEnabled = options.cutoffEnabled !== false;
  const cutoffHour = Number.isFinite(options.cutoffHour) ? options.cutoffHour : 19;
  const sendHour = Number.isFinite(options.sendHour) ? options.sendHour : 20;
  const firstSeenLocal = followupZonedDateParts(firstSeen);
  const dueLocal = { ...firstSeenLocal, hour: sendHour, minute: 0, second: 0, millisecond: 0 };
  if (cutoffEnabled && firstSeenLocal.hour >= cutoffHour) {
    const next = addFollowupLocalDays(dueLocal, 1);
    return followupZonedLocalToDate(next);
  }
  return followupZonedLocalToDate(dueLocal);
}

function addFollowupLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour || 0, parts.minute || 0, parts.second || 0, parts.millisecond || 0));
  return {
    ...parts,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function followupZonedDateParts(date, timeZone = config.businessTimeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return {
    year: value.year,
    month: value.month,
    day: value.day,
    hour: value.hour,
    minute: value.minute,
    second: value.second,
    millisecond: date.getMilliseconds(),
  };
}

function followupZonedLocalToDate(parts, timeZone = config.businessTimeZone) {
  const targetUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0, parts.millisecond || 0);
  const guess = new Date(targetUtc);
  const guessParts = followupZonedDateParts(guess, timeZone);
  const guessAsUtc = Date.UTC(
    guessParts.year,
    guessParts.month - 1,
    guessParts.day,
    guessParts.hour || 0,
    guessParts.minute || 0,
    guessParts.second || 0,
    guessParts.millisecond || 0
  );
  return new Date(targetUtc - (guessAsUtc - guess.getTime()));
}

function productFollowupSequence(product) {
  const entries = Object.entries(product?.followups || {});
  const firstFollowup = entries.find(([key]) => key === "first_day_followup")?.[1] || {};
  return entries
    .map(([key, followup], index) => {
      const messages = normalizeFollowupMessageBlocks(followup?.messages, followup?.message);
      return {
        key,
        followup: {
          ...followup,
          message: followupTextSummary(messages, followup?.message),
          messages,
        },
        firstFollowup,
        index,
        dayOffset: followupDayOffset(key, followup, index),
        sendHour: Number.isFinite(followup?.send_hour) ? followup.send_hour : 20,
      };
    })
    .filter((item) => item.followup.messages.length)
    .sort((a, b) => a.dayOffset - b.dayOffset || a.index - b.index);
}

function teamFollowupMessages(content = defaultTeamContent) {
  const products = content?.catalog?.products || [];
  const sourceProduct = products.find((product) => product?.followups && Object.keys(product.followups).length) || products[0] || {};
  return FOLLOWUP_EDITOR_STAGES.map((stage) => {
    const followup = sourceProduct.followups?.[stage.key] || {};
    const messages = normalizeFollowupMessageBlocks(followup.messages, followup.message);
    return {
      key: stage.key,
      label: stage.label,
      dayOffset: Number.isFinite(followup.day_offset) ? followup.day_offset : stage.dayOffset,
      sendHour: Number.isFinite(followup.send_hour) ? followup.send_hour : stage.defaultSendHour,
      message: followupTextSummary(messages, followup.message),
      messages,
      enabled: messages.length > 0,
      firstChatCutoffEnabled: stage.firstChatCutoffHour !== undefined
        ? followup.first_chat_cutoff_enabled !== false
        : undefined,
      firstChatCutoffHour: stage.firstChatCutoffHour !== undefined
        ? clampNumber(
            followup.first_chat_cutoff_hour,
            0,
            23,
            stage.firstChatCutoffHour
          )
        : undefined,
    };
  });
}

function updateTeamFollowupMessages(content = defaultTeamContent, stages = []) {
  const byKey = new Map((Array.isArray(stages) ? stages : []).map((stage) => [String(stage.key || ""), stage]));
  const products = content?.catalog?.products || [];
  let updatedProducts = 0;
  for (const product of products) {
    product.followups = product.followups && typeof product.followups === "object" ? product.followups : {};
    let changed = false;
    for (const stage of FOLLOWUP_EDITOR_STAGES) {
      if (!byKey.has(stage.key)) continue;
      const input = byKey.get(stage.key) || {};
      const messages = normalizeFollowupMessageBlocks(input.messages, input.message);
      if (!messages.length) {
        if (product.followups[stage.key]) {
          delete product.followups[stage.key];
          changed = true;
        }
        continue;
      }
      const existing = product.followups[stage.key] || {};
      product.followups[stage.key] = {
        ...existing,
        send_hour: clampNumber(input.sendHour, 0, 23, Number.isFinite(existing.send_hour) ? existing.send_hour : stage.defaultSendHour),
        day_offset: stage.dayOffset,
        message: followupTextSummary(messages, ""),
        messages,
      };
      if (stage.firstChatCutoffHour !== undefined) {
        product.followups[stage.key].first_chat_cutoff_enabled = input.firstChatCutoffEnabled !== false;
        product.followups[stage.key].first_chat_cutoff_hour = clampNumber(
          input.firstChatCutoffHour,
          0,
          23,
          Number.isFinite(existing.first_chat_cutoff_hour) ? existing.first_chat_cutoff_hour : stage.firstChatCutoffHour
        );
      }
      changed = true;
    }
    if (changed) updatedProducts += 1;
  }
  return { updatedProducts, stages: teamFollowupMessages(content) };
}

function normalizeFollowupMessageBlocks(blocks, fallbackMessage = "") {
  const source = Array.isArray(blocks) ? blocks : [];
  const normalized = source.map((block, index) => normalizeFollowupMessageBlock(block, index)).filter(Boolean);
  if (normalized.length) return normalized;
  const message = String(fallbackMessage || "").trim();
  return message ? [{ id: `text_${Date.now()}_0`, type: "text", body: message }] : [];
}

function normalizeFollowupMessageBlock(block = {}, index = 0) {
  const type = String(block.type || "text").trim().toLowerCase();
  const id = String(block.id || `block_${Date.now()}_${index}`).trim();
  if (type === "image" || type === "video") {
    const url = String(block.url || "").trim();
    if (!url) return null;
    return {
      id,
      type,
      url,
      caption: String(block.caption || "").trim(),
    };
  }
  const body = String(block.body || block.message || block.text || "").trim();
  return body ? { id, type: "text", body } : null;
}

function followupTextSummary(messages = [], fallback = "") {
  const text = messages.find((message) => message.type === "text" && String(message.body || "").trim());
  if (text) return String(text.body || "").trim();
  const caption = messages.find((message) => String(message.caption || "").trim());
  if (caption) return String(caption.caption || "").trim();
  return String(fallback || "").trim();
}

function followupOutboundMessages(followup = {}) {
  return normalizeFollowupMessageBlocks(followup.messages, followup.message).map((message) => {
    if (message.type === "image" || message.type === "video") {
      return { type: message.type, url: message.url, caption: message.caption || "" };
    }
    return textMessage(message.body);
  });
}

function defaultAnotherDatePurchaseFollowupSettings() {
  return {
    enabled: true,
    fallbackDayOfMonth: 20,
    sendHour: 20,
    message: "Hi kita, just follow up pasal kita pernah mention kan beli nanti. Masih mau saya bantu arrange order hari ani?",
    messages: [
      {
        id: "text_another_date_purchase_followup",
        type: "text",
        body: "Hi kita, just follow up pasal kita pernah mention kan beli nanti. Masih mau saya bantu arrange order hari ani?",
      },
    ],
  };
}

function normalizeAnotherDatePurchaseFollowupSettings(input = {}) {
  const fallback = defaultAnotherDatePurchaseFollowupSettings();
  const messages = normalizeFollowupMessageBlocks(input.messages, input.message || fallback.message);
  return {
    enabled: input.enabled !== false,
    fallbackDayOfMonth: clampNumber(input.fallbackDayOfMonth ?? input.fallback_day_of_month, 1, 31, fallback.fallbackDayOfMonth),
    sendHour: clampNumber(input.sendHour ?? input.send_hour, 0, 23, fallback.sendHour),
    message: followupTextSummary(messages, input.message || fallback.message),
    messages,
  };
}

function teamAnotherDatePurchaseFollowup(content = defaultTeamContent) {
  return normalizeAnotherDatePurchaseFollowupSettings(content?.followupSettings?.anotherDatePurchase || {});
}

function updateAnotherDatePurchaseFollowup(content = defaultTeamContent, input = {}) {
  content.followupSettings = content.followupSettings && typeof content.followupSettings === "object"
    ? content.followupSettings
    : {};
  content.followupSettings.anotherDatePurchase = normalizeAnotherDatePurchaseFollowupSettings(input);
  return content.followupSettings.anotherDatePurchase;
}

function anotherDatePurchaseFollowupItem(customer, product, content, now = new Date()) {
  if (customer?.salesStatus !== "another_date_purchase" && customer?.status !== "another_date_purchase") return null;
  if ((customer.orderIds || []).length > 0 || customer.optedOut || customer.followupsSent?.another_date_purchase_followup) return null;
  const settings = teamAnotherDatePurchaseFollowup(content);
  if (!settings.enabled || !settings.messages.length) return null;
  const dueAt = anotherDatePurchaseDueAt(customer, settings, now);
  if (!dueAt || !isSameFollowupLocalDay(dueAt, now) || followupZonedDateParts(now).hour !== settings.sendHour || now < dueAt) return null;
  return {
    customer,
    product,
    followup: {
      message: settings.message,
      messages: settings.messages,
    },
    followupKey: "another_date_purchase_followup",
  };
}

function anotherDatePurchaseDueAt(customer, settings, now = new Date()) {
  const plannedDate = validDateOrNull(customer.anotherDatePurchaseDate || customer.plannedPurchaseDate);
  if (plannedDate) {
    const parts = followupZonedDateParts(plannedDate);
    return followupZonedLocalToDate({ ...parts, hour: settings.sendHour, minute: 0, second: 0, millisecond: 0 });
  }
  const basis = validDateOrNull(customer.anotherDatePurchaseAt || customer.lastSalesReplyAt || customer.firstSeenAt) || now;
  return nextFallbackDayOfMonthDueAt(basis, settings.fallbackDayOfMonth, settings.sendHour);
}

function nextFallbackDayOfMonthDueAt(basis, dayOfMonth, sendHour) {
  const basisParts = followupZonedDateParts(basis);
  let parts = {
    year: basisParts.year,
    month: basisParts.month,
    day: clampNumber(dayOfMonth, 1, 31, 20),
    hour: sendHour,
    minute: 0,
    second: 0,
    millisecond: 0,
  };
  let due = followupZonedLocalToDate(parts);
  if (due < basis) {
    parts = {
      ...parts,
      month: parts.month + 1,
    };
    due = followupZonedLocalToDate(parts);
  }
  return due;
}

function validDateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isSameFollowupLocalDay(left, right) {
  const a = followupZonedDateParts(left);
  const b = followupZonedDateParts(right);
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function followupDayOffset(key, followup, index) {
  if (Number.isFinite(followup?.day_offset)) return followup.day_offset;
  if (key === "first_day_followup") return 0;
  const dayMatch = String(key).match(/^day_(\d+)_followup$/);
  if (dayMatch) return Number(dayMatch[1]);
  return index;
}

function followupDueAt(firstSeenAt, item) {
  const firstDueAt = firstFollowupDueAt(firstSeenAt, {
    cutoffEnabled: item.firstFollowup?.first_chat_cutoff_enabled !== false,
    cutoffHour: item.firstFollowup?.first_chat_cutoff_hour,
    sendHour: Number.isFinite(item.firstFollowup?.send_hour) ? item.firstFollowup.send_hour : item.sendHour,
  });
  if (item.key === "first_day_followup") return firstDueAt;

  const firstSeenLocal = followupZonedDateParts(new Date(firstSeenAt));
  const dueLocal = addFollowupLocalDays({ ...firstSeenLocal, hour: item.sendHour, minute: 0, second: 0, millisecond: 0 }, item.dayOffset);
  let due = followupZonedLocalToDate(dueLocal);
  if (due <= firstDueAt) {
    due = followupZonedLocalToDate(addFollowupLocalDays({ ...followupZonedDateParts(firstDueAt), hour: item.sendHour, minute: 0, second: 0, millisecond: 0 }, 1));
  }
  return due;
}

function previousFollowupSentAt(customer, item, sequence = []) {
  const itemIndex = sequence.findIndex((entry) => entry.key === item.key);
  if (itemIndex <= 0) return null;
  for (let index = itemIndex - 1; index >= 0; index -= 1) {
    const sentAt = customer.followupsSent?.[sequence[index].key];
    if (!sentAt) continue;
    const date = new Date(sentAt);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function followupDueAfterPreviousSent(previousSentAt, item) {
  const previousLocal = followupZonedDateParts(previousSentAt);
  const nextLocal = addFollowupLocalDays(
    { ...previousLocal, hour: item.sendHour, minute: 0, second: 0, millisecond: 0 },
    1
  );
  let due = followupZonedLocalToDate(nextLocal);
  if (due <= previousSentAt) {
    due = followupZonedLocalToDate(addFollowupLocalDays(nextLocal, 1));
  }
  return due;
}

function effectiveFollowupDueAt(customer, item, sequence = []) {
  const scheduledDueAt = followupDueAt(customer.firstSeenAt, item);
  const previousSentAt = previousFollowupSentAt(customer, item, sequence);
  if (!previousSentAt) return scheduledDueAt;
  const previousGateAt = followupDueAfterPreviousSent(previousSentAt, item);
  return scheduledDueAt > previousGateAt ? scheduledDueAt : previousGateAt;
}

function localCalendarDayDiff(start, end) {
  const startDay = followupZonedDateParts(start);
  const endDay = followupZonedDateParts(end);
  const startUtc = Date.UTC(startDay.year, startDay.month - 1, startDay.day);
  const endUtc = Date.UTC(endDay.year, endDay.month - 1, endDay.day);
  return Math.floor((endUtc - startUtc) / DAY_MS);
}

function customerAgeDays(customer, now = new Date()) {
  return localCalendarDayDiff(new Date(customer.firstSeenAt || now), now);
}

function currentFollowupStage(customer, sequence = [], now = new Date()) {
  return sequence.find((item) => {
    if (customer.followupsSent?.[item.key]) return false;
    const dueAt = effectiveFollowupDueAt(customer, item, sequence);
    if (!dueAt) return false;
    const nowLocal = followupZonedDateParts(now);
    const dueLocal = followupZonedDateParts(dueAt);
    return nowLocal.year === dueLocal.year && nowLocal.month === dueLocal.month && nowLocal.day === dueLocal.day;
  }) || null;
}

function isCurrentFollowupSendWindow(customer, item, sequence = [], now = new Date()) {
  const dueAt = effectiveFollowupDueAt(customer, item, sequence);
  if (!dueAt) return false;
  const nowLocal = followupZonedDateParts(now);
  const dueLocal = followupZonedDateParts(dueAt);
  return (
    now >= dueAt &&
    nowLocal.year === dueLocal.year &&
    nowLocal.month === dueLocal.month &&
    nowLocal.day === dueLocal.day &&
    nowLocal.hour === item.sendHour
  );
}

function isWithinCustomerServiceWindow(customer, at = new Date()) {
  const lastInbound = new Date(customer.lastInboundAt || customer.firstSeenAt || 0);
  if (Number.isNaN(lastInbound.getTime())) return false;
  return at.getTime() - lastInbound.getTime() <= DAY_MS;
}

function isOptOutMessage(text) {
  return detectOptOutIntent(text).optedOut;
}

function detectOptOutIntent(text) {
  const message = normalizeIntentText(text);
  if (!message) return { optedOut: false, uncertain: false, reason: "empty" };
  if (OPT_OUT_PATTERN.test(message)) {
    return { optedOut: true, uncertain: false, reason: "keyword_opt_out" };
  }
  if (OPT_OUT_INTENT_PATTERNS.some((pattern) => pattern.test(message))) {
    return { optedOut: true, uncertain: false, reason: "similar_meaning_opt_out" };
  }
  if (OPT_OUT_UNCERTAIN_PATTERNS.some((pattern) => pattern.test(message))) {
    return { optedOut: false, uncertain: true, reason: "possible_opt_out_or_low_interest" };
  }
  return { optedOut: false, uncertain: false, reason: "not_opt_out" };
}

function normalizeIntentText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function groupBy(items, getKey) {
  const grouped = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  return grouped;
}

async function notifyAdmin(body) {
  if (config.adminWhatsAppNumber) {
    await sendOutbound(config.adminWhatsAppNumber, [textMessage(body)], { channel: "admin" });
    return;
  }
  await store.appendOutbox({ to: "admin", channel: "admin", type: "text", body });
  console.log(`Admin notification:\n${body}`);
}

async function sendOutbound(to, messages, meta = {}) {
  const { skipFailureRecord = false, ...safeMeta } = meta;
  const prior = outboundQueues.get(to) || Promise.resolve();
  const pending = prior.catch(() => {}).then(() => sendOutboundSequence(to, messages, safeMeta));
  outboundQueues.set(to, pending);
  try {
    await pending;
  } catch (error) {
    if (!skipFailureRecord) {
      const failedMessage = await operations.recordFailedMessage({
        businessAccountId: safeMeta.businessAccountId || config.accountId,
        to,
        messages: error.unsentMessages || messages,
        meta: safeMeta,
        error: error.message,
      });
      error.failedMessageId = failedMessage.id;
      error.failedMessage = failedMessage;
    }
    await recordSystemError("outbound_message", error, `Recipient: ${to}`, safeMeta.businessAccountId || config.accountId);
    throw error;
  } finally {
    if (outboundQueues.get(to) === pending) outboundQueues.delete(to);
  }
}

async function sendOutboundSequence(to, messages, meta = {}) {
  for (const [index, message] of messages.entries()) {
    try {
      if (config.demoMode || meta.businessAccountId === DEMO_ACCOUNT_ID) {
        await store.appendOutbox({ direction: "outbound", to, ...meta, ...message });
        console.log(`Demo outbound to ${to}: ${message.type} ${message.body || message.caption || message.url || message.name}`);
        continue;
      }
      const messageId = await sendWhatsAppMessage(to, message, meta);
      if (messageId) {
        await store.appendOutbox({
          direction: "outbound",
          from: "ai_agent",
          to,
          businessAccountId: meta.businessAccountId || config.accountId,
          ...meta,
          ...message,
        });
        submittedOutboundMessages.set(messageId, {
          to,
          messages: [message],
          meta,
          businessAccountId: meta.businessAccountId || config.accountId,
          createdAt: Date.now(),
        });
      }
      if (index < messages.length - 1) {
        if (messageId && config.transportMode === "cloud") {
          const status = await waitForDeliveredMessage(messageId);
          console.log(`WhatsApp sequence gate ${status} for ${messageId}`);
        }
        if (config.messageSequenceDelayMs > 0) {
          await wait(config.messageSequenceDelayMs);
        }
      }
    } catch (error) {
      error.unsentMessages = messages.slice(index);
      throw error;
    }
  }
}

async function sendWhatsAppMessage(to, message, meta = {}) {
  if (config.transportMode === "web") {
    if (!webTransportManager) throw new Error("WhatsApp Web transport is not initialized.");
    const accountId = meta.businessAccountId || config.accountId;
    const messageId = await webTransportManager.send(accountId, to, await messageForWebTransport(message, accountId));
    console.log(`Sent WhatsApp Web ${message.type} to ${to}`);
    return messageId || `web_${Date.now()}`;
  }

  const image = message.type === "image" ? { link: resolveMediaUrl(message.url, "Image") } : null;
  if (image && message.caption) image.caption = message.caption;
  const video = message.type === "video" ? { link: resolveMediaUrl(message.url, "Video") } : null;
  if (video && message.caption) video.caption = message.caption;
  const payload =
    message.type === "image"
      ? {
          messaging_product: "whatsapp",
          to,
          type: "image",
          image,
        }
      : message.type === "video"
      ? {
          messaging_product: "whatsapp",
          to,
          type: "video",
          video,
        }
      : message.type === "template"
      ? {
          messaging_product: "whatsapp",
          to,
          type: "template",
          template: {
            name: message.name,
            language: { code: message.languageCode || FOLLOWUP_TEMPLATE_LANGUAGE },
            ...(Array.isArray(message.components) && message.components.length
              ? { components: message.components }
              : {}),
          },
        }
      : {
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { preview_url: false, body: message.body },
        };

  const teamSettings = meta.businessAccountId
    ? await adminAccounts.getTeamSettings(meta.businessAccountId)
    : {};
  const phoneNumberId = teamSettings.whatsappPhoneNumberId || config.phoneNumberId;
  const accessToken = teamSettings.whatsappAccessToken || config.accessToken;
  if (!phoneNumberId || !accessToken) {
    throw new Error(`Missing WhatsApp Cloud API credentials for account ${meta.businessAccountId || config.accountId}.`);
  }

  const response = await fetch(
    `https://graph.facebook.com/${config.graphVersion}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`WhatsApp send failed: ${text}`);
  }
  const data = text ? JSON.parse(text) : {};
  console.log(`Sent WhatsApp ${message.type} to ${to}`);
  return data.messages?.[0]?.id || "";
}

async function messageForWebTransport(message = {}, accountId = config.accountId) {
  if (message.type !== "image" && message.type !== "video") return message;
  return {
    ...message,
    url: await resolveWebMediaPath(message.url, accountId),
  };
}

function localAssetPath(url = "") {
  const value = String(url || "");
  if (value.startsWith("/assets/")) {
    const relativePath = decodeURIComponent(value.split("?")[0].slice("/assets/".length));
    const filePath = path.resolve(config.assetsDir, relativePath);
    const root = `${config.assetsDir}${path.sep}`.toLowerCase();
    if (!filePath.toLowerCase().startsWith(root)) {
      throw new Error(`Forbidden asset path: ${value}`);
    }
    return filePath;
  }
  return "";
}

function isPersistedAssetUrl(url = "") {
  return String(url || "").startsWith("/persisted-assets/");
}

function localAssetExists(url = "") {
  if (isPersistedAssetUrl(url)) return true;
  const filePath = localAssetPath(url);
  return !filePath || existsSync(filePath);
}

async function resolveWebMediaPath(url = "", accountId = config.accountId) {
  const value = String(url || "");
  if (/^https?:\/\//i.test(value)) return value;
  if (isPersistedAssetUrl(value)) {
    const filePath = await materializePersistedAsset(value, accountId);
    if (filePath) return filePath;
  }
  const filePath = localAssetPath(value);
  if (filePath) return filePath;
  return value;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForDeliveredMessage(messageId) {
  cleanupDeliveryTracking();
  if (deliveredOutboundMessages.has(messageId)) return Promise.resolve("delivered");

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      outboundDeliveryWaiters.delete(messageId);
      resolve("timeout");
    }, config.deliveryWaitTimeoutMs);
    outboundDeliveryWaiters.set(messageId, {
      resolve(status) {
        clearTimeout(timer);
        outboundDeliveryWaiters.delete(messageId);
        resolve(status);
      },
    });
  });
}

function noteOutboundStatus(status) {
  const messageId = String(status.id || "");
  if (!messageId) return;
  if (status.status === "delivered" || status.status === "read") {
    deliveredOutboundMessages.set(messageId, Date.now());
    outboundDeliveryWaiters.get(messageId)?.resolve(status.status);
    submittedOutboundMessages.delete(messageId);
  } else if (status.status === "failed") {
    outboundDeliveryWaiters.get(messageId)?.resolve("failed");
    const submitted = submittedOutboundMessages.get(messageId);
    if (submitted) {
      const statusError = status.errors?.[0]?.title || status.errors?.[0]?.message || "Meta delivery failed";
      void operations.recordFailedMessage({ ...submitted, error: statusError });
      void recordSystemError("message_delivery_status", new Error(statusError), `Message ID: ${messageId}`, submitted.businessAccountId);
      submittedOutboundMessages.delete(messageId);
    }
  }
  cleanupDeliveryTracking();
}

function cleanupDeliveryTracking() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [messageId, timestamp] of deliveredOutboundMessages) {
    if (timestamp < cutoff) deliveredOutboundMessages.delete(messageId);
  }
  for (const [messageId, submitted] of submittedOutboundMessages) {
    if (submitted.createdAt < cutoff) submittedOutboundMessages.delete(messageId);
  }
}

function extractInboundMessages(payload) {
  const messages = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const message of value.messages || []) {
        messages.push({
          ...message,
          phoneNumberId: value.metadata?.phone_number_id || "",
          displayPhoneNumber: value.metadata?.display_phone_number || "",
        });
      }
    }
  }
  return messages;
}

function extractOutboundStatuses(payload) {
  const statuses = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      for (const status of change.value?.statuses || []) {
        statuses.push(status);
      }
    }
  }
  return statuses;
}

function extractMessageSource(message) {
  const referral = message.referral || {};
  return {
    sourceUrl: referral.source_url || "",
    sourceType: referral.source_type || "",
    adId: referral.source_id || referral.ctwa_clid || "",
    referralHeadline: referral.headline || "",
    referralBody: referral.body || "",
    mediaType: referral.media_type || "",
    imageUrl: referral.image_url || "",
    videoUrl: referral.video_url || "",
  };
}

function getMessageText(message) {
  if (message.type === "text") {
    return message.text?.body?.trim();
  }
  if (message.type === "interactive") {
    return (
      message.interactive?.button_reply?.title ||
      message.interactive?.list_reply?.title ||
      message.interactive?.button_reply?.id ||
      message.interactive?.list_reply?.id ||
      ""
    ).trim();
  }
  if (message.type === "button") {
    return (message.button?.text || message.button?.payload || "").trim();
  }
  return "";
}

function inboundWebhookMediaType(message = {}) {
  const type = String(message.type || "").toLowerCase();
  if (type === "audio" || type === "voice") return "audio";
  if (type === "image") return "image";
  if (type === "video") return "video";
  return type || "media";
}

function isValidSignature(headers, rawBody) {
  if (config.demoMode || !config.appSecret) return true;

  const signature = headers["x-hub-signature-256"];
  if (!signature || !signature.startsWith("sha256=")) return false;

  const expected = crypto.createHmac("sha256", config.appSecret).update(rawBody).digest("hex");
  const actual = signature.slice("sha256=".length);

  return timingSafeEqual(actual, expected);
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function alreadyProcessed(messageId) {
  if (!messageId) return false;
  cleanupProcessedMessages();
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.set(messageId, Date.now());
  return false;
}

function cleanupProcessedMessages() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [messageId, timestamp] of processedMessageIds) {
    if (timestamp < cutoff) processedMessageIds.delete(messageId);
  }
}

function orderDetailBufferKey(businessAccountId, customerId) {
  return `${businessAccountId || config.accountId}::${customerId}`;
}

function shouldBufferMergedCustomerMessage(text) {
  const delayMs = Math.max(0, Number(config.messageMergeBufferMs) || 0);
  return delayMs > 0 && Boolean(String(text || "").trim());
}

function bufferMergedCustomerMessage(args, customer) {
  const delayMs = Math.max(0, Number(config.messageMergeBufferMs) || 0);
  const key = orderDetailBufferKey(args.businessAccountId, args.from);
  const existing = pendingMessageMergeBuffers.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  const messages = [...(existing?.messages || []), String(args.text || "").trim()].filter(Boolean);
  const sources = [...(existing?.sources || []), args.source || {}];
  const timer = setTimeout(() => {
    pendingMessageMergeBuffers.delete(key);
    const combinedText = messages.join("\n");
    const combinedSource = sources.reduce((merged, source) => ({ ...merged, ...source }), {});
    void processInboundMessage({
      ...args,
      id: "",
      text: combinedText,
      source: combinedSource,
      skipMessageMergeBuffer: true,
      skipInboundRecord: true,
    }).catch((error) => recordSystemError("message_merge_buffer_flush", error, `${args.from}: ${combinedText}`, args.businessAccountId));
  }, delayMs);
  pendingMessageMergeBuffers.set(key, { timer, messages, sources });
  console.log(`Buffering customer message merge from ${args.from} for ${delayMs}ms (${messages.length} fragment(s)).`);
  return {
    customer,
    order: null,
    messages: [],
    handoffRequired: false,
    handoffReason: "Customer message merge buffered.",
  };
}

function anotherDatePurchaseCustomerPatch(text, now = new Date()) {
  const plannedDate = extractPlannedPurchaseDate(text, now);
  return {
    anotherDatePurchaseAt: now.toISOString(),
    anotherDatePurchaseText: String(text || "").trim(),
    anotherDatePurchaseDate: plannedDate ? plannedDate.toISOString() : "",
    plannedPurchaseDate: plannedDate ? plannedDate.toISOString() : "",
  };
}

function extractPlannedPurchaseDate(text, now = new Date()) {
  const body = String(text || "").toLowerCase();
  const numeric = body.match(/\b([0-3]?\d)\s*[\/.-]\s*([01]?\d)(?:\s*[\/.-]\s*(\d{2,4}))?\b/);
  if (numeric) {
    return localPlannedDate(Number(numeric[1]), Number(numeric[2]), numeric[3] ? normalizeYear(Number(numeric[3])) : null, now);
  }
  const monthNames = {
    jan: 1, january: 1, januari: 1,
    feb: 2, february: 2, februari: 2,
    mar: 3, march: 3, mac: 3,
    apr: 4, april: 4,
    may: 5, mei: 5,
    jun: 6, june: 6, juni: 6,
    jul: 7, july: 7, julai: 7,
    aug: 8, august: 8, ogos: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10, oktober: 10,
    nov: 11, november: 11,
    dec: 12, december: 12, disember: 12,
  };
  const monthMatch = body.match(/\b([0-3]?\d)\s*(jan(?:uary|uari)?|feb(?:ruary|ruari)?|mar(?:ch)?|mac|apr(?:il)?|may|mei|jun(?:e|i)?|jul(?:y|ai)?|aug(?:ust)?|ogos|sep(?:t|tember)?|oct(?:ober)?|oktober|nov(?:ember)?|dec(?:ember)?|disember)\b/);
  if (monthMatch) {
    const month = monthNames[monthMatch[2]];
    return localPlannedDate(Number(monthMatch[1]), month, null, now);
  }
  if (/\b(tomorrow|esok|bisuk)\b/.test(body)) {
    return localDateAtSendHour(addFollowupLocalDays(followupZonedDateParts(now), 1), 20);
  }
  if (/\b(next\s*week|minggu\s*depan)\b/.test(body)) {
    return localDateAtSendHour(addFollowupLocalDays(followupZonedDateParts(now), 7), 20);
  }
  if (/\b(next\s*month|bulan\s*depan)\b/.test(body)) {
    const parts = followupZonedDateParts(now);
    return localDateAtSendHour({ ...parts, month: parts.month + 1 }, 20);
  }
  return null;
}

function localPlannedDate(day, month, year, now = new Date()) {
  if (!Number.isFinite(day) || !Number.isFinite(month) || day < 1 || day > 31 || month < 1 || month > 12) return null;
  const nowParts = followupZonedDateParts(now);
  let candidate = localDateAtSendHour({ year: year || nowParts.year, month, day }, 20);
  if (!year && candidate < now) {
    candidate = localDateAtSendHour({ year: nowParts.year + 1, month, day }, 20);
  }
  return candidate;
}

function localDateAtSendHour(parts, sendHour) {
  return followupZonedLocalToDate({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: sendHour,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
}

function normalizeYear(year) {
  if (!Number.isFinite(year)) return null;
  return year < 100 ? 2000 + year : year;
}

function shouldBufferIncompleteOrderDetails(customer, text, product) {
  if (customer?.pendingOrder) return false;
  const delayMs = Math.max(0, Number(config.orderDetailBufferMs) || 0);
  if (!delayMs) return false;
  const body = String(text || "").trim();
  if (!body) return false;
  if (/[?？]\s*$/.test(body)) return false;
  if (/^(ada|berapa|can|boleh|do|does|is|are|kenapa|apa|macam mana|how|why|what)\b/i.test(body)) return false;
  const draft = extractOrderDetails(body, product);
  return Boolean(draft.hasAnyDetails && !draft.isComplete && hasStrongPartialOrderEvidence(body, draft));
}

function hasStrongPartialOrderEvidence(text, draft = {}) {
  const body = String(text || "").trim();
  const normalized = body.toLowerCase();
  if (!body) return false;
  const hasLabelledOrderField = /\b(full\s*name|nama|name|full\s*address|alamat|address|phone\s*number|phone|contact|nombor|number|order\s*option|pilihan|package|pakej|paket|pkg)\s*[:：]/i.test(body);
  if (hasLabelledOrderField) return true;
  const phoneMatches = body.match(/\+?\d[\d\s-]{5,}\d/g) || [];
  const hasLikelyPhone = phoneMatches.some((value) => value.replace(/\D/g, "").length >= 7);
  const hasAddressCue = /\b(spg|simpang|jalan|jln|kg|kampung|rumah|house|no\.?|unit|block|blok|lot|mukim|bandar|kb|tutong|temburong|brunei|muara|mentiri|mumong)\b/i.test(body);
  const hasClearOrderIntent = /\b(nak|mau|mahu|want|ambil|order|beli|buy|confirm|lock|proceed|jadi|book|booking)\b/i.test(body);
  const hasExplicitOrderOption =
    Boolean(draft.orderOptionId || draft.orderOptionChoice || draft.addOnChoice || draft.packageId) &&
    /\b(package|pakej|paket|pkg|option|pilihan|order|ambil|mau|nak|beli|buy)\b/i.test(normalized);
  if (hasLikelyPhone && (hasAddressCue || hasClearOrderIntent || hasExplicitOrderOption)) return true;
  if (hasAddressCue && hasClearOrderIntent) return true;
  if (hasExplicitOrderOption && hasClearOrderIntent) return true;
  return false;
}

function bufferIncompleteOrderDetails(args, customer, product) {
  const delayMs = Math.max(0, Number(config.orderDetailBufferMs) || 0);
  const key = orderDetailBufferKey(args.businessAccountId, args.from);
  const existing = pendingOrderDetailBuffers.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  const messages = [...(existing?.messages || []), String(args.text || "").trim()].filter(Boolean);
  const sources = [...(existing?.sources || []), args.source || {}];
  const timer = setTimeout(() => {
    pendingOrderDetailBuffers.delete(key);
    const combinedText = messages.join("\n");
    const combinedSource = sources.reduce((merged, source) => ({ ...merged, ...source }), {});
    void processInboundMessage({
      ...args,
      id: "",
      text: combinedText,
      source: combinedSource,
      skipOrderDetailBuffer: true,
      skipMessageMergeBuffer: true,
      skipInboundRecord: true,
    }).catch((error) => recordSystemError("order_detail_buffer_flush", error, `${args.from}: ${combinedText}`, args.businessAccountId));
  }, delayMs);
  pendingOrderDetailBuffers.set(key, { timer, messages, sources, productId: product?.id || "" });
  console.log(`Buffering partial order details from ${args.from} for ${delayMs}ms (${messages.length} fragment(s)).`);
  return {
    customer,
    order: null,
    messages: [],
    handoffRequired: false,
    handoffReason: "Partial order details buffered.",
  };
}

function clampMessages(messages = []) {
  return messages
    .filter((message) => {
      if (message.type !== "image") return true;
      const url = String(message.url || "").trim();
      if (!url) return false;
      if (!localAssetExists(url)) {
        console.warn(`Skipping missing local image in outbound sequence: ${url}`);
        return false;
      }
      return true;
    })
    .map((message) => {
      if (message.type !== "text") return message;
      return { ...message, body: String(message.body || "").slice(0, config.maxReplyChars) };
    });
}

async function readJsonBody(req) {
  const body = await readBody(req);
  return body.length ? JSON.parse(body.toString("utf8")) : {};
}

async function readFormBody(req) {
  const body = await readBody(req);
  return new URLSearchParams(body.toString("utf8"));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "text/plain" });
  res.end(body);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
  );
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function sendJsonDownload(res, filename, body) {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendHtml(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

async function sendQrSvg(res, accountId) {
  const qr = webTransportManager?.getStatus(accountId).qr || "";
  if (!qr) return sendText(res, 404, "QR not available");
  try {
    const QRCode = await import("qrcode");
    const svg = await QRCode.toString(qr, {
      type: "svg",
      margin: 4,
      width: 640,
    });
    res.writeHead(200, {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "no-store",
    });
    res.end(svg);
  } catch (error) {
    await recordSystemError("qr_render", error);
    return sendText(res, 500, "QR render failed");
  }
}

function whatsappWebQrOnlyHtml(accountId = "") {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WhatsApp Web QR</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Arial, sans-serif; background: #f8fafc; color: #111827; }
    main { text-align: center; padding: 22px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p { color: #6b7280; margin: 8px 0 18px; }
    img { display: block; width: min(640px, calc(100vw - 44px)); height: auto; background: #fff; border: 1px solid #d8dee4; border-radius: 18px; padding: 18px; box-shadow: 0 12px 30px rgba(15,23,42,.12); }
    a, button { display: inline-block; margin-top: 16px; border: 1px solid #cfd4dc; background: #fff; border-radius: 10px; padding: 11px 14px; color: #111827; text-decoration: none; font-weight: 700; font-size: 15px; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Scan This QR</h1>
    <p><strong>Account:</strong> ${escapeHtml(accountId)}</p>
    <p>Use the main WhatsApp Business phone: Settings &gt; Linked Devices &gt; Link a Device.</p>
    <img id="qr" src="/admin/whatsapp-web/qr.svg?t=${Date.now()}" alt="WhatsApp Web QR code">
    <div>
      <button type="button" onclick="refreshQr()">Refresh QR</button>
      <a href="/admin/whatsapp-web">Back to Connector</a>
    </div>
  </main>
  <script>
    function refreshQr() {
      document.querySelector("#qr").src = "/admin/whatsapp-web/qr.svg?t=" + Date.now();
    }
    setInterval(refreshQr, 20000);
  </script>
</body>
</html>`;
}

export { config, requestFollowupRun, sendCustomerFollowupNow };
function publicPrivacyHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Privacy Policy | ${escapeHtml(config.businessName)}</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 860px; margin: 40px auto; padding: 0 20px; color: #1f2328; line-height: 1.55; }
    h1 { font-size: 32px; margin-bottom: 8px; }
    h2 { margin-top: 28px; font-size: 22px; }
    p, li { font-size: 16px; }
    .muted { color: #6b7280; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p class="muted">Last updated: ${escapeHtml(new Date().toISOString().slice(0, 10))}</p>
  <p>${escapeHtml(config.businessName)} uses WhatsApp to answer customer enquiries, provide product support, process orders, arrange delivery, and send approved follow-up messages.</p>

  <h2>Information We Collect</h2>
  <ul>
    <li>WhatsApp phone number and profile name.</li>
    <li>Messages you send to us, including enquiries, order details, delivery address, and support requests.</li>
    <li>Product, package, order status, and conversation history needed to serve you.</li>
  </ul>

  <h2>How We Use Information</h2>
  <ul>
    <li>To reply to your WhatsApp messages.</li>
    <li>To process and update customer orders.</li>
    <li>To arrange delivery and customer support.</li>
    <li>To improve our product replies and service quality.</li>
  </ul>

  <h2>Sharing</h2>
  <p>We do not sell customer personal data. We may share necessary order and delivery details with staff, delivery partners, or service providers only when needed to complete your request.</p>

  <h2>Retention</h2>
  <p>We keep customer conversation and order records only as long as needed for business, support, dispute handling, legal, or accounting purposes.</p>

  <h2>Your Choices</h2>
  <p>You may reply <strong>stop</strong> on WhatsApp to opt out of follow-up messages. You may also request deletion of your data using the data deletion page.</p>

  <h2>Contact</h2>
  <p>For privacy questions, contact us through our official WhatsApp business number.</p>
</body>
</html>`;
}

function publicDataDeletionHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Data Deletion | ${escapeHtml(config.businessName)}</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 860px; margin: 40px auto; padding: 0 20px; color: #1f2328; line-height: 1.55; }
    h1 { font-size: 32px; margin-bottom: 8px; }
    h2 { margin-top: 28px; font-size: 22px; }
    p, li { font-size: 16px; }
    .card { border: 1px solid #d8dee4; border-radius: 12px; padding: 18px; background: #f6f8fa; }
  </style>
</head>
<body>
  <h1>Data Deletion Instructions</h1>
  <p>If you want ${escapeHtml(config.businessName)} to delete your WhatsApp customer data, please contact us through our official WhatsApp business number.</p>

  <div class="card">
    <h2>How To Request Deletion</h2>
    <ol>
      <li>Send a WhatsApp message to our business number.</li>
      <li>Write: <strong>Delete my data</strong>.</li>
      <li>Include the WhatsApp number you used to contact us.</li>
    </ol>
  </div>

  <h2>What We Delete</h2>
  <p>We will delete or anonymise customer conversation records, support notes, and order enquiry records linked to your WhatsApp number, unless we are required to keep certain records for legal, accounting, dispute, fraud prevention, or compliance reasons.</p>

  <h2>Processing Time</h2>
  <p>We aim to process deletion requests within a reasonable time after verifying the request.</p>
</body>
</html>`;
}

function whatsappWebStatusHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WhatsApp Web Connector</title>
  <style>
    :root { --accent: #0b7cff; --line: #d2d2d7; --muted: #6e6e73; --bg: #f5f5f7; --surface: #ffffff; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Arial, sans-serif; color: #1d1d1f; background: var(--bg); }
    header { padding: 16px 22px 10px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); backdrop-filter: saturate(180%) blur(16px); }
    h1 { margin: 0; font-size: 20px; }
    header .muted { margin-top: 4px; min-height: 18px; font-size: 13px; }
    nav { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 22px 14px; border-bottom: 1px solid rgba(210,210,215,.8); background: rgba(251,251,253,.9); backdrop-filter: saturate(180%) blur(16px); }
    nav a, nav button { border: 1px solid var(--line); background: var(--surface); border-radius: 8px; padding: 8px 11px; color: #1d1d1f; text-decoration: none; font: inherit; font-weight: 600; cursor: pointer; }
    .card { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 18px; max-width: 760px; box-shadow: 0 1px 3px rgba(0,0,0,.05); }
    .status { display: inline-block; border-radius: 999px; padding: 6px 10px; font-weight: 700; background: #f1f5f9; }
    .connected { color: #176f37; background: #dcfce7; }
    .qr_required, .starting { color: #8a5a00; background: #fef3c7; }
    .error, .disconnected { color: #9f1c1c; background: #fee2e2; }
    .diagnostics { margin-top: 16px; border-top: 1px solid var(--line); padding-top: 14px; }
    .diagnostics table { border-collapse: collapse; width: 100%; margin-top: 8px; }
    .diagnostics td { border-bottom: 1px solid #edf0f3; padding: 8px 4px; vertical-align: top; }
    .diagnostics td:first-child { color: var(--muted); width: 190px; }
    .warning { display: none; margin-top: 12px; border: 1px solid #facc15; background: #fef9c3; color: #713f12; border-radius: 8px; padding: 10px 12px; }
    #qr { display: none; margin-top: 16px; width: min(520px, calc(100vw - 96px)); height: auto; border: 1px solid var(--line); border-radius: 12px; background: #fff; padding: 14px; }
    .pairing { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--line); }
    .pairing-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .pairing input { border: 1px solid #cfd4dc; border-radius: 8px; padding: 10px 12px; min-width: 260px; font: inherit; }
    .pairing button { border: 0; border-radius: 8px; padding: 11px 14px; background: var(--accent); color: #fff; font-weight: 700; cursor: pointer; }
    .pairing-code { display: none; margin-top: 14px; font-size: 30px; font-weight: 800; letter-spacing: 3px; }
    .danger { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--line); }
    .danger button { border: 1px solid #fecaca; border-radius: 8px; padding: 11px 14px; background: #fee2e2; color: #991b1b; font-weight: 800; cursor: pointer; }
    main { padding: 22px; }
    .muted { color: var(--muted); }
    code { background: #f1f5f9; padding: 2px 5px; border-radius: 5px; }
  </style>
</head>
<body>
  <header>
    <h1>WhatsApp Web Connector</h1>
    <p class="muted">Use this only when <code>WHATSAPP_TRANSPORT=web</code>. Scan the QR with the WhatsApp Business phone.</p>
  </header>
  <nav>
    <a href="/admin/dashboard">Dashboard</a>
    <a href="/admin/chat">Chat Inbox</a>
    <a href="/admin/whatsapp-web">WhatsApp Web</a>
    <a href="/admin/analytics">Analytics</a>
    <a href="/admin/reply-library">Reply Library</a>
    <a href="/admin/product-flow">Product Flow</a>
    <a href="/admin/follow-up-settings">Follow-Up Settings</a>
    <a href="/admin/compliance">Compliance</a>
    <a href="/demo/chat">Customer Demo</a>
    <button id="refresh" type="button">Refresh</button>
    <a href="/admin/dashboard?tab=profile">Profile</a>
  </nav>
  <main>
    <section class="card">
      <h2>Connection Status</h2>
      <p id="account" class="muted"></p>
      <p>Status: <span id="status" class="status">Loading...</span></p>
      <p id="details" class="muted"></p>
      <img id="qr" alt="WhatsApp Web QR code">
      <p class="muted">If QR is shown: open WhatsApp Business on the main phone, go to Linked devices, then scan this QR.</p>
      <p><a href="/admin/whatsapp-web/qr-only" target="_blank" rel="noopener">Open large QR scan page</a></p>
      <div id="from-me-warning" class="warning"></div>
      <div class="diagnostics">
        <h2>Message Diagnostics</h2>
        <p class="muted">Use this after sending a test WhatsApp message. Customer messages should increase processed messages.</p>
        <table>
          <tbody id="diagnostics"></tbody>
        </table>
      </div>
      <div class="pairing">
        <h2>Alternative: Pairing Code</h2>
        <p class="muted">If QR keeps expiring, enter the WhatsApp Business number and use the code in WhatsApp Business &gt; Linked devices &gt; Link with phone number instead.</p>
        <div class="pairing-row">
          <input id="phone" type="text" placeholder="e.g. 6737504957">
          <button id="pair" type="button">Get Pairing Code</button>
        </div>
        <div id="pairing-code" class="pairing-code"></div>
        <p id="pairing-state" class="muted"></p>
      </div>
      <div class="danger">
        <h2>Disconnect Current WhatsApp</h2>
        <p class="muted">Use this before connecting a different WhatsApp Business number. It logs out the current linked session and clears the saved QR session.</p>
        <button id="disconnect" type="button">Disconnect WhatsApp</button>
        <p id="disconnect-state" class="muted"></p>
      </div>
    </section>
  </main>
  <script>
    let lastQr = "";
    async function loadStatus() {
      const response = await fetch("/admin/whatsapp-web/status", { cache: "no-store" });
      const data = await response.json();
      const status = document.querySelector("#status");
      const qr = document.querySelector("#qr");
      document.querySelector("#account").textContent = data.accountId ? "Business account: " + data.accountId : "";
      status.textContent = data.status || "unknown";
      status.className = "status " + (data.status || "");
      document.querySelector("#details").textContent =
        "Transport: " + (data.transportMode || data.transport || "") +
        " | Demo mode: " + (data.demoMode ? "on" : "off") +
        " | Process linked-phone messages: " + (data.processFromMeMessages ? "on" : "off") +
        (data.lastConnectedAt ? " | Connected: " + new Date(data.lastConnectedAt).toLocaleString() : "") +
        (data.lastDisconnectedAt ? " | Disconnected: " + new Date(data.lastDisconnectedAt).toLocaleString() : "") +
        (data.lastError ? " | Error: " + data.lastError : "");
      if (data.qr) {
        qr.style.display = "block";
        if (data.qr !== lastQr) {
          lastQr = data.qr;
          qr.src = "/admin/whatsapp-web/qr.svg?t=" + Date.now();
        }
      } else {
        lastQr = "";
        qr.style.display = "none";
        qr.removeAttribute("src");
      }
      if (data.pairingCode) {
        const codeEl = document.querySelector("#pairing-code");
        codeEl.style.display = "block";
        codeEl.textContent = data.pairingCode;
      }
      renderDiagnostics(data.diagnostics || {});
    }
    function renderDiagnostics(diagnostics) {
      const rows = [
        ["Received events", diagnostics.receivedEvents || 0],
        ["Received messages", diagnostics.receivedMessages || 0],
        ["Processed messages", diagnostics.processedMessages || 0],
        ["Ignored from linked phone", diagnostics.ignoredFromMe || 0],
        ["Ignored non-customer chat", diagnostics.ignoredNonCustomer || 0],
        ["Ignored empty text", diagnostics.ignoredEmptyText || 0],
        ["Last ignore reason", diagnostics.lastIgnoreReason || "-"],
        ["Last message kinds", diagnostics.lastMessageKinds || "-"],
        ["Last customer id", diagnostics.lastCustomerId || "-"],
        ["Last message preview", diagnostics.lastTextPreview || "-"],
        ["Last event time", diagnostics.lastAt ? new Date(diagnostics.lastAt).toLocaleString() : "-"]
      ];
      document.querySelector("#diagnostics").innerHTML = rows.map(([label, value]) =>
        "<tr><td>" + esc(label) + "</td><td>" + esc(String(value)) + "</td></tr>"
      ).join("");
      const warning = document.querySelector("#from-me-warning");
      if (diagnostics.lastIgnoreReason === "from_me") {
        warning.style.display = "block";
        warning.textContent = "Last message was ignored because it was sent from the linked WhatsApp phone. Test from a different customer phone/WhatsApp account, or enable WHATSAPP_WEB_PROCESS_FROM_ME=true only for local self-testing.";
      } else {
        warning.style.display = "none";
        warning.textContent = "";
      }
    }
    function esc(value) {
      return String(value || "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }
    async function requestPairingCode() {
      const state = document.querySelector("#pairing-state");
      const codeEl = document.querySelector("#pairing-code");
      state.textContent = "Requesting pairing code...";
      codeEl.style.display = "none";
      codeEl.textContent = "";
      const response = await fetch("/admin/whatsapp-web/pairing-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: document.querySelector("#phone").value })
      });
      const data = await response.json();
      if (!response.ok) {
        state.textContent = data.error || "Could not request pairing code.";
        return;
      }
      codeEl.style.display = "block";
      codeEl.textContent = data.code;
      state.textContent = "Enter this code in WhatsApp Business linked device pairing.";
      loadStatus();
    }
    async function disconnectWhatsApp() {
      if (!confirm("Disconnect the current WhatsApp Web session? You will need to scan QR again.")) return;
      const state = document.querySelector("#disconnect-state");
      state.textContent = "Disconnecting...";
      const response = await fetch("/admin/whatsapp-web/disconnect", { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        state.textContent = data.error || "Could not disconnect WhatsApp.";
        return;
      }
      state.textContent = "Disconnected. A fresh QR session is starting; scan the new QR with the new phone.";
      loadStatus();
    }
    document.querySelector("#refresh").addEventListener("click", loadStatus);
    document.querySelector("#pair").addEventListener("click", requestPairingCode);
    document.querySelector("#disconnect").addEventListener("click", disconnectWhatsApp);
    loadStatus();
    setInterval(loadStatus, 5000);
  </script>
</body>
</html>`;
}

function redirectToLogin(res, next) {
  res.writeHead(303, { Location: `/admin/login?next=${encodeURIComponent(next)}` });
  res.end();
}

function redirectToSuperAdminLogin(res) {
  res.writeHead(303, { Location: "/superadmin/login" });
  res.end();
}

function redirectToOrderAdminLogin(res) {
  res.writeHead(303, { Location: "/order-admin/login" });
  res.end();
}

function isLocalRequest(req) {
  const address = req.socket?.remoteAddress || "";
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}

function sendLoginSession(res, next, account) {
  const token = createSessionToken({ actor: `admin:${account.id}`, role: "admin", accountId: account.id });
  res.writeHead(303, {
    Location: next.startsWith("/admin/") ? next : "/admin/dashboard",
    "Set-Cookie": `wa_admin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${8 * 60 * 60}`,
  });
  res.end();
}

function sendSuperAdminSession(res) {
  const token = createSessionToken({ actor: "super_admin", role: "superadmin" });
  res.writeHead(303, {
    Location: "/superadmin/accounts",
    "Set-Cookie": `wa_superadmin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${8 * 60 * 60}`,
  });
  res.end();
}

function sendOrderAdminSession(res, account) {
  const token = createSessionToken({ actor: `order_admin:${account.id}`, role: "order_admin", accountId: account.id });
  res.writeHead(303, {
    Location: "/order-admin/dashboard",
    "Set-Cookie": `wa_order_admin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${8 * 60 * 60}`,
  });
  res.end();
}

function createSessionToken(subject) {
  const payload = Buffer.from(
    JSON.stringify({ ...subject, exp: Date.now() + 8 * 60 * 60 * 1000 })
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", config.adminSessionSecret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

async function isAdminAuthenticated(req) {
  const token = parseCookies(req.headers.cookie || "").wa_admin;
  const data = readSessionToken(token);
  if (!data || Number(data.exp || 0) <= Date.now() || !["admin", undefined].includes(data.role)) return false;
  return adminAccounts.isActive(data.accountId || config.accountId, "business_admin");
}

function isSuperAdminAuthenticated(req) {
  const data = readSessionToken(parseCookies(req.headers.cookie || "").wa_superadmin);
  return Boolean(data && data.role === "superadmin" && Number(data.exp || 0) > Date.now());
}

async function isOrderAdminAuthenticated(req) {
  const data = readSessionToken(parseCookies(req.headers.cookie || "").wa_order_admin);
  return Boolean(
    data &&
    data.role === "order_admin" &&
    Number(data.exp || 0) > Date.now() &&
    (await adminAccounts.isActive(data.accountId, "order_admin"))
  );
}

function readSessionToken(token) {
  if (!token || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  const expected = crypto.createHmac("sha256", config.adminSessionSecret).update(payload).digest("base64url");
  if (!timingSafeTextEqual(signature, expected)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) cookies[key] = rest.join("=");
  }
  return cookies;
}

function timingSafeTextEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function handleAsset(url, res) {
  const relativePath = decodeURIComponent(url.pathname.slice("/assets/".length));
  const filePath = path.resolve(config.assetsDir, relativePath);
  const root = `${config.assetsDir}${path.sep}`.toLowerCase();
  if (!filePath.toLowerCase().startsWith(root)) {
    return sendText(res, 403, "Forbidden");
  }

  try {
    const bytes = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": "public, max-age=3600",
    });
    res.end(bytes);
  } catch (error) {
    if (error.code === "ENOENT") return sendText(res, 404, "Asset not found");
    throw error;
  }
}

async function handlePersistedAsset(url, res) {
  const asset = await persistedAssetFromUrl(url.pathname);
  if (!asset) return sendText(res, 404, "Asset not found");
  res.writeHead(200, {
    "Content-Type": asset.mimeType,
    "Cache-Control": "public, max-age=3600",
  });
  res.end(asset.bytes);
}

function resolveMediaUrl(url, label = "Media") {
  if (/^https?:\/\//i.test(url)) return url;
  if (config.publicBaseUrl) return new URL(url, config.publicBaseUrl).toString();
  throw new Error(`${label} messages need PUBLIC_BASE_URL when DEMO_MODE=false.`);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  return "application/octet-stream";
}

function normalizePath(value) {
  return value.startsWith("/") ? value : `/${value}`;
}

function parseBool(value) {
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function usableEnv(name) {
  const value = process.env[name];
  if (!value || value.startsWith("replace_")) return "";
  return value;
}

function usableSecretEnv(name) {
  const value = String(process.env[name] || "");
  if (!value || /^(replace_|change_me)/i.test(value)) return "";
  return value;
}

async function liveAutomationBlock(businessAccountId = config.accountId) {
  const account = await adminAccounts.getAccount(businessAccountId);
  if (account?.automationPaused) {
    return { code: "automation_paused", message: "AI automation paused by super admin." };
  }
  if (account?.testMode) {
    return { code: "test_mode", message: "Account is in test mode; live AI reply suppressed." };
  }
  return null;
}

async function businessAccountIdForPhoneNumber(phoneNumberId) {
  const account = await adminAccounts.findBusinessAccountByPhoneNumberId(phoneNumberId);
  return account?.id || config.accountId;
}

async function businessAdminAccounts() {
  return (await adminAccounts.listAccounts()).filter((account) => (account.role || "business_admin") === "business_admin");
}

async function webTransportStatusForAccount(accountId) {
  if (!webTransportManager) {
    return {
      transport: config.transportMode,
      accountId,
      processFromMeMessages: config.webProcessFromMeMessages,
      demoMode: config.demoMode,
      status: config.transportMode === "web" ? "not_initialized" : "disabled",
      qr: "",
    };
  }
  await webTransportManager.startAccount(accountId);
  return {
    ...webTransportManager.getStatus(accountId),
    demoMode: config.demoMode,
    transportMode: config.transportMode,
  };
}

async function webTransportHealthData() {
  if (!webTransportManager) return null;
  const accounts = await businessAdminAccounts();
  return {
    transport: "web",
    accounts: webTransportManager.listStatuses(accounts.map((account) => account.id)),
  };
}

async function vectorStoreIdForAccount(businessAccountId = config.accountId) {
  const settings = await adminAccounts.getTeamSettings(businessAccountId);
  return settings.openaiVectorStoreId || config.vectorStoreId;
}

async function openAiApiKeyForAccount(businessAccountId = config.accountId) {
  const settings = await adminAccounts.getTeamSettings(businessAccountId);
  return settings.openaiApiKey || config.openaiApiKey;
}

async function openAiModelForAccount(businessAccountId = config.accountId) {
  const settings = await adminAccounts.getTeamSettings(businessAccountId);
  return settings.openaiModel || config.openaiModel;
}

function runTeamKnowledgeIngest(accountId) {
  const scriptPath = path.join(__dirname, "ingest_knowledge.mjs");
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [scriptPath, "--account-id", accountId],
      {
        cwd: __dirname,
        env: process.env,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10 * 60 * 1000,
      },
      (error, stdout = "", stderr = "") => {
        const output = `${stdout}\n${stderr}`.trim();
        if (error) {
          const cleanupMessage = output.match(/Vector store cleanup did not finish[^\r\n]*/)?.[0];
          const conciseMessage = cleanupMessage
            ? `${cleanupMessage} This usually means OpenAI still has old blank/stale rows. Delete those old rows with the trash icon in OpenAI Storage, then sync again.`
            : error.message || "Knowledge ingestion failed.";
          reject(new Error(conciseMessage.slice(0, 500)));
          return;
        }
        const vectorStoreMatch = output.match(/(?:Using|Created) vector store:\s*(\S+)/);
        const readyFiles = [...output.matchAll(/Ready:\s*([^(]+?)\s*\(/g)]
          .map((match) => match[1].trim())
          .filter(Boolean);
        resolve({
          status: "completed",
          syncedAt: new Date().toISOString(),
          vectorStoreId: vectorStoreMatch?.[1] || "",
          files: readyFiles,
        });
      }
    );
  });
}

async function recordSystemError(scope, error, details = "", accountId = config.accountId) {
  console.error(`${scope}:`, error);
  try {
    await operations.recordError({
      scope,
      accountId,
      message: error?.message || String(error),
      details,
    });
  } catch (recordError) {
    console.error("Unable to persist operational error:", recordError);
  }
}

async function buildSystemManagementData() {
  const [state, accounts, failedMessages, errors, audits, followupQueue] = await Promise.all([
    operations.getState(),
    adminAccounts.listAccounts(),
    operations.listFailedMessages(),
    operations.listErrors(),
    store.listAuditLog(),
    operations.listFollowupQueue(),
  ]);
  return {
    state,
    accounts: accounts.filter((account) => account.role === "business_admin"),
    failedMessages,
    errors,
    audits: [...audits].reverse().slice(0, 100),
    queuedFollowupCount: followupQueue.filter((item) => ["queued", "processing", "retry_pending"].includes(item.status)).length,
  };
}

async function buildSystemBackup() {
  const [state, accounts, failedMessages, errors, audits, customers, deletedCustomers, orders, outbox, followupQueue] =
    await Promise.all([
      operations.getState(),
      adminAccounts.listAccounts(),
      operations.listFailedMessages(),
      operations.listErrors(),
      store.listAuditLog(),
      store.listCustomers(),
      store.listDeletedCustomers(),
      store.listOrders(),
      store.listOutbox(),
      operations.listFollowupQueue(),
    ]);
  return {
    exportedAt: new Date().toISOString(),
    state,
    accounts,
    failedMessages,
    errors,
    audits,
    customers,
    deletedCustomers,
    orders,
    outbox,
    followupQueue,
  };
}

async function getTeamContent(accountId) {
  return teamContentStore.getContent(accountId || config.accountId, defaultTeamContent);
}

async function saveTeamContent(accountId, content) {
  return teamContentStore.saveContent(accountId || config.accountId, content);
}

function faqLibraryData(content = defaultTeamContent) {
  const teamCatalog = content.catalog || catalog;
  const teamFaqLibrary = content.faqLibrary || faqLibrary;
  return {
    general: (teamFaqLibrary.approved_faqs || []).map((faq) => ({ ...faq, scope: "general", productId: "" })),
    products: teamCatalog.products.map((product) => ({
      id: product.id,
      name: product.name,
      faqs: (product.approved_faqs || []).map((faq) => ({ ...faq, scope: "product", productId: product.id })),
    })),
  };
}

async function maybeLearnFromManualReply(customer, replyText, businessAccountId) {
  if (customer.handoffStatus !== "human_required") return null;
  const latestInbound = await latestInboundMessageForCustomer(customer.id, businessAccountId);
  const question = String(latestInbound?.body || "").trim();
  if (!question || !replyText) return null;
  if (shouldSkipLearningQuestion(question)) return null;
  const content = await getTeamContent(businessAccountId);

  const scope = isGeneralBusinessQuestion(question) ? "general" : "product";
  const productId = scope === "product" ? String(customer.productId || "").trim() : "";
  if (scope === "product" && !findCatalogProduct(productId, content.catalog)) return null;

  const learnedFaq = upsertLearnedFaq({
    scope,
    productId,
    question,
    replyText,
  }, content);
  await saveTeamContent(businessAccountId, content);
  await store.appendAuditLog({
    actor: `system:${businessAccountId}`,
    action: "manual_reply_learned_faq",
    customerId: customer.id,
    result: `${learnedFaq.scope}:${learnedFaq.productId || "general"}:${learnedFaq.id}`,
    businessAccountId,
  });
  return learnedFaq;
}

async function latestInboundMessageForCustomer(customerId, businessAccountId) {
  const messages = await store.listOutbox();
  return messages
    .filter((message) =>
      message.direction === "inbound" &&
      message.from === customerId &&
      (!businessAccountId || message.businessAccountId === businessAccountId)
    )
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))[0] || null;
}

function upsertLearnedFaq({ scope, productId, question, replyText }, content = defaultTeamContent) {
  const product = scope === "product" ? findCatalogProduct(productId, content.catalog || catalog) : null;
  const records = scope === "general" ? ((content.faqLibrary || faqLibrary).approved_faqs ||= []) : (product.approved_faqs ||= []);
  const normalizedQuestion = normalizeLearnedText(question);
  const existing = records.find((faq) =>
    (faq.example_questions || []).some((example) => normalizeLearnedText(example) === normalizedQuestion)
  );

  if (existing) {
    existing.approved_reply = replyText;
    existing.active = true;
    existing.learned_from_handoff = true;
    existing.updatedAt = new Date().toISOString();
    return { ...existing, scope, productId };
  }

  return saveApprovedFaq({
    scope,
    productId,
    topic: `Learned: ${question.slice(0, 80)}`,
    exampleQuestions: [question],
    approvedReply: replyText,
    active: true,
  }, content);
}

function shouldSkipLearningQuestion(question) {
  return /\b(full\s*name|phone\s*number|address|alamat|order\s*package|complaint|refund|rosak|marah|angry)\b/i.test(question);
}

function normalizeLearnedText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}$]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function saveApprovedFaq(body, content = defaultTeamContent) {
  const teamCatalog = content.catalog || catalog;
  const teamFaqLibrary = content.faqLibrary || faqLibrary;
  const scope = body.scope === "product" ? "product" : "general";
  const productId = scope === "product" ? String(body.productId || "").trim() : "";
  const product = scope === "product" ? findCatalogProduct(productId, teamCatalog) : null;
  if (scope === "product" && !product) throw new Error("Select a product for product FAQ.");
  const topic = String(body.topic || "").trim();
  const approvedReply = String(body.approvedReply || "").trim();
  const exampleQuestions = Array.isArray(body.exampleQuestions)
    ? body.exampleQuestions.map((question) => String(question).trim()).filter(Boolean)
    : String(body.exampleQuestions || "").split(/\r?\n/).map((question) => question.trim()).filter(Boolean);
  if (!topic) throw new Error("FAQ topic is required.");
  if (!approvedReply) throw new Error("Approved reply is required.");
  if (!exampleQuestions.length) throw new Error("Add at least one example customer question.");
  const records = scope === "general"
    ? (teamFaqLibrary.approved_faqs ||= [])
    : (product.approved_faqs ||= []);
  const existingId = String(body.id || "").trim();
  const prefix = scope === "general" ? "general" : safeAssetSegment(product.id);
  const proposedId = `${prefix}_${safeAssetSegment(topic)}`;
  let id = existingId || proposedId;
  if (!existingId) {
    let suffix = 2;
    const allIds = new Set([
      ...(teamFaqLibrary.approved_faqs || []).map((faq) => faq.id),
      ...teamCatalog.products.flatMap((entry) => (entry.approved_faqs || []).map((faq) => faq.id)),
    ]);
    while (allIds.has(id)) {
      id = `${proposedId}_${suffix}`;
      suffix += 1;
    }
  }
  const index = records.findIndex((faq) => faq.id === id);
  const existing = index >= 0 ? records[index] : {};
  const bruneiMalayExampleQuestions = "bruneiMalayExampleQuestions" in body
    ? (Array.isArray(body.bruneiMalayExampleQuestions)
        ? body.bruneiMalayExampleQuestions.map((question) => String(question).trim()).filter(Boolean)
        : String(body.bruneiMalayExampleQuestions || "").split(/\r?\n/).map((question) => question.trim()).filter(Boolean))
    : (existing.brunei_malay_example_questions || []);
  const saved = {
    id,
    topic_key: String(body.topicKey || existing.topic_key || existing.topicKey || id).trim() || id,
    topic,
    example_questions: exampleQuestions,
    approved_reply: approvedReply,
    active: body.active !== false,
  };
  const bruneiMalayTopic = "bruneiMalayTopic" in body
    ? String(body.bruneiMalayTopic || "").trim()
    : String(existing.brunei_malay_topic || "");
  const bruneiMalayApprovedReply = "bruneiMalayApprovedReply" in body
    ? String(body.bruneiMalayApprovedReply || "").trim()
    : String(existing.brunei_malay_approved_reply || "");
  const bruneiMalaySearchText = "bruneiMalaySearchText" in body
    ? String(body.bruneiMalaySearchText || "").trim()
    : String(existing.brunei_malay_search_text || "");
  if (bruneiMalayTopic) saved.brunei_malay_topic = bruneiMalayTopic;
  if (bruneiMalayExampleQuestions.length) saved.brunei_malay_example_questions = bruneiMalayExampleQuestions;
  if (bruneiMalayApprovedReply) saved.brunei_malay_approved_reply = bruneiMalayApprovedReply;
  if (bruneiMalaySearchText) saved.brunei_malay_search_text = bruneiMalaySearchText;
  if (index >= 0) records[index] = saved;
  else records.push(saved);
  return { ...saved, scope, productId };
}

function deleteApprovedFaq(body, content = defaultTeamContent) {
  const teamFaqLibrary = content.faqLibrary || faqLibrary;
  const teamCatalog = content.catalog || catalog;
  const scope = body.scope === "product" ? "product" : "general";
  const productId = scope === "product" ? String(body.productId || "").trim() : "";
  const product = scope === "product" ? findCatalogProduct(productId, teamCatalog) : null;
  if (scope === "product" && !product) throw new Error("Select a product for product FAQ.");
  const id = String(body.id || "").trim();
  if (!id) throw new Error("FAQ id is required.");
  const records = scope === "general"
    ? (teamFaqLibrary.approved_faqs ||= [])
    : (product.approved_faqs ||= []);
  const index = records.findIndex((faq) => faq.id === id);
  if (index < 0) throw new Error("FAQ not found.");
  const [deleted] = records.splice(index, 1);
  return { ...deleted, scope, productId };
}

function salesRepliesData(content = defaultTeamContent) {
  const teamSalesReplyLibrary = content.salesReplyLibrary || salesReplyLibrary;
  return {
    general: (teamSalesReplyLibrary.sales_replies || [])
      .filter((reply) => (reply.scope || "business") !== "product")
      .map((reply) => ({ ...reply, scope: "general", productId: "" })),
    products: [],
  };
}

function saveSalesReply(body, content = defaultTeamContent) {
  const teamSalesReplyLibrary = content.salesReplyLibrary || salesReplyLibrary;
  if (body.scope === "product") throw new Error("Sales replies are general only. Product-specific answers belong in Product FAQ.");
  const scope = "general";
  const productId = "";
  const salesIntent = normalizeSalesIntent(body.salesIntent || body.intentKey || body.objectionType);
  const salesIntentLabel = String(body.salesIntentLabel || body.objectionType || "").trim();
  const objectionType = salesIntentLabel || SALES_INTENT_LABELS.get(salesIntent) || readableStorageLabel(salesIntent);
  const intent = String(body.intent || "").trim() || salesIntentDescription(salesIntent) || `Customer sales response or hesitation: ${objectionType}`;
  const approvedReply = String(body.approvedReply || "").trim();
  const repeatAction = normalizeSalesRepeatAction(body.repeatAction);
  const exampleMessages = Array.isArray(body.exampleMessages)
    ? body.exampleMessages.map((message) => String(message).trim()).filter(Boolean)
    : String(body.exampleMessages || "").split(/\r?\n/).map((message) => message.trim()).filter(Boolean);
  if (!salesIntent) throw new Error("Sales intent is required.");
  if (!approvedReply) throw new Error("Approved reply is required.");
  if (!exampleMessages.length) throw new Error("Add at least one example customer message.");
  const records = (teamSalesReplyLibrary.sales_replies ||= []);
  const existingId = String(body.id || "").trim();
  const storageScope = "business";
  const prefix = "sales";
  const proposedId = `${prefix}_${safeAssetSegment(salesIntent)}`;
  let id = existingId || proposedId;
  if (!existingId) {
    let suffix = 2;
      const allIds = new Set([
      ...(teamSalesReplyLibrary.sales_replies || []).map((reply) => reply.id),
    ]);
    while (allIds.has(id)) {
      id = `${proposedId}_${suffix}`;
      suffix += 1;
    }
  }
  const saved = {
    id,
    sales_intent: salesIntent,
    objection_type: objectionType,
    intent,
    example_messages: exampleMessages,
    approved_reply: approvedReply,
    repeat_action: repeatAction,
    scope: storageScope,
    productId: "",
    active: body.active !== false,
  };
  const index = records.findIndex((reply) => reply.id === id);
  if (index >= 0) records[index] = saved;
  else records.push(saved);
  return { ...saved, scope, productId };
}

function normalizeSalesRepeatAction(value) {
  const action = String(value || "openai_acknowledge").trim();
  return SALES_REPEAT_ACTION_LABELS.has(action) ? action : "openai_acknowledge";
}

function normalizeSalesIntent(value) {
  const original = String(value || "").trim();
  const raw = original.toLowerCase().replace(/[\s-]+/g, "_");
  if (SALES_INTENT_LABELS.has(raw)) return raw;
  if (/(price|nego|negotiat|discount|murah|less)/i.test(raw)) return "price_objection_negotiation";
  if (/(fikir|think|tanya|ask|later|nanti|next_time)/i.test(raw)) return "thinking_first";
  if (/(payday|gaji|salary|pay_later|bayar)/i.test(raw)) return "payday_only_pay";
  if (/(expensive|mahal|too_much)/i.test(raw)) return "too_expensive";
  if (/(not_interested|no_interest|nda_minat|inda_minat|not_now|next_time)/i.test(raw)) return "not_interested";
  if (/(another_date|specific_date|tarikh|date|bulan|hari|next_month|minggu_depan)/i.test(raw)) return "another_date_purchase";
  return original ? safeAssetSegment(original).replace(/-/g, "_") : "";
}

function readableStorageLabel(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function salesIntentDescription(salesIntent) {
  if (salesIntent === "price_objection_negotiation") return "Customer is negotiating price, asking for discount, or objecting to price.";
  if (salesIntent === "thinking_first") return "Customer wants to think first, ask someone first, or decide later.";
  if (salesIntent === "payday_only_pay") return "Customer is interested but wants to wait for payday, salary, budget, or pay later.";
  if (salesIntent === "too_expensive") return "Customer says the product, package, or delivery is too expensive.";
  if (salesIntent === "not_interested") return "Customer politely says not interested, not now, or next time.";
  if (salesIntent === "another_date_purchase") return "Customer plans to buy on another date, payday date, next month, or a future buying time.";
  return "";
}

function deleteSalesReply(body, content = defaultTeamContent) {
  const teamSalesReplyLibrary = content.salesReplyLibrary || salesReplyLibrary;
  if (body.scope === "product") throw new Error("Sales replies are general only. Product-specific answers belong in Product FAQ.");
  const scope = "general";
  const productId = "";
  const id = String(body.id || "").trim();
  if (!id) throw new Error("Sales reply id is required.");
  const records = (teamSalesReplyLibrary.sales_replies ||= []);
  const index = records.findIndex((reply) => reply.id === id);
  if (index < 0) throw new Error("Sales reply not found.");
  const [deleted] = records.splice(index, 1);
  return { ...deleted, scope, productId: deleted.productId || productId };
}

function legacyStandardSalesReplies(product) {
  return (product.standard_replies || [])
    .filter((reply) => reply.type === "sales_response")
    .map((reply, index) => legacyStandardSalesReply(product, reply, index));
}

function legacyStandardSalesReply(product, reply, index) {
  const examples = reply.customer_messages || reply.triggers || [];
  const label = examples[0] || reply.reply || `sales response ${index + 1}`;
  return {
    id: legacyStandardSalesReplyId(product, reply, index),
    objection_type: label,
    intent: `Customer gives this sales response or hesitation: ${label}`,
    example_messages: examples,
    approved_reply: reply.reply || "",
    active: reply.active !== false,
    legacy_standard_reply: true,
  };
}

function legacyStandardSalesReplyId(product, reply, index) {
  const examples = reply.customer_messages || reply.triggers || [];
  const label = examples[0] || reply.reply || `sales response ${index + 1}`;
  return `${product.id}_legacy_sales_${safeAssetSegment(label)}_${index + 1}`;
}

const PRODUCT_FLOW_TEXT_SLOTS = [
  { key: "greeting", index: 0 },
  { key: "description", index: 4 },
  { key: "testimonialText", index: 9 },
  { key: "priceText", index: 11, shiftedIndex: 12 },
  { key: "packageQuestion", index: 12, shiftedIndex: 13 },
];
const PRODUCT_FLOW_IMAGE_SLOTS = [
  { key: "infoPhoto1", label: "Product info photo 1", index: 1, filename: "product-1" },
  { key: "infoPhoto2", label: "Product info photo 2", index: 2, filename: "product-2" },
  { key: "infoPhoto3", label: "Product info photo 3", index: 3, filename: "product-3" },
  { key: "testimonialPhoto1", label: "Testimonial photo 1", index: 5, filename: "testimonial-1" },
  { key: "testimonialPhoto2", label: "Testimonial photo 2", index: 6, filename: "testimonial-2" },
  { key: "testimonialPhoto3", label: "Testimonial photo 3", index: 7, filename: "testimonial-3" },
  { key: "testimonialPhoto4", label: "Testimonial photo 4", index: 8, filename: "testimonial-4" },
  { key: "pricePhoto", label: "Price photo", index: 10, filename: "price" },
  { key: "salesPhoto", label: "Optional sales photo", index: -1, filename: "sales" },
];
const REQUIRED_PRODUCT_FLOW_IMAGE_KEYS = new Set(PRODUCT_FLOW_IMAGE_SLOTS
  .filter((slot) => slot.key !== "salesPhoto")
  .map((slot) => slot.key));
const LEGACY_OPENING_FLOW_BLOCKS = [
  { id: "greeting", type: "text", label: "Greeting", field: "greeting" },
  { id: "infoPhoto1", type: "image", label: "Product info photo 1", imageKey: "infoPhoto1" },
  { id: "infoPhoto2", type: "image", label: "Product info photo 2", imageKey: "infoPhoto2" },
  { id: "infoPhoto3", type: "image", label: "Product info photo 3", imageKey: "infoPhoto3" },
  { id: "description", type: "text", label: "Product Description", field: "description" },
  { id: "testimonialPhoto1", type: "image", label: "Testimonial photo 1", imageKey: "testimonialPhoto1" },
  { id: "testimonialPhoto2", type: "image", label: "Testimonial photo 2", imageKey: "testimonialPhoto2" },
  { id: "testimonialPhoto3", type: "image", label: "Testimonial photo 3", imageKey: "testimonialPhoto3" },
  { id: "testimonialPhoto4", type: "image", label: "Testimonial photo 4", imageKey: "testimonialPhoto4" },
  { id: "testimonialText", type: "text", label: "Testimonial Text", field: "testimonialText" },
  { id: "pricePhoto", type: "image", label: "Price photo", imageKey: "pricePhoto" },
  { id: "salesPhoto", type: "image", label: "Optional sales photo", imageKey: "salesPhoto", optional: true },
  { id: "priceText", type: "text", label: "Price Text", field: "priceText" },
  { id: "packageQuestion", type: "text", label: "Closing / Order Option Question", field: "packageQuestion" },
];

function findCatalogProduct(productId, activeCatalog = catalog) {
  return activeCatalog.products.find((product) => product.id === String(productId || ""));
}

function deleteCatalogProduct(productId, activeCatalog = catalog) {
  const id = String(productId || "").trim();
  if (!id) throw new Error("Product is required.");
  const products = activeCatalog.products || [];
  if (products.length <= 1) throw new Error("Cannot delete the last product.");
  const index = products.findIndex((product) => product.id === id);
  if (index < 0) throw new Error("Product not found.");
  const [deleted] = products.splice(index, 1);
  if (activeCatalog.default_product_id === deleted.id) {
    activeCatalog.default_product_id = products[0]?.id || "";
  }
  return { id: deleted.id, name: deleted.name || deleted.id };
}

function productFlowEditorData(product, options = {}) {
  const openingFlow = product.opening_flow || [];
  const hasSalesPhotoInFlow = Boolean(
    openingFlow[11]?.type === "image" ||
    (product.sales_photo_url && openingFlow.some((message) => message?.url === product.sales_photo_url))
  );
  const textValueForSlot = (slot) => {
    const index = hasSalesPhotoInFlow && slot.shiftedIndex !== undefined ? slot.shiftedIndex : slot.index;
    return String(openingFlow[index]?.body || "");
  };
  const imageUrlForSlot = (slot) => {
    const saved = persistedProductFlowImage(product, slot.key);
    const currentUrl = slot.key === "salesPhoto"
      ? String(product.sales_photo_url || "")
      : String(openingFlow[slot.index]?.url || "");
    if (!currentUrl) return String(saved?.durableUrl || "");
    if (currentUrl.startsWith("/assets/") && saved?.durableUrl && !localAssetExists(currentUrl)) {
      return String(saved.durableUrl || "");
    }
    return currentUrl;
  };
  return {
    id: product.id,
    name: product.name,
    skuCode: String(product.sku_code || ""),
    shoppingLink: String(product.shopping_link || ""),
    orderOptions: orderOptionsForEditor(product),
    orderForm: orderFormForEditor(product),
    orderClosingMessages: orderClosingMessagesForEditor(product),
    salesPrompt: String(product.sales_prompt ?? product.package_question ?? ""),
    salesPromptFrequency: normalizeSalesPromptFrequency(product.sales_prompt_frequency),
    approvedFaqs: approvedProductFaqsForEditor(product),
    extractedKnowledge: productKnowledgeForEditor(product),
    ready: options.skipReady ? false : product.openingFlowEnabled !== false && isProductFlowComplete(product),
    ...Object.fromEntries(
      PRODUCT_FLOW_TEXT_SLOTS.map((slot) => [slot.key, textValueForSlot(slot)])
    ),
    images: PRODUCT_FLOW_IMAGE_SLOTS.map((slot) => ({
      key: slot.key,
      label: slot.label,
      url: imageUrlForSlot(slot),
    })),
    openingFlowBlocks: openingFlowBlocksForEditor(product, {
      ...Object.fromEntries(
        PRODUCT_FLOW_TEXT_SLOTS.map((slot) => [slot.key, textValueForSlot(slot)])
      ),
      images: PRODUCT_FLOW_IMAGE_SLOTS.map((slot) => ({
        key: slot.key,
        label: slot.label,
        url: imageUrlForSlot(slot),
      })),
    }),
  };
}

function openingFlowBlocksForEditor(product, editorData) {
  const saved = Array.isArray(product.opening_flow_blocks) ? product.opening_flow_blocks : null;
  return normalizeOpeningFlowBlocks(saved?.length ? saved : legacyOpeningFlowBlocks(editorData), editorData);
}

function legacyOpeningFlowBlocks(editorData) {
  const imageByKey = new Map((editorData.images || []).map((image) => [image.key, image]));
  return LEGACY_OPENING_FLOW_BLOCKS.map((block) => {
    if (block.type === "image") {
      const image = imageByKey.get(block.imageKey) || {};
      return {
        id: block.id,
        type: "image",
        label: block.label,
        imageKey: block.imageKey,
        url: image.url || "",
        caption: "",
        enabled: block.optional ? Boolean(image.url) : true,
      };
    }
    return {
      id: block.id,
      type: "text",
      label: block.label,
      body: String(editorData[block.field] || ""),
      enabled: true,
    };
  });
}

function normalizeOpeningFlowBlocks(blocks, editorData = {}) {
  const imageByKey = new Map((editorData.images || []).map((image) => [image.key, image]));
  return (Array.isArray(blocks) ? blocks : [])
    .map((block, index) => {
      const type = block?.type === "image" ? "image" : "text";
      const id = safeOpeningFlowBlockId(block?.id || `${type}_${Date.now()}_${index + 1}`);
      const label = String(block?.label || (type === "image" ? "Image block" : "Text block")).trim().slice(0, 120);
      const enabled = block?.enabled !== false;
      if (type === "image") {
        const imageKey = String(block?.imageKey || block?.slot || "").trim();
        const image = imageByKey.get(imageKey) || {};
        const url = String(block?.url || image.url || "").trim();
        return {
          id,
          type,
          label,
          imageKey,
          url,
          caption: String(block?.caption || "").trim(),
          enabled,
        };
      }
      return {
        id,
        type,
        label,
        body: String(block?.body || "").trim(),
        enabled,
      };
    })
    .filter((block) => block.type === "image" || block.body);
}

function safeOpeningFlowBlockId(value) {
  return String(value || "block")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "block";
}

function approvedProductFaqsForEditor(product) {
  return (product.approved_faqs || [])
    .filter((faq) => faq && faq.active !== false)
    .map((faq) => ({
      id: String(faq.id || ""),
      topic: String(faq.topic || faq.brunei_malay_topic || ""),
      bruneiMalayTopic: String(faq.brunei_malay_topic || ""),
      exampleQuestions: [
        ...(Array.isArray(faq.example_questions) ? faq.example_questions : []),
        ...(Array.isArray(faq.customer_messages) ? faq.customer_messages : []),
      ].map((item) => String(item || "").trim()).filter(Boolean),
      bruneiMalayExampleQuestions: (Array.isArray(faq.brunei_malay_example_questions) ? faq.brunei_malay_example_questions : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean),
      approvedReply: String(faq.approved_reply || faq.answer || ""),
      bruneiMalayApprovedReply: String(faq.brunei_malay_approved_reply || ""),
      bruneiMalaySearchText: String(faq.brunei_malay_search_text || ""),
      active: faq.active !== false,
    }));
}

function orderClosingMessagesForEditor(product) {
  if (Array.isArray(product?.order_closing_messages)) {
    return normalizeOrderClosingMessages(product.order_closing_messages);
  }
  return [...DEFAULT_ORDER_CLOSING_MESSAGES];
}

function orderFormForEditor(product) {
  return normalizeOrderForm(product?.order_form);
}

function normalizeOrderForm(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    intro: cleanOrderFormValue(source.intro, DEFAULT_ORDER_FORM.intro),
    nameLabel: cleanOrderFormValue(source.nameLabel || source.name_label, DEFAULT_ORDER_FORM.nameLabel),
    addressLabel: cleanOrderFormValue(source.addressLabel || source.address_label, DEFAULT_ORDER_FORM.addressLabel),
    phoneLabel: cleanOrderFormValue(source.phoneLabel || source.phone_label, DEFAULT_ORDER_FORM.phoneLabel),
    optionLabel: cleanOrderFormValue(source.optionLabel || source.option_label, DEFAULT_ORDER_FORM.optionLabel),
  };
}

function cleanOrderFormValue(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function normalizeOrderClosingMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => String(message || "").trim())
    .filter(Boolean)
    .slice(0, 20);
}

function productKnowledgeForEditor(product) {
  const knowledge = ensureProductKnowledge(product);
  return {
    pending: [...knowledge.pendingImages, ...knowledge.pending],
    approved: [...knowledge.approvedImages, ...knowledge.approved],
    lastExtraction: knowledge.lastExtraction || null,
  };
}

function updateProductFlowText(product, body) {
  const current = productFlowEditorData(product);
  const hasFlowTextUpdate = PRODUCT_FLOW_TEXT_SLOTS.some((slot) =>
    Object.prototype.hasOwnProperty.call(body, slot.key)
  );
  const hasBlockUpdate = Object.prototype.hasOwnProperty.call(body, "openingFlowBlocks");
  if (hasFlowTextUpdate) {
    product.package_question = String(body.packageQuestion ?? current.packageQuestion ?? "");
    const next = {
      ...current,
      ...Object.fromEntries(
        PRODUCT_FLOW_TEXT_SLOTS.map((slot) => [slot.key, String(body[slot.key] ?? current[slot.key])])
      ),
    };
    product.opening_flow = buildProductOpeningFlow(next);
    if (!hasBlockUpdate && Array.isArray(product.opening_flow_blocks)) {
      product.opening_flow_blocks = normalizeOpeningFlowBlocks(product.opening_flow_blocks.map((block) => {
        const legacy = LEGACY_OPENING_FLOW_BLOCKS.find((item) => item.id === block.id && item.type === "text");
        return legacy ? { ...block, body: next[legacy.field] } : block;
      }), next);
      product.opening_flow = buildProductOpeningFlowFromBlocks(product.opening_flow_blocks);
    }
  }
  if (hasBlockUpdate) {
    const editorData = productFlowEditorData(product, { skipReady: true });
    product.opening_flow_blocks = normalizeOpeningFlowBlocks(body.openingFlowBlocks, editorData);
    product.opening_flow = buildProductOpeningFlowFromBlocks(product.opening_flow_blocks);
  }
  if (Object.prototype.hasOwnProperty.call(body, "orderOptions")) {
    product.order_options = normalizeOrderOptions(body.orderOptions);
  }
  if (Object.prototype.hasOwnProperty.call(body, "orderClosingMessages")) {
    product.order_closing_messages = normalizeOrderClosingMessages(body.orderClosingMessages);
  }
  if (Object.prototype.hasOwnProperty.call(body, "orderForm")) {
    product.order_form = normalizeOrderForm(body.orderForm);
  }
  if (Object.prototype.hasOwnProperty.call(body, "salesPrompt")) {
    product.sales_prompt = String(body.salesPrompt ?? "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(body, "salesPromptFrequency")) {
    product.sales_prompt_frequency = normalizeSalesPromptFrequency(body.salesPromptFrequency);
  }
  if (Object.prototype.hasOwnProperty.call(body, "skuCode")) {
    product.sku_code = normalizeSkuCode(body.skuCode);
  }
  product.shopping_link = normalizeShoppingLink(body.shoppingLink ?? product.shopping_link ?? "");
  updateProductFlowReadiness(product);
}

function updateProductFlowImage(product, slot, assetUrl) {
  const current = productFlowEditorData(product);
  current.images = current.images.map((image) =>
    image.key === slot.key ? { ...image, url: assetUrl } : image
  );
  if (slot.key === "salesPhoto") product.sales_photo_url = assetUrl;
  if (Array.isArray(product.opening_flow_blocks)) {
    product.opening_flow_blocks = normalizeOpeningFlowBlocks(product.opening_flow_blocks.map((block) =>
      block.imageKey === slot.key ? { ...block, url: assetUrl, enabled: true } : block
    ), current);
    product.opening_flow = buildProductOpeningFlowFromBlocks(product.opening_flow_blocks);
  } else {
    product.opening_flow = buildProductOpeningFlow(current);
  }
  product.images = current.images.map((image) => ({
    url: image.url,
    caption: image.label,
  }));
  updateProductFlowReadiness(product);
}

function productFlowImageSlotForUpload(product, slotKey) {
  const key = String(slotKey || "").trim();
  const standard = PRODUCT_FLOW_IMAGE_SLOTS.find((item) => item.key === key);
  if (standard) return standard;
  const block = Array.isArray(product.opening_flow_blocks)
    ? product.opening_flow_blocks.find((item) => item?.type === "image" && item.imageKey === key)
    : null;
  if (!block) return null;
  return {
    key,
    label: String(block.label || "Opening flow image"),
    filename: safeAssetSegment(key || block.id || "opening-flow-image"),
  };
}

function ensureProductPersistedImages(product) {
  product.persisted_images = product.persisted_images && typeof product.persisted_images === "object"
    ? product.persisted_images
    : {};
  return product.persisted_images;
}

function persistedProductFlowImage(product, slotKey) {
  const images = product.persisted_images && typeof product.persisted_images === "object"
    ? product.persisted_images
    : {};
  const saved = images[String(slotKey || "")];
  return saved && typeof saved === "object" ? saved : null;
}

function persistProductFlowImage(product, slot, { dataUrl, image, originalName = "", assetUrl = "", durableUrl = "" }) {
  const images = ensureProductPersistedImages(product);
  images[slot.key] = {
    dataUrl: String(dataUrl || ""),
    mimeType: image.mimeType,
    extension: image.extension,
    originalName: String(originalName || ""),
    assetUrl,
    durableUrl,
    updatedAt: new Date().toISOString(),
  };
}

async function ingestProductImageKnowledge(product, { slot, assetUrl, dataUrl, originalName = "", businessAccountId = config.accountId }) {
  ensureProductKnowledge(product);
  const apiKey = await openAiApiKeyForAccount(businessAccountId);
  if (!apiKey) {
    product.extracted_knowledge.lastExtraction = {
      status: "skipped",
      reason: "OpenAI API key is not configured for this team or Railway.",
      at: new Date().toISOString(),
      sourceSlot: slot.key,
      sourceImageUrl: assetUrl,
      sourceFilename: imageFilename(assetUrl, originalName),
    };
    return product.extracted_knowledge.lastExtraction;
  }

  try {
    const result = await extractProductKnowledgeFromImage({
      apiKey,
      model: config.extractionModel,
      productName: product.name,
      imageDataUrl: dataUrl,
      imageLabel: [slot.label, imageFilename(assetUrl, originalName)].filter(Boolean).join(" | "),
    });
    const now = new Date().toISOString();
    const sourceFilename = imageFilename(assetUrl, originalName);
    const existingImageKeys = new Set([
      ...product.extracted_knowledge.pendingImages,
      ...product.extracted_knowledge.approvedImages,
    ].map(imageChunkKey));
    const imageChunk = result.imageChunk && !existingImageKeys.has(imageChunkKey({ ...result.imageChunk, sourceImageUrl: assetUrl }))
      ? {
          id: `image_${Date.now()}`,
          kind: "image_chunk",
          category: result.imageChunk.category || categoryFromImageName(sourceFilename, slot.label),
          title: result.imageChunk.title || slot.label,
          summary: result.imageChunk.summary || "",
          extracted_text: result.imageChunk.extracted_text || "",
          embedding_text: result.imageChunk.embedding_text || "",
          brunei_malay_summary: result.imageChunk.brunei_malay_summary || "",
          brunei_malay_search_text: result.imageChunk.brunei_malay_search_text || "",
          customer_safe: result.imageChunk.customer_safe !== false,
          approval_note: result.imageChunk.approval_note || "",
          question_examples: result.imageChunk.question_examples || [],
          brunei_malay_question_examples: result.imageChunk.brunei_malay_question_examples || [],
          sourceSlot: slot.key,
          sourceLabel: slot.label,
          sourceImageUrl: assetUrl,
          sourceFilename,
          extractedAt: now,
      }
      : null;
    if (imageChunk) product.extracted_knowledge.pendingImages.push(imageChunk);
    product.extracted_knowledge.lastExtraction = {
      status: "completed",
      imageChunkAdded: Boolean(imageChunk),
      factsFound: result.facts.length,
      factsAdded: 0,
      factsSkipped: result.facts.length,
      at: now,
      sourceSlot: slot.key,
      sourceImageUrl: assetUrl,
      sourceFilename,
    };
    return product.extracted_knowledge.lastExtraction;
  } catch (error) {
    await recordSystemError("product_image_knowledge_extraction", error, `Product: ${product.id}`);
    product.extracted_knowledge.lastExtraction = {
      status: "failed",
      reason: error.message,
      at: new Date().toISOString(),
      sourceSlot: slot.key,
      sourceImageUrl: assetUrl,
      sourceFilename: imageFilename(assetUrl, originalName),
    };
    return product.extracted_knowledge.lastExtraction;
  }
}

async function extractExistingProductImageKnowledge(product, businessAccountId = config.accountId) {
  ensureProductKnowledge(product);
  const editorData = productFlowEditorData(product);
  const images = productFlowImagesForExtraction(product, editorData);

  if (!images.length) {
    product.extracted_knowledge.lastExtraction = {
      status: "skipped",
      reason: "No existing opening-flow images found.",
      at: new Date().toISOString(),
      batch: true,
    };
    return product.extracted_knowledge.lastExtraction;
  }

  const results = [];
  for (const image of images) {
    try {
      const dataUrl = await assetUrlToDataUrl(image.url);
      const result = await ingestProductImageKnowledge(product, {
        slot: image.slot,
        assetUrl: image.url,
        originalName: imageFilename(image.url),
        dataUrl,
        businessAccountId,
      });
      results.push({ slot: image.key, url: image.url, ...result });
    } catch (error) {
      await recordSystemError("existing_product_image_knowledge_extraction", error, `Product: ${product.id}; image: ${image.url}`);
      results.push({
        slot: image.key,
        url: image.url,
        status: "failed",
        reason: error.message,
      });
    }
  }

  const completed = results.filter((result) => result.status === "completed");
  const failed = results.filter((result) => result.status === "failed");
  const imageChunksAdded = completed.filter((result) => result.imageChunkAdded).length;
  product.extracted_knowledge.lastExtraction = {
    status: completed.length ? "completed" : "failed",
    imageChunksAdded,
    factsFound: 0,
    factsAdded: 0,
    imagesProcessed: images.length,
    imagesCompleted: completed.length,
    imagesFailed: failed.length,
    at: new Date().toISOString(),
    batch: true,
    results,
    ...(completed.length ? {} : { reason: failed[0]?.reason || "Extraction failed." }),
  };
  return product.extracted_knowledge.lastExtraction;
}

function productFlowImagesForExtraction(product, editorData = productFlowEditorData(product)) {
  const images = [];
  const seenUrls = new Set();
  const addImage = (image, slot) => {
    const url = String(image?.url || "").trim();
    if (!url || !slot || seenUrls.has(url)) return;
    seenUrls.add(url);
    images.push({ ...image, key: slot.key, label: slot.label, url, slot });
  };
  for (const block of editorData.openingFlowBlocks || []) {
    if (block?.type !== "image" || block.enabled === false) continue;
    const slot = productFlowImageSlotForUpload(product, block.imageKey || block.id);
    addImage({ key: block.imageKey || block.id, label: block.label, url: block.url }, slot);
  }
  for (const image of editorData.images || []) {
    const slot = productFlowImageSlotForUpload(product, image.key);
    addImage(image, slot);
  }
  return images;
}

async function assetUrlToDataUrl(assetUrl) {
  const cleanUrl = String(assetUrl || "").split("?")[0];
  if (cleanUrl.startsWith("/persisted-assets/")) {
    const asset = await persistedAssetFromUrl(cleanUrl);
    if (!asset) throw new Error("Persisted image asset could not be loaded.");
    return `data:${asset.mimeType};base64,${asset.bytes.toString("base64")}`;
  }
  if (!cleanUrl.startsWith("/assets/")) {
    throw new Error("Only local uploaded assets can be extracted.");
  }
  const relativePath = decodeURIComponent(cleanUrl.slice("/assets/".length));
  const filePath = path.resolve(config.assetsDir, relativePath);
  const root = `${config.assetsDir}${path.sep}`.toLowerCase();
  if (!filePath.toLowerCase().startsWith(root)) {
    throw new Error("Image path is outside the assets folder.");
  }
  const contentType = contentTypeFor(filePath);
  if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
    throw new Error("Only PNG, JPG, and WEBP images can be extracted.");
  }
  const bytes = await readFile(filePath);
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

function imageFilename(assetUrl, originalName = "") {
  const original = String(originalName || "").trim();
  if (original) return path.basename(original);
  const cleanUrl = String(assetUrl || "").split("?")[0];
  if (!cleanUrl) return "";
  return path.basename(decodeURIComponent(cleanUrl));
}

function persistedProductImageUrl(accountId, productId, slotKey, extension = "jpg") {
  const ext = safeAssetSegment(extension || "jpg").replace(/[^a-z0-9]/g, "") || "jpg";
  return `/persisted-assets/${encodeURIComponent(accountId || config.accountId)}/${encodeURIComponent(productId || "product")}/${encodeURIComponent(slotKey || "image")}.${ext}`;
}

function parsePersistedAssetPath(pathname = "") {
  const prefix = "/persisted-assets/";
  if (!String(pathname || "").startsWith(prefix)) return null;
  const parts = pathname.slice(prefix.length).split("/");
  if (parts.length !== 3) return null;
  const accountId = decodeURIComponent(parts[0] || "");
  const productId = decodeURIComponent(parts[1] || "");
  const slotFile = decodeURIComponent(parts[2] || "");
  const extension = slotFile.match(/\.([a-z0-9]+)$/i)?.[1] || "jpg";
  const slotKey = slotFile.replace(/\.[a-z0-9]+$/i, "");
  if (!accountId || !productId || !slotKey) return null;
  return { accountId, productId, slotKey, extension };
}

function decodePersistedImageDataUrl(dataUrl = "") {
  const match = String(dataUrl || "").match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[match[1]];
  return {
    mimeType: match[1],
    extension,
    bytes: Buffer.from(match[2].replace(/\s/g, ""), "base64"),
  };
}

async function persistedAssetFromUrl(pathname = "") {
  const parsed = parsePersistedAssetPath(String(pathname || "").split("?")[0]);
  if (!parsed) return null;
  const content = await getTeamContent(parsed.accountId);
  const product = findCatalogProduct(parsed.productId, content.catalog || catalog);
  const saved = product ? persistedProductFlowImage(product, parsed.slotKey) : null;
  const image = decodePersistedImageDataUrl(saved?.dataUrl);
  return image ? { ...image, product, saved, ...parsed } : null;
}

async function materializePersistedAsset(url = "", fallbackAccountId = config.accountId) {
  let asset = await persistedAssetFromUrl(url);
  if (!asset && fallbackAccountId) {
    const parsed = parsePersistedAssetPath(String(url || "").split("?")[0]);
    if (parsed) {
      asset = await persistedAssetFromUrl(persistedProductImageUrl(fallbackAccountId, parsed.productId, parsed.slotKey, parsed.extension));
    }
  }
  if (!asset) return "";
  const accountAssetId = safeAssetSegment(asset.accountId);
  const productAssetId = safeAssetSegment(asset.productId);
  const slot = PRODUCT_FLOW_IMAGE_SLOTS.find((item) => item.key === asset.slotKey);
  const filename = `${slot?.filename || safeAssetSegment(asset.slotKey)}.${asset.extension}`;
  const targetDirectory = path.join(config.assetsDir, accountAssetId, productAssetId);
  await mkdir(targetDirectory, { recursive: true });
  const filePath = path.join(targetDirectory, filename);
  await writeFile(filePath, asset.bytes);
  return filePath;
}

function categoryFromImageName(filename = "", fallback = "") {
  const text = `${filename} ${fallback}`.toLowerCase();
  if (/\b(benefit|result|after|before|claim)\b/.test(text)) return "benefit_claim";
  if (/\b(feature|function|mode|head|usb|recharge|button)\b/.test(text)) return "feature";
  if (/\b(price|package|promo|combo|offer)\b/.test(text)) return "price";
  if (/\b(ingredient|formula|content)\b/.test(text)) return "ingredient";
  if (/\b(usage|how-to|howto|instruction|cara)\b/.test(text)) return "usage";
  if (/\b(warning|caution|avoid|jangan)\b/.test(text)) return "caution";
  if (/\b(delivery|shipping|cod)\b/.test(text)) return "delivery";
  if (/\b(testimonial|review|feedback)\b/.test(text)) return "social_proof";
  return "other";
}

function cleanPendingExtractedFacts(product) {
  const knowledge = ensureProductKnowledge(product);
  const beforePending = knowledge.pending.length;
  const beforeApproved = knowledge.approved.length;
  knowledge.pending = [];
  knowledge.approved = [];
  return {
    removed: beforePending,
    approvedRemoved: beforeApproved,
    remaining: 0,
    pendingImages: knowledge.pendingImages.length,
    approvedImages: knowledge.approvedImages.length,
  };
}

function ensureProductKnowledge(product) {
  product.extracted_knowledge ||= {};
  product.extracted_knowledge.pending = Array.isArray(product.extracted_knowledge.pending)
    ? product.extracted_knowledge.pending
    : [];
  product.extracted_knowledge.approved = Array.isArray(product.extracted_knowledge.approved)
    ? product.extracted_knowledge.approved
    : [];
  product.extracted_knowledge.pendingImages = Array.isArray(product.extracted_knowledge.pendingImages)
    ? product.extracted_knowledge.pendingImages
    : [];
  product.extracted_knowledge.approvedImages = Array.isArray(product.extracted_knowledge.approvedImages)
    ? product.extracted_knowledge.approvedImages
    : [];
  return product.extracted_knowledge;
}

function imageChunkKey(chunk) {
  const source = String(chunk.sourceImageUrl || "").trim().toLowerCase();
  if (source) return source;
  return `${String(chunk.title || "").trim().toLowerCase()}::${String(chunk.summary || chunk.extracted_text || "").trim().toLowerCase()}`;
}

function approveExtractedProductFact(product, factId) {
  const knowledge = ensureProductKnowledge(product);
  const imageIndex = knowledge.pendingImages.findIndex((item) => item.id === factId);
  if (imageIndex >= 0) {
    const [item] = knowledge.pendingImages.splice(imageIndex, 1);
    knowledge.approvedImages.push({ ...item, approvedAt: new Date().toISOString() });
    return { approved: true, factId, kind: "image_chunk" };
  }
  const index = knowledge.pending.findIndex((fact) => fact.id === factId);
  if (index >= 0) {
    const [fact] = knowledge.pending.splice(index, 1);
    knowledge.approved.push({
      ...fact,
      approvedAt: new Date().toISOString(),
    });
    return { approved: true, factId, kind: "fact" };
  }
  throw new Error("Knowledge item not found.");
}

function deleteExtractedProductFact(product, factId, status = "pending") {
  const knowledge = ensureProductKnowledge(product);
  const factListName = status === "approved" ? "approved" : "pending";
  const imageListName = status === "approved" ? "approvedImages" : "pendingImages";
  const beforeFacts = knowledge[factListName].length;
  const beforeImages = knowledge[imageListName].length;
  knowledge[factListName] = knowledge[factListName].filter((fact) => fact.id !== factId);
  knowledge[imageListName] = knowledge[imageListName].filter((item) => item.id !== factId);
  return {
    deleted: beforeFacts !== knowledge[factListName].length || beforeImages !== knowledge[imageListName].length,
    factId,
    status,
  };
}

function orderOptionsForEditor(product) {
  const options = Array.isArray(product.order_options) && product.order_options.length
    ? product.order_options
    : (product.packages || []).map((item) => ({
        id: item.id || "",
        name: item.name || item.id || "",
        price: item.price || "",
        quantity: Number(item.total_units || item.quantity || 1) || 1,
        aliases: [item.id, item.name].filter(Boolean),
        requires_add_on: false,
        add_ons: [],
      }));
  return normalizeOrderOptions(options);
}

function normalizeOrderOptions(options) {
  const list = Array.isArray(options) ? options : [];
  return list
    .map((item, index) => {
      const name = String(item.name || "").trim();
      if (!name) return null;
      const id = safeAssetSegment(item.id || name || `option-${index + 1}`);
      const addOns = normalizeLines(item.add_ons || item.addOns || item.addOnsText);
      const aliases = normalizeLines(item.aliases || item.aliasesText);
      return {
        id,
        name,
        price: String(item.price || "").trim(),
        quantity: Math.max(1, Number(item.quantity || item.total_units || 1) || 1),
        aliases,
        requires_add_on: Boolean(item.requires_add_on || item.requiresAddOn || addOns.length),
        add_ons: addOns,
      };
    })
    .filter(Boolean);
}

function normalizeLines(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildProductOpeningFlow(flow) {
  if (Array.isArray(flow.openingFlowBlocks) && flow.openingFlowBlocks.length) {
    return buildProductOpeningFlowFromBlocks(flow.openingFlowBlocks);
  }
  const images = Object.fromEntries((flow.images || []).map((image) => [image.key, image.url]));
  return [
    textMessage(flow.greeting),
    { type: "image", url: images.infoPhoto1 || "", caption: "" },
    { type: "image", url: images.infoPhoto2 || "", caption: "" },
    { type: "image", url: images.infoPhoto3 || "", caption: "" },
    textMessage(flow.description),
    { type: "image", url: images.testimonialPhoto1 || "", caption: "" },
    { type: "image", url: images.testimonialPhoto2 || "", caption: "" },
    { type: "image", url: images.testimonialPhoto3 || "", caption: "" },
    { type: "image", url: images.testimonialPhoto4 || "", caption: "" },
    textMessage(flow.testimonialText),
    { type: "image", url: images.pricePhoto || "", caption: "" },
    ...(images.salesPhoto ? [{ type: "image", url: images.salesPhoto, caption: "" }] : []),
    textMessage(flow.priceText),
    textMessage(flow.packageQuestion),
  ];
}

function buildProductOpeningFlowFromBlocks(blocks) {
  return normalizeOpeningFlowBlocks(blocks)
    .filter((block) => block.enabled !== false)
    .map((block) => {
      if (block.type === "image") {
        const url = String(block.url || "").trim();
        if (!url) return null;
        return { type: "image", url, caption: String(block.caption || "") };
      }
      const body = String(block.body || "").trim();
      return body ? textMessage(body) : null;
    })
    .filter(Boolean);
}

function safeAssetSegment(value) {
  return String(value || "product").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "product";
}

function createCatalogProduct(name) {
  const baseId = safeAssetSegment(name);
  let id = baseId;
  let suffix = 2;
  while (findCatalogProduct(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  const followupTemplate = catalog.products.find((product) => product.id === catalog.default_product_id)?.followups || {};
  const closingTemplate = catalog.products.find((product) => product.id === catalog.default_product_id)?.order_closing_messages || DEFAULT_ORDER_CLOSING_MESSAGES;
  const emptyFlow = {
    greeting: "",
    description: "",
    testimonialText: "",
    priceText: "",
    packageQuestion: "",
    images: PRODUCT_FLOW_IMAGE_SLOTS.map((slot) => ({ key: slot.key, label: slot.label, url: "" })),
  };
  const product = {
    id,
    name,
    aliases: [name.toLowerCase()],
    sku_code: "",
    price: "",
    stock_status: "preorder",
    shopping_link: "",
    ad_keywords: [name.toLowerCase()],
    packages: [],
    order_options: [],
    order_form: normalizeOrderForm(),
    sales_prompt: "",
    sales_prompt_frequency: 1,
    images: [],
    openingFlowEnabled: false,
    opening_flow_blocks: legacyOpeningFlowBlocks(emptyFlow),
    opening_flow: buildProductOpeningFlow(emptyFlow),
    faqs: [],
    sales_replies: [],
    standard_replies: [],
    followups: structuredClone(followupTemplate),
    order_closing_messages: structuredClone(closingTemplate),
  };
  return product;
}

function normalizeShoppingLink(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    return url.toString();
  } catch {
    throw new Error("Shopping link must be a valid http or https URL.");
  }
}

function normalizeSkuCode(value) {
  return String(value || "").trim().slice(0, 80);
}

function normalizeSalesPromptFrequency(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.max(0, Math.min(20, Math.trunc(number)));
}

function isProductFlowComplete(product) {
  const editorData = productFlowEditorData(product, { skipReady: true });
  if (Array.isArray(product.opening_flow_blocks) && product.opening_flow_blocks.length) {
    const blocks = normalizeOpeningFlowBlocks(product.opening_flow_blocks, editorData).filter((block) => block.enabled !== false);
    return blocks.length > 0 && blocks.every((block) => {
      if (block.type === "image") {
        const url = String(block.url || "").trim();
        return url && localAssetExists(url);
      }
      return Boolean(String(block.body || "").trim());
    });
  }
  const imageByKey = new Map((editorData.images || []).map((image) => [image.key, image.url]));
  return (
    PRODUCT_FLOW_TEXT_SLOTS.every((slot) => String(editorData[slot.key] || "").trim()) &&
    PRODUCT_FLOW_IMAGE_SLOTS
      .filter((slot) => REQUIRED_PRODUCT_FLOW_IMAGE_KEYS.has(slot.key))
      .every((slot) => {
        const url = String(imageByKey.get(slot.key) || "").trim();
        return url && localAssetExists(url);
      })
  );
}

function updateProductFlowReadiness(product) {
  product.openingFlowEnabled = isProductFlowComplete(product);
}

function decodeUploadedImage(dataUrl) {
  return decodePersistedImageDataUrl(dataUrl);
}

function decodeUploadedFollowupMedia(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(String(dataUrl || ""));
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const mediaType = FOLLOWUP_MEDIA_TYPES.get(mimeType);
  if (!mediaType) return null;
  return {
    ...mediaType,
    mimeType,
    bytes: Buffer.from(match[2], "base64"),
  };
}

async function persistCatalog() {
  const contents = `${JSON.stringify(catalog, null, 2)}\n`;
  catalogWriteQueue = catalogWriteQueue.then(() => writeFile(config.catalogPath, contents, "utf8"));
  await catalogWriteQueue;
}

async function persistSalesReplies() {
  const contents = `${JSON.stringify(salesReplyLibrary, null, 2)}\n`;
  await writeFile(config.salesRepliesPath, contents, "utf8");
}

function loginHtml(next, error = "", accountId = config.accountId) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin Login</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Arial, sans-serif; background: #f5f5f7; color: #1d1d1f; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: linear-gradient(180deg, #ffffff 0%, #f5f5f7 100%); }
    main { width: min(390px, calc(100vw - 28px)); background: rgba(255,255,255,.92); border: 1px solid #d2d2d7; border-radius: 8px; padding: 24px; box-shadow: 0 18px 50px rgba(0,0,0,.08); }
    h1 { margin: 0 0 8px; font-size: 24px; font-weight: 700; }
    p { margin: 0 0 18px; color: #6e6e73; }
    label { display: block; font-weight: 700; margin-bottom: 6px; }
    input { width: 100%; box-sizing: border-box; padding: 11px 12px; border: 1px solid #d2d2d7; border-radius: 8px; font: inherit; background: #fff; }
    input:focus { outline: 3px solid rgba(0,113,227,.18); border-color: #0071e3; }
    button { width: 100%; margin-top: 14px; border: 0; border-radius: 8px; padding: 11px; background: #0071e3; color: #fff; font-weight: 700; cursor: pointer; }
    .error { color: #b42318; margin-bottom: 12px; }
    .hint { margin-top: 14px; font-size: 13px; color: #6e6e73; }
  </style>
</head>
<body>
  <main>
    <h1>Admin Login</h1>
    <p>Sign in to view customer data, analytics, and product tools.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/admin/login">
      <input type="hidden" name="next" value="${escapeHtml(next)}" />
      <label for="accountId">Account ID</label>
      <input id="accountId" name="accountId" value="${escapeHtml(accountId)}" autocomplete="username" />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autofocus autocomplete="current-password" />
      <button type="submit">Login</button>
    </form>
    <div class="hint"><a href="/order-admin/login">Order Admin</a> | <a href="/superadmin/login">Super Admin</a></div>
  </main>
</body>
</html>`;
}

function orderAdminLoginHtml(error = "", accountId = "") {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Order Admin Login</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Arial, sans-serif; background: #f5f5f7; color: #1d1d1f; --line: #d2d2d7; --accent: #0071e3; --muted: #6e6e73; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f5f7; }
    main { width: min(410px, calc(100vw - 28px)); background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 24px; box-shadow: 0 12px 38px rgba(0,0,0,.07); }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { margin: 0 0 18px; color: var(--muted); }
    label { display: block; margin: 0 0 7px; font-weight: 700; }
    input { display: block; width: 100%; margin: 0 0 14px; padding: 11px 12px; border: 1px solid var(--line); border-radius: 8px; font: inherit; }
    input:focus { outline: 3px solid rgba(0,113,227,.18); border-color: var(--accent); }
    button { width: 100%; border: 0; border-radius: 8px; padding: 11px; background: var(--accent); color: #fff; font-weight: 700; cursor: pointer; }
    .error { margin: 0 0 12px; color: #b42318; }
    a { display: inline-block; margin-top: 16px; color: var(--accent); text-decoration: none; }
  </style>
</head>
<body>
  <main>
    <h1>Order Admin</h1>
    <p>Process submitted customer orders.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/order-admin/login">
      <label for="accountId">Account ID</label>
      <input id="accountId" name="accountId" value="${escapeHtml(accountId)}" autocomplete="username" />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autofocus autocomplete="current-password" />
      <button type="submit">Login</button>
    </form>
    <a href="/admin/login">Business admin login</a> | <a href="/superadmin/login">Super admin login</a>
  </main>
</body>
</html>`;
}

function orderAdminDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Order Processing</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Arial, sans-serif; color: #1d1d1f; background: #f5f5f7; --surface:#fff; --surface-soft:#fbfbfd; --line:#d2d2d7; --muted:#6e6e73; --accent:#0071e3; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f5f7; }
    header { padding: 16px 22px 10px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); }
    h1 { margin: 0; font-size: 20px; }
    .sub { margin-top: 4px; color: var(--muted); font-size: 13px; }
    nav { display: flex; gap: 8px; flex-wrap: wrap; padding: 10px 22px 14px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); }
    button { border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px; background: var(--surface); color: #1d1d1f; font: inherit; font-weight: 600; cursor: pointer; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button:disabled { opacity: .55; cursor: default; }
    main { padding: 22px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin: 0 0 16px; }
    .metric { border: 1px solid #e5e5ea; border-radius: 8px; padding: 14px; background: var(--surface); }
    .metric strong { display: block; font-size: 25px; margin-bottom: 3px; }
    .metric span { color: var(--muted); font-size: 13px; }
    section { border: 1px solid #e5e5ea; border-radius: 8px; overflow: hidden; background: var(--surface); }
    h2 { margin: 0; padding: 12px 14px; font-size: 16px; background: var(--surface-soft); border-bottom: 1px solid #e5e5ea; }
    .filters { display: flex; gap: 8px; flex-wrap: wrap; padding: 10px 14px; border-bottom: 1px solid #e5e5ea; }
    .filters button.active { background: var(--accent); border-color: var(--accent); color: #fff; }
    .filter-fields { display: flex; gap: 12px; align-items: end; flex-wrap: wrap; padding: 10px 14px; border-bottom: 1px solid #e5e5ea; background: var(--surface-soft); }
    .filter-fields label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .filter-fields select, .filter-fields input { min-width: 180px; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: #fff; color: #1d1d1f; font: inherit; }
    .filter-fields input { min-width: 150px; }
    .filter-fields select:focus, .filter-fields input:focus { outline: 3px solid rgba(0,113,227,.18); border-color: var(--accent); }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 1100px; }
    th, td { padding: 10px 11px; border-bottom: 1px solid #f0f0f2; text-align: left; vertical-align: top; font-size: 13px; }
    th { color: var(--muted); background: var(--surface-soft); font-size: 12px; text-transform: uppercase; }
    .record { margin: 0; white-space: pre-wrap; line-height: 1.4; font: inherit; }
    .shopping-link { display: inline-block; color: var(--accent); font-weight: 600; text-decoration: none; }
    .shopping-link:hover { text-decoration: underline; }
    .muted { color: var(--muted); }
    .pill { display: inline-block; border-radius: 999px; padding: 4px 8px; background: #fff3d8; color: #7b4d00; font-weight: 700; }
    .pill.ack { background: #e8f2ff; color: #075aa8; }
    .pill.done { background: #e6f6e8; color: #176028; }
    .actions { display: grid; gap: 6px; min-width: 190px; }
    .actions select { border: 1px solid var(--line); border-radius: 8px; padding: 8px 9px; background: #fff; font: inherit; }
    .history { margin-top: 7px; color: var(--muted); font-size: 12px; line-height: 1.45; }
    .empty { padding: 16px; color: var(--muted); }
  </style>
</head>
<body>
  <header>
    <h1>Order Processing</h1>
    <div class="sub" id="generated">Loading orders...</div>
  </header>
  <nav>
    <form method="post" action="/order-admin/logout" style="margin:0"><button type="submit">Logout</button></form>
    <button id="refresh" type="button">Refresh</button>
  </nav>
  <main>
    <div class="summary" id="summary"></div>
    <section>
      <h2>Submitted Orders</h2>
      <div class="filters">
        <button class="active" type="button" data-filter="all">All</button>
        <button type="button" data-filter="pending_admin_order">New</button>
        <button type="button" data-filter="reached_warehouse">Warehouse</button>
      </div>
      <div class="filter-fields">
        <label>Business Account<select id="business-filter"><option value="">All Accounts</option></select></label>
        <label>From Date<input id="from-date" type="date" /></label>
        <label>To Date<input id="to-date" type="date" /></label>
        <button id="clear-filters" type="button">Clear</button>
      </div>
      <div class="table-wrap" id="orders"></div>
    </section>
  </main>
  <script>
    let orders = [];
    let activeFilter = "all";
    let activeBusinessAccount = "";
    let fromDate = "";
    let toDate = "";
    const statuses = ${JSON.stringify(ORDER_STATUS_OPTIONS)};
    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, function(ch) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
      });
    }
    function fmt(value) {
      if (!value) return "";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
    }
    function pill(order) {
      return '<span class="pill">' + esc(order.statusDisplay) + '</span>';
    }
    function statusOptions(order) {
      return statuses.map(status => '<option value="' + esc(status.key) + '"' +
        (status.key === order.status ? ' selected' : '') + '>' + esc(status.label) + '</option>').join('');
    }
    function statusHistory(order) {
      const rows = order.statusHistory || [];
      if (!rows.length) return "";
      return '<div class="history">' + rows.slice().reverse().map(item =>
        esc((statuses.find(status => status.key === item.status) || {}).label || item.status) + ' - ' + esc(fmt(item.at))
      ).join('<br>') + '</div>';
    }
    function shoppingLink(value) {
      if (!value) return '<span class="muted">Not set</span>';
      try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") return '<span class="muted">Invalid link</span>';
        return '<a class="shopping-link" target="_blank" rel="noopener noreferrer" href="' + esc(url.href) + '">Open shopping link</a>';
      } catch (error) {
        return '<span class="muted">Invalid link</span>';
      }
    }
    function datePart(value) {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return year + "-" + month + "-" + day;
    }
    function filteredOrders() {
      return orders.filter(order => {
        const submittedDate = datePart(order.createdAt);
        if (activeFilter !== "all" && order.status !== activeFilter) return false;
        if (activeBusinessAccount && order.businessAccountId !== activeBusinessAccount) return false;
        if (fromDate && submittedDate < fromDate) return false;
        if (toDate && submittedDate > toDate) return false;
        return true;
      });
    }
    function render() {
      const rows = filteredOrders();
      const counts = [
        ["Filtered Orders", rows.length],
        ["New", rows.filter(order => order.status === "pending_admin_order").length],
        ["Warehouse", rows.filter(order => order.status === "reached_warehouse").length]
      ];
      document.querySelector("#summary").innerHTML = counts.map(item =>
        '<div class="metric"><strong>' + esc(item[1]) + '</strong><span>' + esc(item[0]) + '</span></div>'
      ).join("");
      if (!rows.length) {
        document.querySelector("#orders").innerHTML = '<div class="empty">No orders in this view.</div>';
        return;
      }
      document.querySelector("#orders").innerHTML = '<table><thead><tr><th>Submitted</th><th>Business Account</th><th>WhatsApp ID</th><th>Order Record</th><th>Shopping Link</th><th>Status History</th><th>Updated</th><th>Change Status</th></tr></thead><tbody>' +
        rows.map(order => '<tr><td>' + esc(fmt(order.createdAt)) + '</td><td>' + esc(order.businessAccountId) + '</td><td>' + esc(order.customerId) + '</td><td><pre class="record">' + esc(order.record) + '</pre></td><td>' + shoppingLink(order.shoppingLink) + '</td><td>' + pill(order) + statusHistory(order) + '</td><td>' + esc(fmt(order.statusUpdatedAt || order.updatedAt)) + '</td><td><div class="actions">' +
          '<select data-status-select="' + esc(order.id) + '">' + statusOptions(order) + '</select>' +
          '<button class="primary" type="button" data-save-status="' + esc(order.id) + '">Update Status</button>' +
        '</div></td></tr>').join("") + '</tbody></table>';
      document.querySelectorAll("button[data-save-status]").forEach(button => button.addEventListener("click", async () => {
        const orderId = button.dataset.saveStatus;
        const value = document.querySelector('select[data-status-select="' + CSS.escape(orderId) + '"]').value;
        await fetch("/order-admin/orders/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: orderId, status: value })
        });
        loadOrders();
      }));
    }
    async function loadOrders() {
      const response = await fetch("/order-admin/orders-data");
      const data = await response.json();
      orders = data.orders || [];
      const accountSelect = document.querySelector("#business-filter");
      const accountIds = [...new Set(orders.map(order => order.businessAccountId).filter(Boolean))].sort();
      accountSelect.innerHTML = '<option value="">All Accounts</option>' +
        accountIds.map(accountId => '<option value="' + esc(accountId) + '">' + esc(accountId) + '</option>').join("");
      accountSelect.value = activeBusinessAccount;
      document.querySelector("#generated").textContent = "Updated " + new Date().toLocaleString();
      render();
    }
    document.querySelectorAll("button[data-filter]").forEach(button => button.addEventListener("click", () => {
      activeFilter = button.dataset.filter;
      document.querySelectorAll("button[data-filter]").forEach(item => item.classList.toggle("active", item === button));
      render();
    }));
    document.querySelector("#business-filter").addEventListener("change", event => {
      activeBusinessAccount = event.target.value;
      render();
    });
    document.querySelector("#from-date").addEventListener("change", event => {
      fromDate = event.target.value;
      render();
    });
    document.querySelector("#to-date").addEventListener("change", event => {
      toDate = event.target.value;
      render();
    });
    document.querySelector("#clear-filters").addEventListener("click", () => {
      activeFilter = "all";
      activeBusinessAccount = "";
      fromDate = "";
      toDate = "";
      document.querySelector("#business-filter").value = "";
      document.querySelector("#from-date").value = "";
      document.querySelector("#to-date").value = "";
      document.querySelectorAll("button[data-filter]").forEach(item => item.classList.toggle("active", item.dataset.filter === "all"));
      render();
    });
    document.querySelector("#refresh").addEventListener("click", loadOrders);
    loadOrders();
    setInterval(loadOrders, 15000);
  </script>
</body>
</html>`;
}

function superAdminLoginHtml(error = "") {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Super Admin Login</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Arial, sans-serif; background: #f5f5f7; color: #1d1d1f; --line: #d2d2d7; --accent: #0071e3; --muted: #6e6e73; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f5f7; }
    main { width: min(410px, calc(100vw - 28px)); background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 24px; box-shadow: 0 12px 38px rgba(0,0,0,.07); }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { margin: 0 0 18px; color: var(--muted); line-height: 1.4; }
    label { display: block; font-weight: 700; margin: 0 0 7px; }
    input { width: 100%; padding: 11px 12px; border: 1px solid var(--line); border-radius: 8px; font: inherit; }
    input:focus { outline: 3px solid rgba(0,113,227,.18); border-color: var(--accent); }
    button { width: 100%; margin-top: 14px; border: 0; border-radius: 8px; padding: 11px; background: var(--accent); color: #fff; font-weight: 700; cursor: pointer; }
    .error { margin-bottom: 12px; color: #b42318; }
    a { display: inline-block; margin-top: 16px; color: var(--accent); text-decoration: none; }
  </style>
</head>
<body>
  <main>
    <h1>Super Admin</h1>
    <p>Manage access for business and order admin accounts.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/superadmin/login">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autofocus autocomplete="current-password" />
      <button type="submit">Sign In</button>
    </form>
    <a href="/admin/login">Business admin login</a> | <a href="/order-admin/login">Order admin login</a>
  </main>
</body>
</html>`;
}

function superAdminAccountsHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Account Management</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Arial, sans-serif; color: #1d1d1f; background: #f5f5f7; --surface: #fff; --surface-soft: #fbfbfd; --line: #d2d2d7; --muted: #6e6e73; --accent: #0071e3; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f5f7; }
    header { padding: 16px 22px 10px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); }
    h1 { margin: 0; font-size: 20px; }
    .sub { margin-top: 4px; min-height: 18px; color: var(--muted); font-size: 13px; }
    nav { display: flex; gap: 8px; flex-wrap: wrap; padding: 10px 22px 14px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); }
    button, nav a { border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px; background: var(--surface); color: #1d1d1f; font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.danger { color: #b42318; }
    button:disabled { opacity: .55; cursor: wait; }
    main { padding: 22px; max-width: 1160px; margin: 0 auto; display: grid; gap: 14px; }
    section { background: var(--surface); border: 1px solid #e5e5ea; border-radius: 8px; overflow: hidden; }
    h2 { margin: 0; padding: 12px 14px; font-size: 16px; background: var(--surface-soft); border-bottom: 1px solid #e5e5ea; }
    form.fields { padding: 14px; display: grid; grid-template-columns: repeat(4, minmax(140px, 1fr)) auto; gap: 10px; align-items: end; }
    label { display: grid; gap: 7px; color: #1d1d1f; font-size: 13px; font-weight: 700; }
    input, select { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; font: inherit; background: #fff; }
    input:focus, select:focus { outline: 3px solid rgba(0,113,227,.18); border-color: var(--accent); }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 700px; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #f0f0f2; text-align: left; vertical-align: middle; font-size: 13px; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; background: var(--surface-soft); }
    .pill { display: inline-block; padding: 4px 8px; border-radius: 999px; font-weight: 700; background: #e6f6e8; color: #176028; }
    .pill.off { background: #ffe9e7; color: #8f1d12; }
    .row-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    #reset-panel { display: none; }
    #reset-panel.open { display: block; }
    .message { padding: 0 14px 14px; color: var(--muted); font-size: 13px; min-height: 18px; }
    @media (max-width: 760px) { form.fields { grid-template-columns: 1fr; } main { padding: 14px; } }
  </style>
</head>
<body>
  <header>
    <h1>Account Management</h1>
    <div class="sub" id="generated">Loading accounts...</div>
  </header>
  <nav>
    <a href="/superadmin/system">System Management</a>
    <a href="/admin/dashboard">Business Dashboard</a>
    <form method="post" action="/superadmin/logout" style="margin:0"><button type="submit">Logout</button></form>
    <button id="refresh" type="button">Refresh</button>
  </nav>
  <main>
    <section>
      <h2>Create Account</h2>
      <form class="fields" id="create-form">
        <label>Account ID<input name="id" required /></label>
        <label>Business Name<input name="name" required /></label>
        <label>Role<select name="role"><option value="business_admin">Business Admin</option><option value="order_admin">Order Admin</option></select></label>
        <label>Temporary Password<input name="password" type="password" minlength="10" required autocomplete="new-password" /></label>
        <button class="primary" type="submit">Create</button>
      </form>
      <div class="message" id="create-message"></div>
    </section>
    <section id="reset-panel">
      <h2>Reset Password</h2>
      <form class="fields" id="reset-form">
        <label>Account ID<input id="reset-id" name="id" readonly /></label>
        <label>New Password<input name="password" type="password" minlength="10" required autocomplete="new-password" /></label>
        <button class="primary" type="submit">Save Password</button>
        <button id="cancel-reset" type="button">Cancel</button>
      </form>
      <div class="message" id="reset-message"></div>
    </section>
    <section>
      <h2>Accounts</h2>
      <div class="table-wrap" id="accounts"></div>
    </section>
  </main>
  <script>
    let accounts = [];
    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, function(ch) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
      });
    }
    function fmt(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
    }
    async function request(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Action failed.");
      return data;
    }
    async function loadAccounts() {
      const response = await fetch("/superadmin/accounts-data");
      const data = await response.json();
      accounts = data.accounts || [];
      document.querySelector("#generated").textContent = accounts.length + " account(s)";
      document.querySelector("#accounts").innerHTML = '<table><thead><tr><th>Account ID</th><th>Name</th><th>Role</th><th>Status</th><th>Updated</th><th>Actions</th></tr></thead><tbody>' +
        accounts.map(account => '<tr><td>' + esc(account.id) + '</td><td>' + esc(account.name) + '</td><td>' + esc(account.role === "order_admin" ? "Order Admin" : "Business Admin") + '</td><td><span class="pill' + (account.active ? '' : ' off') + '">' + (account.active ? 'Active' : 'Disabled') + '</span></td><td>' + esc(fmt(account.updatedAt)) + '</td><td><div class="row-actions"><button type="button" data-reset="' + esc(account.id) + '">Reset Password</button><button class="' + (account.active ? 'danger' : '') + '" type="button" data-status="' + esc(account.id) + '" data-active="' + (!account.active) + '">' + (account.active ? 'Disable' : 'Enable') + '</button></div></td></tr>').join('') +
        '</tbody></table>';
      document.querySelectorAll("button[data-reset]").forEach(button => button.addEventListener("click", () => {
        document.querySelector("#reset-id").value = button.dataset.reset;
        document.querySelector("#reset-panel").classList.add("open");
      }));
      document.querySelectorAll("button[data-status]").forEach(button => button.addEventListener("click", async () => {
        await request("/superadmin/accounts/status", { id: button.dataset.status, active: button.dataset.active === "true" });
        loadAccounts();
      }));
    }
    document.querySelector("#create-form").addEventListener("submit", async event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.target).entries());
      try {
        await request("/superadmin/accounts/create", values);
        event.target.reset();
        document.querySelector("#create-message").textContent = "Account created.";
        loadAccounts();
      } catch (error) {
        document.querySelector("#create-message").textContent = error.message;
      }
    });
    document.querySelector("#reset-form").addEventListener("submit", async event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.target).entries());
      try {
        await request("/superadmin/accounts/password", values);
        event.target.reset();
        document.querySelector("#reset-panel").classList.remove("open");
        document.querySelector("#reset-message").textContent = "";
        loadAccounts();
      } catch (error) {
        document.querySelector("#reset-message").textContent = error.message;
      }
    });
    document.querySelector("#cancel-reset").addEventListener("click", () => document.querySelector("#reset-panel").classList.remove("open"));
    document.querySelector("#refresh").addEventListener("click", loadAccounts);
    loadAccounts();
  </script>
</body>
</html>`;
}

function superAdminSystemHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>System Management</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Arial, sans-serif; color: #1d1d1f; background: #f5f5f7; --surface: #fff; --surface-soft: #fbfbfd; --line: #d2d2d7; --muted: #6e6e73; --accent: #0071e3; --green: #176028; --amber: #7b4d00; --red: #b42318; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f5f7; }
    header { padding: 16px 22px 10px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); }
    h1 { margin: 0; font-size: 20px; }
    .sub { margin-top: 4px; color: var(--muted); font-size: 13px; }
    nav { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 22px 14px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); }
    button, nav a, .download { border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px; background: var(--surface); color: #1d1d1f; font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; }
    button.primary, .download { background: var(--accent); color: #fff; border-color: var(--accent); }
    button.warn { color: var(--red); }
    button:disabled { opacity: .55; cursor: wait; }
    main { max-width: 1280px; margin: 0 auto; padding: 22px; display: grid; gap: 14px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
    .metric { background: var(--surface); border: 1px solid #e5e5ea; border-radius: 8px; padding: 14px; }
    .metric strong { display: block; font-size: 25px; margin-bottom: 4px; }
    .metric span { color: var(--muted); font-size: 13px; }
    section { background: var(--surface); border: 1px solid #e5e5ea; border-radius: 8px; overflow: hidden; }
    h2 { margin: 0; padding: 12px 14px; font-size: 16px; background: var(--surface-soft); border-bottom: 1px solid #e5e5ea; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; padding: 14px; }
    .settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px; padding: 14px; max-width: 980px; }
    .settings-grid label { display: grid; gap: 7px; font-size: 13px; font-weight: 700; }
    .settings-grid input, .settings-grid select { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; font: inherit; background: #fff; min-width: 0; }
    .settings-help { grid-column: 1 / -1; color: var(--muted); font-size: 13px; line-height: 1.38; }
    .settings-secret { display: block; color: var(--muted); font-size: 12px; font-weight: 600; }
    #team-settings-state { color: var(--muted); font-size: 13px; }
    label { display: grid; gap: 7px; font-size: 13px; font-weight: 700; }
    input, textarea { border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; font: inherit; background: #fff; }
    textarea { min-width: min(420px, 86vw); min-height: 42px; resize: vertical; }
    input:focus, textarea:focus { outline: 3px solid rgba(0,113,227,.18); border-color: var(--accent); }
    .message { padding: 0 14px 14px; min-height: 18px; color: var(--muted); font-size: 13px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 720px; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #f0f0f2; vertical-align: top; text-align: left; font-size: 13px; }
    th { background: var(--surface-soft); color: var(--muted); text-transform: uppercase; font-size: 12px; }
    .pill { display: inline-block; border-radius: 999px; padding: 4px 8px; font-weight: 700; background: #e6f6e8; color: var(--green); }
    .pill.test { background: #e8f2ff; color: #075aa8; }
    .pill.pause, .pill.pending { background: #fff3d8; color: var(--amber); }
    .pill.fail { background: #ffe9e7; color: var(--red); }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .record { white-space: pre-wrap; word-break: break-word; max-width: 470px; margin: 0; line-height: 1.42; }
    .empty { padding: 16px; color: var(--muted); }
    .backup { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; padding: 14px; color: var(--muted); font-size: 13px; }
    @media (max-width: 760px) { main { padding: 14px; } .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } textarea { min-width: 100%; } }
  </style>
</head>
<body>
  <header>
    <h1>System Management</h1>
    <div class="sub" id="generated">Loading system status...</div>
  </header>
  <nav>
    <a href="/superadmin/accounts">Accounts</a>
    <a href="/admin/dashboard">Business Dashboard</a>
    <form method="post" action="/superadmin/logout" style="margin:0"><button type="submit">Logout</button></form>
    <button id="refresh" type="button">Refresh</button>
  </nav>
  <main>
    <div class="summary" id="summary"></div>
    <section>
      <h2>Release Record</h2>
      <form class="toolbar" id="release-form">
        <label>System Version<input name="version" required /></label>
        <label>Update Notes<textarea name="notes" placeholder="What changed in this release"></textarea></label>
        <button class="primary" type="submit">Record Update</button>
      </form>
      <div class="message" id="release-message"></div>
    </section>
    <section>
      <h2>Business AI Controls</h2>
      <div class="table-wrap" id="controls"></div>
    </section>
    <section>
      <h2>Team Settings</h2>
      <form id="team-settings-form" class="settings-grid">
        <div class="settings-help">Super Admin setup for each business team. Leave credential fields blank to keep the existing saved value.</div>
        <label for="team-account-id">Business Account
          <select id="team-account-id" name="id"></select>
        </label>
        <label for="team-public-base-url">Public Base URL
          <input id="team-public-base-url" name="publicBaseUrl" placeholder="https://agent.example.com" />
        </label>
        <label for="team-assets-base-url">Assets Base URL
          <input id="team-assets-base-url" name="assetsBaseUrl" placeholder="https://cdn.example.com" />
        </label>
        <label for="team-phone-number-id">WhatsApp Phone Number ID
          <input id="team-phone-number-id" name="whatsappPhoneNumberId" autocomplete="off" placeholder="Leave blank to keep current" />
          <span class="settings-secret" id="team-phone-number-id-current"></span>
        </label>
        <label for="team-access-token">WhatsApp Access Token
          <input id="team-access-token" name="whatsappAccessToken" type="password" autocomplete="new-password" placeholder="Leave blank to keep current" />
          <span class="settings-secret" id="team-access-token-current"></span>
        </label>
        <label for="team-openai-api-key">OpenAI API Key
          <input id="team-openai-api-key" name="openaiApiKey" type="password" autocomplete="new-password" placeholder="Leave blank to keep current" />
          <span class="settings-secret" id="team-openai-api-key-current"></span>
        </label>
        <label for="team-vector-store-id">Approved Knowledge Vector Store ID
          <input id="team-vector-store-id" name="openaiVectorStoreId" placeholder="vs_..." />
        </label>
        <label for="team-openai-model">OpenAI Reply Model
          <select id="team-openai-model" name="openaiModel">
            <option value="">Use Railway default (${escapeHtml(config.openaiModel)})</option>
            <option value="gpt-5">GPT-5</option>
            <option value="gpt-5.4-mini">GPT-5.4 mini</option>
          </select>
        </label>
        <div class="actions">
          <button class="primary" type="submit">Save Team Settings</button>
          <span id="team-settings-state"></span>
        </div>
      </form>
    </section>
    <section>
      <h2>Failed Message Queue</h2>
      <div class="table-wrap" id="failed"></div>
    </section>
    <section>
      <h2>Error Log</h2>
      <div class="table-wrap" id="errors"></div>
    </section>
    <section>
      <h2>Change History</h2>
      <div class="table-wrap" id="history"></div>
    </section>
    <section>
      <h2>Backup Export</h2>
      <div class="backup">
        <a class="download" href="/superadmin/system/backup">Export JSON Backup</a>
        <span>Includes operational records, customers, orders, and message history. Password hashes and API secrets are excluded.</span>
      </div>
    </section>
  </main>
  <script>
    let data = null;
    let selectedTeamSettingsAccount = "";
    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, function(ch) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
      });
    }
    function fmt(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
    }
    async function request(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Action failed.");
      return result;
    }
    function mode(account) {
      if (account.automationPaused) return ["Paused", "pause"];
      if (account.testMode) return ["Test Mode", "test"];
      return ["Live", ""];
    }
    function retryStatus(message) {
      if (message.status === "retried") return ["Retried", ""];
      if (message.status === "retry_failed") return ["Retry Failed", "fail"];
      return ["Pending Retry", "pending"];
    }
    function currentTeamSettingsAccount() {
      const accounts = data ? data.accounts || [] : [];
      return accounts.find(account => account.id === selectedTeamSettingsAccount) || accounts[0] || null;
    }
    function renderTeamSettings(force = false) {
      const form = document.querySelector("#team-settings-form");
      if (!force && form.contains(document.activeElement)) return;
      const accounts = data ? data.accounts || [] : [];
      const select = document.querySelector("#team-account-id");
      if (!selectedTeamSettingsAccount && accounts[0]) selectedTeamSettingsAccount = accounts[0].id;
      select.innerHTML = accounts.map(account =>
        '<option value="' + esc(account.id) + '">' + esc(account.name || account.id) + ' (' + esc(account.id) + ')</option>'
      ).join("");
      select.value = selectedTeamSettingsAccount;
      const account = currentTeamSettingsAccount();
      const settings = account ? account.settings || {} : {};
      document.querySelector("#team-public-base-url").value = settings.publicBaseUrl || "";
      document.querySelector("#team-assets-base-url").value = settings.assetsBaseUrl || "";
      document.querySelector("#team-phone-number-id").value = "";
      document.querySelector("#team-access-token").value = "";
      document.querySelector("#team-openai-api-key").value = "";
      document.querySelector("#team-vector-store-id").value = settings.openaiVectorStoreId || "";
      document.querySelector("#team-openai-model").value = settings.openaiModel || "";
      document.querySelector("#team-phone-number-id-current").textContent =
        settings.whatsappPhoneNumberId ? "Current: " + settings.whatsappPhoneNumberId : "No team-specific phone number ID saved.";
      document.querySelector("#team-access-token-current").textContent =
        settings.whatsappAccessToken ? "Current: " + settings.whatsappAccessToken : "No team-specific access token saved.";
      document.querySelector("#team-openai-api-key-current").textContent =
        settings.openaiApiKey ? "Current: " + settings.openaiApiKey : "No team-specific OpenAI API key saved. Railway default will be used.";
    }
    async function saveTeamSettings(event) {
      event.preventDefault();
      const state = document.querySelector("#team-settings-state");
      const publicBaseUrl = normalizeDashboardUrl(document.querySelector("#team-public-base-url").value || window.location.origin);
      const assetsBaseUrl = normalizeDashboardUrl(document.querySelector("#team-assets-base-url").value || publicBaseUrl);
      if (!publicBaseUrl || !assetsBaseUrl) {
        state.textContent = "Public Base URL and Assets Base URL must be valid http/https URLs.";
        return;
      }
      const settings = {
        publicBaseUrl,
        assetsBaseUrl,
        openaiVectorStoreId: document.querySelector("#team-vector-store-id").value,
        openaiModel: document.querySelector("#team-openai-model").value
      };
      const phoneNumberId = document.querySelector("#team-phone-number-id").value.trim();
      const accessToken = document.querySelector("#team-access-token").value.trim();
      const openaiApiKey = document.querySelector("#team-openai-api-key").value.trim();
      if (phoneNumberId) settings.whatsappPhoneNumberId = phoneNumberId;
      if (accessToken) settings.whatsappAccessToken = accessToken;
      if (openaiApiKey) settings.openaiApiKey = openaiApiKey;
      state.textContent = "Saving...";
      try {
        const result = await request("/superadmin/system/team-settings", {
          id: document.querySelector("#team-account-id").value,
          settings
        });
        data.accounts = (data.accounts || []).map(account => account.id === result.account.id ? result.account : account);
        selectedTeamSettingsAccount = result.account.id;
        renderTeamSettings(true);
        state.textContent = "Saved";
      } catch (error) {
        state.textContent = error.message;
      }
    }
    function normalizeDashboardUrl(value) {
      const text = String(value || "").trim();
      if (!text) return "";
      try {
        const url = new URL(text);
        if (url.protocol !== "http:" && url.protocol !== "https:") return "";
        return url.toString().replace(/\\/$/, "");
      } catch {
        return "";
      }
    }
    function render() {
      const pending = data.failedMessages.filter(item => item.status !== "retried").length;
      const figures = [
        [data.state.version || "-", "System Version"],
        [fmt(data.state.lastUpdatedAt) || "-", "Last Update"],
        [pending, "Messages Need Retry"],
        [data.queuedFollowupCount || 0, "Followups Queued"],
        [data.errors.length, "Recorded Errors"]
      ];
      document.querySelector("#summary").innerHTML = figures.map(item =>
        '<div class="metric"><strong>' + esc(item[0]) + '</strong><span>' + esc(item[1]) + '</span></div>'
      ).join("");

      const accounts = data.accounts || [];
      document.querySelector("#controls").innerHTML = accounts.length ? '<table><thead><tr><th>Account</th><th>Login</th><th>AI Mode</th><th>Last Updated</th><th>Action</th></tr></thead><tbody>' +
        accounts.map(account => {
          const accountMode = mode(account);
          return '<tr><td><strong>' + esc(account.name) + '</strong><br>' + esc(account.id) + '</td><td>' + (account.active ? 'Enabled' : 'Disabled') + '</td><td><span class="pill ' + accountMode[1] + '">' + accountMode[0] + '</span></td><td>' + esc(fmt(account.updatedAt)) + '</td><td><div class="actions"><button class="' + (account.automationPaused ? '' : 'warn') + '" type="button" data-id="' + esc(account.id) + '" data-pause="' + (!account.automationPaused) + '" data-test="' + account.testMode + '">' + (account.automationPaused ? 'Resume AI' : 'Pause AI') + '</button><button type="button" data-id="' + esc(account.id) + '" data-pause="false" data-test="' + (!account.testMode) + '">' + (account.testMode ? 'Return Live' : 'Test Mode') + '</button></div></td></tr>';
        }).join("") + '</tbody></table>' : '<div class="empty">No business accounts found.</div>';

      const failed = data.failedMessages || [];
      document.querySelector("#failed").innerHTML = failed.length ? '<table><thead><tr><th>Time</th><th>Account</th><th>Recipient</th><th>Message</th><th>Status</th><th>Action</th></tr></thead><tbody>' +
        failed.map(item => {
          const status = retryStatus(item);
          const body = (item.messages || []).map(message => message.body || message.caption || message.url || message.type).join("\\n");
          return '<tr><td>' + esc(fmt(item.createdAt)) + '</td><td>' + esc(item.businessAccountId) + '</td><td>' + esc(item.to) + '</td><td><pre class="record">' + esc(body) + '</pre><small>' + esc(item.lastError) + '</small></td><td><span class="pill ' + status[1] + '">' + status[0] + '</span><br>Attempts: ' + esc(item.attempts) + '</td><td><button class="primary" type="button" data-retry="' + esc(item.id) + '"' + (item.status === "retried" ? ' disabled' : '') + '>Retry</button></td></tr>';
        }).join("") + '</tbody></table>' : '<div class="empty">No failed outbound messages recorded.</div>';

      const errors = data.errors || [];
      document.querySelector("#errors").innerHTML = errors.length ? '<table><thead><tr><th>Time</th><th>Area</th><th>Account</th><th>Error</th></tr></thead><tbody>' +
        errors.slice(0, 50).map(error => '<tr><td>' + esc(fmt(error.createdAt)) + '</td><td>' + esc(error.scope) + '</td><td>' + esc(error.accountId) + '</td><td><pre class="record">' + esc(error.message + (error.details ? "\\n" + error.details : "")) + '</pre></td></tr>').join("") +
        '</tbody></table>' : '<div class="empty">No operational errors recorded.</div>';

      const audits = data.audits || [];
      document.querySelector("#history").innerHTML = audits.length ? '<table><thead><tr><th>Time</th><th>Actor</th><th>Change</th><th>Result</th></tr></thead><tbody>' +
        audits.slice(0, 50).map(item => '<tr><td>' + esc(fmt(item.createdAt)) + '</td><td>' + esc(item.actor) + '</td><td>' + esc(item.action) + '</td><td>' + esc(item.result || "") + '</td></tr>').join("") +
        '</tbody></table>' : '<div class="empty">No change history recorded.</div>';
      renderTeamSettings();

      document.querySelectorAll("button[data-id][data-pause]").forEach(button => button.addEventListener("click", async () => {
        await request("/superadmin/system/account-control", {
          id: button.dataset.id,
          automationPaused: button.dataset.pause === "true",
          testMode: button.dataset.test === "true"
        });
        load();
      }));
      document.querySelectorAll("button[data-retry]").forEach(button => button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await request("/superadmin/system/retry-message", { id: button.dataset.retry });
        } catch (error) {
          window.alert(error.message);
        }
        load();
      }));
    }
    async function load() {
      const response = await fetch("/superadmin/system-data");
      data = await response.json();
      document.querySelector("#generated").textContent = "Updated " + new Date().toLocaleString();
      const versionInput = document.querySelector("#release-form input[name=version]");
      if (!versionInput.value) versionInput.value = data.state.version || "";
      render();
    }
    document.querySelector("#release-form").addEventListener("submit", async event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.target).entries());
      try {
        await request("/superadmin/system/release", values);
        document.querySelector("#release-message").textContent = "System update recorded.";
        load();
      } catch (error) {
        document.querySelector("#release-message").textContent = error.message;
      }
    });
    document.querySelector("#team-account-id").addEventListener("change", event => {
      selectedTeamSettingsAccount = event.target.value;
      renderTeamSettings(true);
    });
    document.querySelector("#team-settings-form").addEventListener("submit", saveTeamSettings);
    document.querySelector("#refresh").addEventListener("click", load);
    load();
    setInterval(load, 15000);
  </script>
</body>
</html>`;
}

function adminDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI Agent Monitor</title>
  <style>
    :root {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Arial, sans-serif;
      color: #1d1d1f;
      background: #f5f5f7;
      --surface: #ffffff;
      --surface-soft: #fbfbfd;
      --line: #d2d2d7;
      --muted: #6e6e73;
      --accent: #0071e3;
      --accent-soft: #e8f2ff;
    }
    body {
      margin: 0;
      background: #f5f5f7;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 5;
      padding: 16px 22px 10px;
      background: rgba(251,251,253,.9);
      color: #1d1d1f;
      border-bottom: 1px solid rgba(210,210,215,.8);
      backdrop-filter: saturate(180%) blur(16px);
    }
    .dashboard-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
    }
    h1 {
      margin: 0;
      font-size: 20px;
    }
    .sub {
      margin-top: 4px;
      color: var(--muted);
      font-size: 13px;
    }
    .dashboard-date-panel {
      min-width: 260px;
      padding: 10px 12px;
      border: 1px solid rgba(210,210,215,.9);
      border-radius: 12px;
      background: #fff;
      text-align: right;
      box-shadow: 0 1px 2px rgba(0,0,0,.03);
    }
    .today-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .today-date {
      margin-top: 2px;
      font-size: 24px;
      font-weight: 800;
      line-height: 1.15;
    }
    .dashboard-date-panel label {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
    }
    .dashboard-date-panel input {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 7px 9px;
      font: inherit;
      background: #fff;
      color: #1d1d1f;
    }
    nav {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 10px 22px 14px;
      background: rgba(251,251,253,.9);
      border-bottom: 1px solid rgba(210,210,215,.8);
      backdrop-filter: saturate(180%) blur(16px);
    }
    nav a, button {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 11px;
      background: var(--surface);
      color: #1d1d1f;
      text-decoration: none;
      font-weight: 600;
      cursor: pointer;
    }
    nav a:hover, button:hover { border-color: #a8a8ad; }
    #profile-nav.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .bulkbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: #fff;
      border-bottom: 1px solid #e5e5ea;
    }
    .bulkbar .muted {
      margin-right: auto;
      font-size: 13px;
    }
    .bulk-select-cell {
      width: 42px;
      text-align: center;
    }
    .bulk-select-cell input {
      width: 16px;
      height: 16px;
    }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0 0 14px;
    }
    .tab {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px 12px;
      background: var(--surface);
      color: #1d1d1f;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 7px;
    }
    .tab.active {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .tab-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 22px;
      height: 22px;
      padding: 0 7px;
      border-radius: 999px;
      background: #f5f5f7;
      color: #1d1d1f;
      font-size: 12px;
      font-weight: 800;
      line-height: 1;
    }
    .tab.active .tab-count {
      background: rgba(255,255,255,.22);
      color: #fff;
    }
    .tab-count.soft {
      background: #fff3d8;
      color: #7b4d00;
    }
    .tab.active .tab-count.soft {
      background: rgba(255,255,255,.26);
      color: #fff;
    }
    .subtabs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 12px 14px;
      background: var(--surface-soft);
      border-bottom: 1px solid #e5e5ea;
    }
    .subtab {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 6px 10px;
      background: var(--surface);
      color: #1d1d1f;
      font-weight: 600;
      cursor: pointer;
      font-size: 12px;
    }
    .subtab.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    main {
      padding: 22px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }
    main.profile-only .summary,
    main.profile-only .tabs {
      display: none;
    }
    .metric {
      background: var(--surface);
      border: 1px solid #e5e5ea;
      border-radius: 8px;
      padding: 14px;
      box-shadow: 0 1px 2px rgba(0,0,0,.03);
    }
    .metric strong {
      display: block;
      font-size: 24px;
      margin-bottom: 3px;
    }
    section {
      margin: 0 0 22px;
      background: #fff;
      border: 1px solid #e5e5ea;
      border-radius: 8px;
      overflow: hidden;
    }
    section.panel {
      display: none;
    }
    section.panel.active {
      display: block;
    }
    h2 {
      margin: 0;
      padding: 12px 14px;
      font-size: 16px;
      background: var(--surface-soft);
      border-bottom: 1px solid #e5e5ea;
    }
    .table-wrap {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 860px;
    }
    th, td {
      padding: 9px 10px;
      border-bottom: 1px solid #f0f0f2;
      text-align: left;
      vertical-align: top;
      font-size: 13px;
    }
    th {
      background: var(--surface-soft);
      color: #6e6e73;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .pill {
      display: inline-block;
      border-radius: 999px;
      padding: 3px 8px;
      background: #f5f5f7;
      color: #1d1d1f;
      font-weight: 700;
      white-space: nowrap;
    }
    .danger {
      background: #ffe9e7;
      color: #8f1d12;
    }
    .warn {
      background: #fff3d8;
      color: #7b4d00;
    }
    .ok {
      background: #e6f6e8;
      color: #176028;
    }
    .muted {
      color: var(--muted);
    }
    .empty {
      padding: 14px;
      color: var(--muted);
    }
    .note {
      margin: 0;
      padding: 10px 14px;
      color: #6e6e73;
      background: #fff8e8;
      border-bottom: 1px solid #f5dfaa;
      font-size: 13px;
    }
    .filterbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: var(--surface-soft);
      border-bottom: 1px solid #e5e5ea;
    }
    .filterbar label {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: #1d1d1f;
      font-size: 13px;
      font-weight: 700;
    }
    .filterbar input, .filterbar select {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 7px 9px;
      font: inherit;
    }
    .profile-form {
      display: grid;
      gap: 14px;
      max-width: 560px;
      padding: 16px;
    }
    .profile-form label {
      display: grid;
      gap: 6px;
      font-size: 13px;
      font-weight: 800;
    }
    .profile-form input, .profile-form textarea {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px 10px;
      font: inherit;
      background: #fff;
    }
    .profile-form textarea {
      min-height: 110px;
      resize: vertical;
      line-height: 1.38;
    }
    .profile-form input[type="color"] {
      width: 88px;
      height: 44px;
      padding: 4px;
    }
    .profile-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    #profile-state {
      color: var(--muted);
      font-size: 13px;
    }
    .followup-settings {
      padding: 14px;
      border-bottom: 1px solid #e5e5ea;
      background: var(--surface-soft);
    }
    .followup-settings h3 { margin: 0 0 6px; font-size: 14px; }
    .followup-editor-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 10px;
      margin-top: 12px;
    }
    .followup-message-card {
      display: grid;
      gap: 8px;
      padding: 12px;
      border: 1px solid #e5e5ea;
      border-radius: 8px;
      background: #fff;
    }
    .followup-message-card label {
      display: grid;
      gap: 5px;
      font-size: 12px;
      font-weight: 800;
    }
    .followup-message-card textarea {
      min-height: 96px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px 10px;
      font: inherit;
      line-height: 1.38;
      background: #fff;
    }
    .followup-message-card input {
      width: 110px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 7px 9px;
      font: inherit;
    }
    #followup-settings-state { color: var(--muted); font-size: 12px; }
    @media (max-width: 800px) {
      .dashboard-header-row { align-items: stretch; flex-direction: column; }
      .dashboard-date-panel { min-width: 0; text-align: left; }
      .dashboard-date-panel label { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <header>
    <div class="dashboard-header-row">
      <div>
        <h1 id="dashboard-title">AI Agent Monitor</h1>
      </div>
      <div class="dashboard-date-panel">
        <div class="today-label">Today</div>
        <div class="today-date" id="today-date">Loading...</div>
        <label for="dashboard-date">Dashboard Date <input id="dashboard-date" type="date" /></label>
      </div>
    </div>
  </header>
  <nav>
    <a href="/admin/dashboard">Dashboard</a>
    <a href="/admin/chat">Chat Inbox</a>
    <a href="/admin/whatsapp-web">WhatsApp Web</a>
    <a href="/admin/analytics">Analytics</a>
    <a href="/admin/reply-library">Reply Library</a>
    <a href="/admin/product-flow">Product Flow</a>
    <a href="/admin/follow-up-settings">Follow-Up Settings</a>
    <a href="/admin/compliance">Compliance</a>
    <a href="/demo/chat">Customer Demo</a>
    <button id="refresh" type="button">Refresh</button>
    <button id="profile-nav" type="button">Profile</button>
  </nav>
  <main>
    <div class="summary" id="summary"></div>
    <div class="tabs" role="tablist" aria-label="Dashboard sections">
      <button class="tab active" type="button" data-tab="customers">Customers</button>
      <button class="tab" type="button" data-tab="order-customers">Customer List</button>
      <button class="tab" type="button" data-tab="another-date-purchase">Another Date Purchase</button>
      <button class="tab" type="button" data-tab="handoff">Handoff</button>
      <button class="tab" type="button" data-tab="orders">Orders</button>
      <button class="tab" type="button" data-tab="followups">Follow-ups</button>
      <button class="tab" type="button" data-tab="deleted">Deleted</button>
    </div>
    <section id="customers" class="panel active">
      <h2>Customer List</h2>
      <div class="filterbar">
        <label for="customer-sku-filter">SKU <select id="customer-sku-filter"></select></label>
        <label for="customer-phone-search">Phone <input id="customer-phone-search" type="search" placeholder="Search phone number" /></label>
        <label for="customer-last-message-date">Latest Message Date <input id="customer-last-message-date" type="date" /></label>
        <label for="customer-last-message-sort">Latest Message <select id="customer-last-message-sort">
          <option value="desc">Newest first</option>
          <option value="asc">Oldest first</option>
        </select></label>
        <button id="customer-last-message-all" type="button">All Dates</button>
      </div>
      <div class="subtabs" id="customer-label-tabs"></div>
      <div class="table-wrap"></div>
    </section>
    <section id="order-customers" class="panel">
      <h2>Submitted Order Customers</h2>
      <div class="filterbar">
        <label for="order-customers-date">Date <input id="order-customers-date" type="date" /></label>
        <label for="order-customers-sku-filter">SKU <select id="order-customers-sku-filter"></select></label>
        <button id="order-customers-all" type="button">All Dates</button>
        <span class="muted" id="order-customers-count"></span>
      </div>
      <div class="table-wrap"></div>
    </section>
    <section id="another-date-purchase" class="panel">
      <h2>Another Date Purchase</h2>
      <p class="note">Customers who said they plan to buy on another date. These customers are paused from normal follow-ups and use the special another-date follow-up setting.</p>
      <div class="table-wrap"></div>
    </section>
    <section id="handoff" class="panel">
      <h2>Handoff Queue</h2>
      <div class="filterbar">
        <label for="handoff-date">Date <input id="handoff-date" type="date" /></label>
        <button id="handoff-all" type="button">All Dates</button>
      </div>
      <div class="table-wrap"></div>
    </section>
    <section id="orders" class="panel">
      <h2>Orders Table</h2>
      <div class="filterbar">
        <label for="orders-date">Date <input id="orders-date" type="date" /></label>
        <button id="orders-all" type="button">All Dates</button>
      </div>
      <div class="table-wrap"></div>
    </section>
    <section id="followups" class="panel">
      <h2>Follow-Up Monitor</h2>
      <p class="note">Follow-ups continue until the customer submits order details, opts out, or has an unresolved complaint. Due follow-ups are queued, rotated by stage, delayed ${escapeHtml(Math.round(config.followupSendDelayMinMs / 1000))}-${escapeHtml(Math.round(config.followupSendDelayMaxMs / 1000))} second(s) before each send, and sent at up to ${escapeHtml(Math.max(config.followupSendsPerMinute, 1))} customer(s) per minute for ${escapeHtml(Math.max(config.followupActiveWindowMinutes, 1))} minutes, then paused for ${escapeHtml(Math.max(config.followupPauseWindowMinutes, 0))} minutes. In live WhatsApp mode, follow-ups outside the 24-hour customer service window are held until an approved template is configured.</p>
      <p class="note"><a href="/admin/follow-up-settings">Edit follow-up messages and schedule settings</a></p>
      <div class="subtabs" id="followup-label-tabs"></div>
      <div class="table-wrap"></div>
    </section>
    <section id="deleted" class="panel"><h2>Deleted / Expired Customers</h2><div class="table-wrap"></div></section>
    <section id="profile" class="panel">
      <h2>Profile</h2>
      <form class="profile-form" id="profile-form">
        <label for="profile-name">Dashboard Name <input id="profile-name" name="name" maxlength="80" placeholder="AI Agent Monitor" /></label>
        <label for="profile-color">Dashboard Color <input id="profile-color" name="accentColor" type="color" value="#0071e3" /></label>
        <div class="profile-actions">
          <button type="submit">Save Profile</button>
          <span id="profile-state"></span>
        </div>
      </form>
      <form class="profile-form" method="post" action="/admin/logout">
        <div class="profile-actions">
          <button type="submit">Logout</button>
          <span class="muted">Sign out from this admin dashboard.</span>
        </div>
      </form>
    </section>
  </main>
  <script>
    const sections = {
      customers: document.querySelector("#customers .table-wrap"),
      orderCustomers: document.querySelector("#order-customers .table-wrap"),
      anotherDatePurchase: document.querySelector("#another-date-purchase .table-wrap"),
      handoff: document.querySelector("#handoff .table-wrap"),
      orders: document.querySelector("#orders .table-wrap"),
      followups: document.querySelector("#followups .table-wrap"),
      deleted: document.querySelector("#deleted .table-wrap")
    };
    let dashboardData = null;
    let activeCustomerLabel = "ALL";
    let activeCustomerSku = "ALL";
    let activeCustomerPhoneSearch = "";
    let activeCustomerLastMessageDate = "";
    let activeCustomerLastMessageSort = "desc";
    let activeFollowupLabel = "ALL";
    let activeDashboardDate = localDateInput(new Date());
    let activeOrderCustomersDate = localDateInput(new Date());
    let activeOrderCustomersSku = "ALL";
    let activeHandoffDate = localDateInput(new Date());
    let activeOrdersDate = localDateInput(new Date());
    const bulkSelections = new Map();

    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, function(ch) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
      });
    }

    function fmtTime(value) {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return esc(value);
      return date.toLocaleString();
    }

    function localDateInput(value) {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return year + "-" + month + "-" + day;
    }

    function matchesDate(value, selectedDate) {
      if (!selectedDate) return true;
      return localDateInput(value) === selectedDate;
    }

    function dashboardDate() {
      return activeDashboardDate || localDateInput(new Date());
    }

    function rowsForDate(rows, key, selectedDate = dashboardDate()) {
      if (!selectedDate) return rows;
      return rows.filter(row => matchesDate(row[key], selectedDate));
    }

    function dashboardCustomers() {
      return dashboardData ? dashboardData.customers : [];
    }

    function skuFilteredCustomers() {
      const customers = dashboardCustomers();
      return activeCustomerSku === "ALL"
        ? customers
        : customers.filter(customer => (customer.skuCode || "") === activeCustomerSku);
    }

    function customerPhoneText(customer) {
      return String(customer.phone || customer.whatsappId || customer.id || "");
    }

    function digitsOnly(value) {
      return String(value || "").replace(/\D/g, "");
    }

    function customerFilterBase() {
      const search = activeCustomerPhoneSearch.trim().toLowerCase();
      const searchDigits = digitsOnly(search);
      return skuFilteredCustomers()
        .filter(customer => {
          if (!search) return true;
          const phone = customerPhoneText(customer).toLowerCase();
          const phoneDigits = digitsOnly(phone);
          return phone.includes(search) || (searchDigits && phoneDigits.includes(searchDigits));
        })
        .filter(customer => !activeCustomerLastMessageDate || matchesDate(customer.lastMessageAt, activeCustomerLastMessageDate))
        .sort((a, b) => {
          const direction = activeCustomerLastMessageSort === "asc" ? 1 : -1;
          return direction * String(a.lastMessageAt || "").localeCompare(String(b.lastMessageAt || ""));
        });
    }

    function customerMatchesLabel(customer, label) {
      if (label === "ALL") return true;
      if (label === "DONE") {
        return customer.labelDisplay === "DONE" && matchesDate(customer.latestOrderCreatedAt, dashboardDate());
      }
      return customer.labelDisplay === label;
    }

    function dashboardFollowups() {
      return rowsForDate(dashboardData ? dashboardData.followups : [], "nextDueAt");
    }

    function dashboardDeletedCustomers() {
      return rowsForDate(dashboardData ? dashboardData.deletedCustomers : [], "deletedAt");
    }

    function dashboardStats(data) {
      const selectedDate = dashboardDate();
      const handoffRows = rowsForDate(data.handoffQueue || [], "createdAt", selectedDate);
      const followupRows = rowsForDate(data.followups || [], "nextDueAt", selectedDate);
      return {
        activeCustomers: (data.customers || []).length,
        newCustomers: data.analytics?.totalNewCustomersToday || 0,
        handoff: handoffRows.length,
        complaints: handoffRows.filter(row => row.type === "complaint").length,
        orders: rowsForDate(data.orders || [], "createdAt", selectedDate).length,
        orderCustomers: new Set(rowsForDate(data.orderCustomers || [], "createdAt", selectedDate).map(row => row.customerId).filter(Boolean)).size,
        anotherDatePurchase: (data.anotherDatePurchaseCustomers || []).length,
        followupsDue: followupRows.filter(row => /^due\b/i.test(row.status || "")).length,
        followupsQueued: followupRows.filter(row => row.queueStatus).length,
        deleted: rowsForDate(data.deletedCustomers || [], "deletedAt", selectedDate).length,
      };
    }

    function pill(value) {
      const text = String(value || "");
      let cls = "pill";
      if (/human|required|delete|expired|due/i.test(text)) cls += " danger";
      else if (/waiting|scheduled|pending/i.test(text)) cls += " warn";
      else if (/active|engaged|submitted|completed|sent/i.test(text)) cls += " ok";
      return '<span class="' + cls + '">' + esc(text) + '</span>';
    }

    function table(rows, columns, options = {}) {
      if (!rows.length) return '<div class="empty">No records yet.</div>';
      const selectHead = options.bulkSection
        ? '<th class="bulk-select-cell"><input type="checkbox" data-bulk-select-all="' + esc(options.bulkSection) + '" aria-label="Select all rows" /></th>'
        : '';
      return '<table><thead><tr>' + selectHead + columns.map(c => '<th>' + esc(c.label) + '</th>').join('') +
        '</tr></thead><tbody>' + rows.map(row => '<tr>' + columns.map(c => {
          const value = c.render ? c.render(row) : esc(row[c.key]);
          return '<td>' + value + '</td>';
        }).join('').replace(/^/, options.bulkSection
          ? '<td class="bulk-select-cell"><input type="checkbox" data-bulk-row="' + esc(options.bulkSection) + '" data-bulk-id="' + esc(options.idForRow ? options.idForRow(row) : "") + '" aria-label="Select row" /></td>'
          : '') + '</tr>').join('') + '</tbody></table>';
    }

    function bulkToolbar(sectionKey, actions) {
      if (!actions.length) {
        return '<div class="bulkbar"><span class="muted" data-bulk-count="' + esc(sectionKey) + '">0 selected</span></div>';
      }
      return '<div class="bulkbar">' +
        '<span class="muted" data-bulk-count="' + esc(sectionKey) + '">0 selected</span>' +
        actions.map(action => '<button type="button" data-bulk-action="' + esc(action.key) + '" data-bulk-section="' + esc(sectionKey) + '" ' + (action.danger ? 'class="danger"' : '') + '>' + esc(action.label) + '</button>').join('') +
      '</div>';
    }

    function bulkTable(sectionKey, rows, columns, actions, idForRow) {
      if (!rows.length) return '<div class="empty">No records yet.</div>';
      return bulkToolbar(sectionKey, actions) + table(rows, columns, { bulkSection: sectionKey, idForRow });
    }

    function selectedBulkIds(sectionKey) {
      return [...(bulkSelections.get(sectionKey) || new Set())];
    }

    function updateBulkCount(sectionKey) {
      const count = selectedBulkIds(sectionKey).length;
      const label = document.querySelector('[data-bulk-count="' + sectionKey + '"]');
      if (label) label.textContent = count + " selected";
      document.querySelectorAll('button[data-bulk-section="' + sectionKey + '"]').forEach(button => {
        button.disabled = count === 0;
      });
    }

    function bindBulkSelection(sectionKey) {
      const all = document.querySelector('input[data-bulk-select-all="' + sectionKey + '"]');
      if (all) {
        all.addEventListener("change", () => {
          document.querySelectorAll('input[data-bulk-row="' + sectionKey + '"]').forEach(input => {
            input.checked = all.checked;
            rememberBulkSelection(input);
          });
          updateBulkCount(sectionKey);
        });
      }
      document.querySelectorAll('input[data-bulk-row="' + sectionKey + '"]').forEach(input => {
        input.checked = (bulkSelections.get(sectionKey) || new Set()).has(input.dataset.bulkId);
        input.addEventListener("change", () => {
          rememberBulkSelection(input);
          updateBulkCount(sectionKey);
        });
      });
      document.querySelectorAll('button[data-bulk-section="' + sectionKey + '"]').forEach(button => {
        button.addEventListener("click", () => runBulkAction(sectionKey, button.dataset.bulkAction));
      });
      updateBulkCount(sectionKey);
    }

    function rememberBulkSelection(input) {
      const sectionKey = input.dataset.bulkRow;
      const id = input.dataset.bulkId;
      if (!sectionKey || !id) return;
      if (!bulkSelections.has(sectionKey)) bulkSelections.set(sectionKey, new Set());
      const selected = bulkSelections.get(sectionKey);
      if (input.checked) selected.add(id);
      else selected.delete(id);
    }

    function clearBulkSelection(sectionKey) {
      bulkSelections.set(sectionKey, new Set());
    }

    async function runBulkAction(sectionKey, actionKey) {
      const ids = selectedBulkIds(sectionKey);
      if (!ids.length) return;
      if (!confirm("Apply this action to " + ids.length + " selected record(s)?")) return;
      try {
        if (actionKey === "delete-customers") {
          for (const item of ids) {
            const parts = String(item).split("::");
            await request("/admin/customer/delete", { customerId: parts[1] || parts[0] || "", reason: "Bulk deletion from dashboard" });
          }
        } else if (actionKey === "opt-out-customers") {
          for (const item of ids) {
            const parts = String(item).split("::");
            await request("/admin/customer/opt-out", { customerId: parts[1] || parts[0] || "" });
          }
        } else if (actionKey === "ack-handoff") {
          for (const item of ids) {
            const parts = String(item).split("::");
            await request("/admin/handoff/acknowledge", {
              customerId: parts[0] || "",
              type: parts[1] || "conversation",
              caseId: parts[2] || "",
            });
          }
        } else if (actionKey === "reached-warehouse") {
          for (const item of ids) {
            const parts = String(item).split("::");
            await request("/admin/orders/reached-warehouse", { orderId: parts[0] || "" });
          }
        }
        clearBulkSelection(sectionKey);
        await loadDashboard();
      } catch (error) {
        alert(error.message || "Bulk action failed.");
      }
    }

    function applyDashboardProfile(profile = {}) {
      const name = String(profile.name || "AI Agent Monitor").trim() || "AI Agent Monitor";
      const accentColor = /^#[0-9a-fA-F]{6}$/.test(String(profile.accentColor || "")) ? profile.accentColor : "#0071e3";
      document.querySelector("#dashboard-title").textContent = name;
      document.documentElement.style.setProperty("--accent", accentColor);
      document.querySelector("#profile-name").value = name;
      document.querySelector("#profile-color").value = accentColor;
    }

    async function loadDashboard() {
      const selectedDate = dashboardDate();
      const response = await fetch('/admin/dashboard-data?date=' + encodeURIComponent(selectedDate));
      const data = await response.json();
      dashboardData = data;
      applyDashboardProfile(data.profile);
      document.querySelector("#today-date").textContent = new Date().toLocaleDateString(undefined, {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric"
      });
      const stats = dashboardStats(data);
      const summaryItems = [
        ['Customers', stats.newCustomers],
        ['Handoff', stats.handoff],
        ['Complaints', stats.complaints],
        ['Orders', stats.orders]
      ];
      document.querySelector('#summary').innerHTML = summaryItems.map(item =>
        '<div class="metric"><strong>' + esc(item[1]) + '</strong><span>' + esc(item[0]) + '</span></div>'
      ).join('');
      updateDashboardTabs(stats);

      renderCustomerSkuFilter();
      renderCustomerLabelTabs(customerFilterBase());
      renderCustomers();
      renderHandoff();
      renderOrderCustomerSkuFilter();
      renderOrderCustomers();
      renderAnotherDatePurchaseCustomers();
      renderOrders();

      renderFollowupLabelTabs(dashboardFollowups());
      renderFollowups();

      sections.deleted.innerHTML = bulkTable("deleted", dashboardDeletedCustomers(), [
        { label: 'Customer', key: 'id' },
        { label: 'Product', key: 'product' },
        { label: 'SKU', key: 'skuCode' },
        { label: 'Label', key: 'labelDisplay', render: r => pill(r.labelDisplay) },
        { label: 'First Seen', key: 'firstSeenAt', render: r => fmtTime(r.firstSeenAt) },
        { label: 'Deleted At', key: 'deletedAt', render: r => fmtTime(r.deletedAt) },
        { label: 'Reason', key: 'deleteReason' }
      ], [], r => r.id);
      bindBulkSelection("deleted");
    }

    function renderHandoff() {
      const rows = dashboardData ? dashboardData.handoffQueue : [];
      const filtered = rows.filter(row => matchesDate(row.createdAt, activeHandoffDate));
      sections.handoff.innerHTML = bulkTable("handoff", filtered, [
        { label: 'Type', key: 'type', render: r => pill(r.type) },
        { label: 'Customer', key: 'customerId' },
        { label: 'Phone', key: 'phone' },
        { label: 'Product', key: 'product' },
        { label: 'Category', key: 'category' },
        { label: 'Customer Message', key: 'customerMessage' },
        { label: 'Reason', key: 'reason' },
        { label: 'Time', key: 'createdAt', render: r => fmtTime(r.createdAt) },
        { label: 'Action', key: 'customerId', render: r => '<div class="actions"><button type="button" data-handoff-chat="' + esc(r.customerId) + '">Chat</button><button type="button" data-manual-order-customer="' + esc(r.customerId) + '">Mark Order Submitted</button><button type="button" data-handoff-ack="' + esc(r.customerId) + '" data-handoff-type="' + esc(r.type) + '" data-handoff-case="' + esc(r.caseId || '') + '">Acknowledge</button>' + (r.type === 'complaint' ? '<button type="button" data-complaint-resolve="' + esc(r.caseId) + '">Resolve</button>' : '') + '</div>' }
      ], [{ key: "ack-handoff", label: "Acknowledge Selected" }], r => String(r.customerId || "") + "::" + String(r.type || "conversation") + "::" + String(r.caseId || ""));
      bindBulkSelection("handoff");
      document.querySelectorAll("button[data-handoff-chat]").forEach(button => button.addEventListener("click", () => {
        window.location.href = "/admin/chat?customerId=" + encodeURIComponent(button.dataset.handoffChat);
      }));
      bindManualOrderButtons();
      document.querySelectorAll("button[data-handoff-ack]").forEach(button => button.addEventListener("click", async () => {
        if (!confirm("Acknowledge this handoff and remove it from the Handoff tab?")) return;
        await request("/admin/handoff/acknowledge", {
          customerId: button.dataset.handoffAck,
          type: button.dataset.handoffType,
          caseId: button.dataset.handoffCase
        });
        loadDashboard();
      }));
      document.querySelectorAll("button[data-complaint-resolve]").forEach(button => button.addEventListener("click", async () => {
        await request("/admin/handoff/complaint/resolve", { caseId: button.dataset.complaintResolve });
        loadDashboard();
      }));
    }

    function renderFollowupSettings() {
      const stages = dashboardData ? dashboardData.followupMessages || [] : [];
      const editor = document.querySelector("#followup-message-editor");
      if (!editor) return;
      if (!stages.length) {
        editor.innerHTML = '<div class="empty">No follow-up settings found.</div>';
        return;
      }
      editor.innerHTML = stages.map(stage => {
        return '<div class="followup-message-card" data-followup-key="' + esc(stage.key) + '">' +
          '<label>' + esc(stage.label) + ' Message<textarea data-followup-field="message">' + esc(stage.message || "") + '</textarea></label>' +
          '<label>Send Hour<input data-followup-field="sendHour" type="number" min="0" max="23" value="' + esc(stage.sendHour ?? 20) + '" /></label>' +
          '<div class="muted">Key: ' + esc(stage.key) + ' | Day offset: ' + esc(stage.dayOffset ?? "") + '</div>' +
        '</div>';
      }).join("");
    }

    function readFollowupSettings() {
      return [...document.querySelectorAll(".followup-message-card[data-followup-key]")].map(card => {
        const message = card.querySelector('[data-followup-field="message"]')?.value || "";
        const sendHour = card.querySelector('[data-followup-field="sendHour"]')?.value || "";
        return {
          key: card.dataset.followupKey,
          message,
          sendHour,
        };
      });
    }

    async function saveFollowupSettings(event) {
      event.preventDefault();
      const state = document.querySelector("#followup-settings-state");
      state.textContent = "Saving...";
      try {
        const result = await request("/admin/followup-settings/save", {
          followups: readFollowupSettings()
        });
        dashboardData.followupMessages = result.followupMessages || result.saved?.stages || [];
        renderFollowupSettings();
        renderFollowupLabelTabs(dashboardFollowups());
        renderFollowups();
        state.textContent = "Saved";
      } catch (error) {
        state.textContent = error.message;
      }
    }

    async function saveProfile(event) {
      event.preventDefault();
      const state = document.querySelector("#profile-state");
      state.textContent = "Saving...";
      try {
        const result = await request("/admin/profile", {
          name: document.querySelector("#profile-name").value,
          accentColor: document.querySelector("#profile-color").value
        });
        dashboardData.profile = result.profile;
        applyDashboardProfile(result.profile);
        state.textContent = "Saved";
      } catch (error) {
        state.textContent = error.message;
      }
    }

    function orderCustomerRows() {
      const rows = dashboardData ? dashboardData.orderCustomers || [] : [];
      return rows
        .filter(row => matchesDate(row.createdAt, activeOrderCustomersDate))
        .filter(row => activeOrderCustomersSku === "ALL" || (row.skuCode || "") === activeOrderCustomersSku);
    }

    function renderOrderCustomerSkuFilter() {
      const rows = dashboardData ? dashboardData.orderCustomers || [] : [];
      const dateRows = rows.filter(row => matchesDate(row.createdAt, activeOrderCustomersDate));
      const skus = [...new Set(dateRows.map(row => row.skuCode || "").filter(Boolean))].sort();
      if (activeOrderCustomersSku !== "ALL" && !skus.includes(activeOrderCustomersSku)) activeOrderCustomersSku = "ALL";
      document.querySelector("#order-customers-sku-filter").innerHTML =
        '<option value="ALL">All SKU</option>' +
        skus.map(sku => '<option value="' + esc(sku) + '">' + esc(sku) + '</option>').join("");
      document.querySelector("#order-customers-sku-filter").value = activeOrderCustomersSku;
    }

    function bindReachedWarehouseButtons() {
      document.querySelectorAll("button[data-reached-warehouse]").forEach(button => button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "Updating...";
        try {
          await request("/admin/orders/reached-warehouse", { orderId: button.dataset.reachedWarehouse });
          await loadDashboard();
        } catch (error) {
          button.disabled = false;
          button.textContent = error.message;
        }
      }));
    }

    function findDashboardProduct(value) {
      const products = dashboardData ? dashboardData.products || [] : [];
      const text = String(value || "").trim().toLowerCase();
      return products.find(product =>
        String(product.id || "").toLowerCase() === text ||
        String(product.name || "").toLowerCase() === text
      ) || null;
    }

    function findDashboardOrderOption(product, value) {
      const options = product ? product.orderOptions || [] : [];
      const text = String(value || "").trim().toLowerCase();
      return options.find(option =>
        String(option.id || "").toLowerCase() === text ||
        String(option.name || "").toLowerCase() === text
      ) || null;
    }

    function customerDefaultsForManualOrder(customerId) {
      const customer = (dashboardData.customers || []).find(row => row.whatsappId === customerId) || {};
      const handoff = (dashboardData.handoffQueue || []).find(row => row.customerId === customerId) || {};
      const order = (dashboardData.orderCustomers || []).find(row => row.customerId === customerId) || {};
      return {
        productId: customer.productId || handoff.productId || "",
        name: order.name || customer.name || "",
        phone: order.phone || handoff.phone || customer.phone || customerId,
        address: order.address || customer.address || "",
      };
    }

    async function markCustomerOrderSubmitted(customerId) {
      const defaults = customerDefaultsForManualOrder(customerId);
      const products = dashboardData ? dashboardData.products || [] : [];
      if (!products.length) return alert("No products found.");
      const defaultProduct = findDashboardProduct(defaults.productId) || products[0];
      const productList = products.map(product => product.id + " = " + product.name).join("\\n");
      const productInput = prompt("Which product? Type product id or name:\\n\\n" + productList, defaultProduct.id);
      if (productInput === null) return;
      const product = findDashboardProduct(productInput) || defaultProduct;
      const options = product.orderOptions || [];
      const optionList = options.map(option => option.id + " = " + option.name + (option.price ? " (" + option.price + ")" : "")).join("\\n");
      const optionInput = options.length
        ? prompt("Which order option/package? Type id or name:\\n\\n" + optionList, options[0].id)
        : "";
      if (optionInput === null) return;
      const option = findDashboardOrderOption(product, optionInput) || options[0] || {};
      const name = prompt("Customer full name:", defaults.name || "");
      if (name === null) return;
      const phone = prompt("Customer phone number:", defaults.phone || customerId);
      if (phone === null) return;
      const address = prompt("Customer full address:", defaults.address || "");
      if (address === null) return;
      const quantity = prompt("Quantity/unit count:", option.quantity || 1);
      if (quantity === null) return;
      if (!String(name).trim() || !String(phone).trim() || !String(address).trim()) {
        return alert("Name, phone, and address are required.");
      }
      await request("/admin/customer/mark-order-submitted", {
        customerId,
        productId: product.id,
        orderOptionId: option.id || "",
        orderOptionName: option.name || "",
        orderOptionPrice: option.price || "",
        quantity,
        name,
        phone,
        address,
        rawMessage: "Manual admin order submission"
      });
      await loadDashboard();
    }

    function bindManualOrderButtons() {
      document.querySelectorAll("button[data-manual-order-customer]").forEach(button => button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "Submitting...";
        try {
          await markCustomerOrderSubmitted(button.dataset.manualOrderCustomer);
        } catch (error) {
          alert(error.message);
        } finally {
          button.disabled = false;
          button.textContent = "Mark Order Submitted";
        }
      }));
    }

    function renderOrderCustomers() {
      const filtered = orderCustomerRows();
      const uniqueCustomers = new Set(filtered.map(row => row.customerId).filter(Boolean)).size;
      document.querySelector("#order-customers-count").textContent =
        "Total customers: " + uniqueCustomers + " | Orders: " + filtered.length;
      sections.orderCustomers.innerHTML = bulkTable("order-customers", filtered, [
        { label: 'Order Time', key: 'orderTimestamp', render: r => fmtTime(r.orderTimestamp) },
        { label: 'Customer', key: 'customerId' },
        { label: 'Product', key: 'product' },
        { label: 'SKU', key: 'skuCode' },
        { label: 'Order Option', key: 'package' },
        { label: 'Price', key: 'packagePrice' },
        { label: 'Qty', key: 'quantity' },
        { label: 'Add-on', key: 'addOnChoice' },
        { label: 'Name', key: 'name' },
        { label: 'Phone', key: 'phone' },
        { label: 'Address', key: 'address' },
        { label: 'Status', key: 'statusDisplay', render: r => pill(r.statusDisplay) },
        { label: 'Action', key: 'id', render: r => r.status === 'pending_admin_order'
          ? '<button type="button" data-reached-warehouse="' + esc(r.id) + '">Reached Warehouse</button>'
          : '<span class="muted">-</span>' },
        { label: 'Delete', key: 'customerId', render: r => '<button class="danger" type="button" data-delete-dashboard-customer="' + esc(r.customerId) + '">Delete</button>' }
      ], [
        { key: "reached-warehouse", label: "Reached Warehouse" },
        { key: "delete-customers", label: "Delete Selected", danger: true }
      ], r => String(r.id || "") + "::" + String(r.customerId || ""));
      bindBulkSelection("order-customers");
      bindReachedWarehouseButtons();
      bindDashboardCustomerDeleteButtons();
    }

    function renderAnotherDatePurchaseCustomers() {
      const rows = dashboardData ? dashboardData.anotherDatePurchaseCustomers || [] : [];
      sections.anotherDatePurchase.innerHTML = bulkTable("another-date-purchase", rows, [
        { label: 'Phone', key: 'phone', render: r => esc(customerPhoneText(r)) },
        { label: 'Product', key: 'product' },
        { label: 'SKU', key: 'skuCode' },
        { label: 'Planned Date', key: 'plannedDate', render: r => r.plannedDate ? fmtTime(r.plannedDate) : '<span class="muted">Fallback date</span>' },
        { label: 'Customer Message', key: 'note' },
        { label: 'Last Message', key: 'lastMessageAt', render: r => fmtTime(r.lastMessageAt) },
        { label: 'Order', key: 'whatsappId', render: r => '<button type="button" data-manual-order-customer="' + esc(r.whatsappId) + '">Mark Order Submitted</button>' },
        { label: 'Opt Out', key: 'whatsappId', render: r => '<button type="button" data-opt-out-dashboard-customer="' + esc(r.whatsappId) + '">Opt Out</button>' },
        { label: 'Delete', key: 'whatsappId', render: r => '<button class="danger" type="button" data-delete-dashboard-customer="' + esc(r.whatsappId) + '">Delete</button>' }
      ], [
        { key: "opt-out-customers", label: "Opt Out Selected" },
        { key: "delete-customers", label: "Delete Selected", danger: true }
      ], r => r.whatsappId);
      bindBulkSelection("another-date-purchase");
      bindManualOrderButtons();
      bindDashboardCustomerOptOutButtons();
      bindDashboardCustomerDeleteButtons();
    }

    function renderOrders() {
      const rows = dashboardData ? dashboardData.orders : [];
      const filtered = rows.filter(row => matchesDate(row.createdAt, activeOrdersDate));
      sections.orders.innerHTML = bulkTable("orders", filtered, [
        { label: 'Order Timestamp', key: 'orderTimestamp', render: r => fmtTime(r.orderTimestamp) },
        { label: 'Order ID', key: 'id' },
        { label: 'WhatsApp ID', key: 'customerId' },
        { label: 'Order Record', key: 'orderRecord' },
        { label: 'Submitted Details', key: 'rawMessage' },
        { label: 'Status', key: 'statusDisplay', render: r => pill(r.statusDisplay) },
        { label: 'Status Updated', key: 'statusUpdatedAt', render: r => fmtTime(r.statusUpdatedAt) }
      ], [], r => r.customerId || r.id);
      bindBulkSelection("orders");
    }

    function syncPanelDatesToDashboard() {
      activeHandoffDate = dashboardDate();
      activeOrderCustomersDate = dashboardDate();
      activeOrdersDate = dashboardDate();
      const handoffDate = document.querySelector("#handoff-date");
      const orderCustomersDate = document.querySelector("#order-customers-date");
      const ordersDate = document.querySelector("#orders-date");
      if (handoffDate) handoffDate.value = activeHandoffDate;
      if (orderCustomersDate) orderCustomersDate.value = activeOrderCustomersDate;
      if (ordersDate) ordersDate.value = activeOrdersDate;
    }

    function setupDashboardDate() {
      const input = document.querySelector("#dashboard-date");
      input.value = activeDashboardDate;
      syncPanelDatesToDashboard();
      input.addEventListener("change", () => {
        activeDashboardDate = input.value || localDateInput(new Date());
        syncPanelDatesToDashboard();
        loadDashboard();
      });
    }

    async function request(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Action failed.");
      return result;
    }

    function setTabLabel(tabId, label, counts) {
      const tab = document.querySelector('.tab[data-tab="' + tabId + '"]');
      if (!tab) return;
      const badges = counts.map(item => {
        const cls = item.soft ? "tab-count soft" : "tab-count";
        const title = item.title ? ' title="' + esc(item.title) + '"' : "";
        return '<span class="' + cls + '"' + title + '>' + esc(item.value) + '</span>';
      }).join("");
      tab.innerHTML = '<span>' + esc(label) + '</span>' + badges;
    }

    function updateDashboardTabs(stats) {
      setTabLabel("customers", "Customers", [{ value: stats.newCustomers }]);
      setTabLabel("order-customers", "Customer List", [{ value: stats.orderCustomers }]);
      setTabLabel("another-date-purchase", "Another Date Purchase", [{ value: stats.anotherDatePurchase }]);
      setTabLabel("handoff", "Handoff", [
        { value: stats.handoff, title: "Handoff" },
        { value: stats.complaints, title: "Complaints", soft: true }
      ]);
      setTabLabel("orders", "Orders", [{ value: stats.orders }]);
      setTabLabel("followups", "Follow-ups", [
        { value: stats.followupsDue, title: "Due" },
        { value: stats.followupsQueued, title: "Queued", soft: true }
      ]);
      setTabLabel("deleted", "Deleted", [{ value: stats.deleted }]);
    }

    function renderCustomerLabelTabs(customers) {
      const labels = ["ALL", "NEW"];
      for (let day = 1; day <= 10; day += 1) labels.push("DAY " + day);
      labels.push("DONE");
      labels.push("OPTED OUT");
      labels.push("DELETE");
      const counts = new Map(labels.map(label => [label, 0]));
      counts.set("ALL", customers.length);
      for (const customer of customers) {
        if (customerMatchesLabel(customer, customer.labelDisplay)) {
          counts.set(customer.labelDisplay, (counts.get(customer.labelDisplay) || 0) + 1);
        }
      }
      if (!labels.includes(activeCustomerLabel)) activeCustomerLabel = "ALL";
      document.querySelector("#customer-label-tabs").innerHTML = labels.map(label => {
        const active = label === activeCustomerLabel ? " active" : "";
        return '<button type="button" class="subtab' + active + '" data-label="' + esc(label) + '">' +
          esc(label) + ' (' + esc(counts.get(label) || 0) + ')</button>';
      }).join("");
      document.querySelectorAll("#customer-label-tabs .subtab").forEach(button => {
        button.addEventListener("click", () => {
          activeCustomerLabel = button.dataset.label;
          renderCustomerLabelTabs(skuFilteredCustomers());
          renderCustomers();
        });
      });
    }

    function renderCustomerSkuFilter() {
      const customers = dashboardCustomers();
      const skus = [...new Set(customers.map(customer => customer.skuCode || "").filter(Boolean))].sort();
      if (activeCustomerSku !== "ALL" && !skus.includes(activeCustomerSku)) activeCustomerSku = "ALL";
      document.querySelector("#customer-sku-filter").innerHTML =
        '<option value="ALL">All SKU</option>' +
        skus.map(sku => '<option value="' + esc(sku) + '">' + esc(sku) + '</option>').join("");
      document.querySelector("#customer-sku-filter").value = activeCustomerSku;
    }

    function renderCustomers() {
      const customers = customerFilterBase();
      const filtered = activeCustomerLabel === "ALL"
        ? customers
        : customers.filter(customer => customerMatchesLabel(customer, activeCustomerLabel));
      sections.customers.innerHTML = bulkTable("customers", filtered, [
        { label: 'Phone', key: 'phone', render: r => esc(customerPhoneText(r)) },
        { label: 'Product', key: 'product' },
        { label: 'SKU', key: 'skuCode' },
        { label: 'Label', key: 'labelDisplay', render: r => pill(r.labelDisplay) },
        { label: 'Status', key: 'status', render: r => pill(r.status) },
        { label: 'Guardrail', key: 'guardrail', render: r => pill(r.guardrail) },
        { label: 'Last Message', key: 'lastMessageAt', render: r => fmtTime(r.lastMessageAt) },
        { label: 'Order', key: 'whatsappId', render: r => '<button type="button" data-manual-order-customer="' + esc(r.whatsappId) + '">Mark Order Submitted</button>' },
        { label: 'Opt Out', key: 'whatsappId', render: r => '<button type="button" data-opt-out-dashboard-customer="' + esc(r.whatsappId) + '">Opt Out</button>' },
        { label: 'Delete', key: 'whatsappId', render: r => '<button class="danger" type="button" data-delete-dashboard-customer="' + esc(r.whatsappId) + '">Delete</button>' }
      ], [
        { key: "opt-out-customers", label: "Opt Out Selected" },
        { key: "delete-customers", label: "Delete Selected", danger: true }
      ], r => r.whatsappId);
      bindBulkSelection("customers");
      bindManualOrderButtons();
      bindDashboardCustomerOptOutButtons();
      bindDashboardCustomerDeleteButtons();
    }

    function bindDashboardCustomerOptOutButtons() {
      document.querySelectorAll("button[data-opt-out-dashboard-customer]").forEach(button => {
        button.addEventListener("click", async () => {
          const customerId = button.dataset.optOutDashboardCustomer;
          if (!confirm("Opt out customer " + customerId + "? This blocks future follow-up messages.")) return;
          button.disabled = true;
          button.textContent = "Opting out...";
          try {
            await request("/admin/customer/opt-out", { customerId });
            await loadDashboard();
          } catch (error) {
            button.disabled = false;
            button.textContent = error.message;
          }
        });
      });
    }

    function bindDashboardCustomerDeleteButtons() {
      document.querySelectorAll("button[data-delete-dashboard-customer]").forEach(button => {
        button.addEventListener("click", async () => {
          const customerId = button.dataset.deleteDashboardCustomer;
          if (!confirm("Delete customer " + customerId + "? This moves the customer to Deleted and removes them from active lists.")) return;
          button.disabled = true;
          button.textContent = "Deleting...";
          try {
            await request("/admin/customer/delete", {
              customerId,
              reason: "Manual deletion from dashboard customer list"
            });
            await loadDashboard();
          } catch (error) {
            button.disabled = false;
            button.textContent = error.message;
          }
        });
      });
    }

    function renderFollowupLabelTabs(followups) {
      const labels = ["ALL", "NEW"];
      for (let day = 1; day <= 10; day += 1) labels.push("DAY " + day);
      labels.push("OPTED OUT");
      labels.push("DELETE");
      const counts = new Map(labels.map(label => [label, 0]));
      counts.set("ALL", followups.length);
      for (const row of followups) {
        counts.set(row.labelDisplay, (counts.get(row.labelDisplay) || 0) + 1);
      }
      if (!labels.includes(activeFollowupLabel)) activeFollowupLabel = "ALL";
      document.querySelector("#followup-label-tabs").innerHTML = labels.map(label => {
        const active = label === activeFollowupLabel ? " active" : "";
        return '<button type="button" class="subtab' + active + '" data-label="' + esc(label) + '">' +
          esc(label) + ' (' + esc(counts.get(label) || 0) + ')</button>';
      }).join("");
      document.querySelectorAll("#followup-label-tabs .subtab").forEach(button => {
        button.addEventListener("click", () => {
          activeFollowupLabel = button.dataset.label;
          renderFollowupLabelTabs(dashboardFollowups());
          renderFollowups();
        });
      });
    }

    function renderFollowups() {
      const followups = dashboardFollowups();
      const filtered = activeFollowupLabel === "ALL"
        ? followups
        : followups.filter(row => row.labelDisplay === activeFollowupLabel);
      sections.followups.innerHTML = bulkTable("followups", filtered, [
        { label: 'Customer', key: 'customerId' },
        { label: 'Product', key: 'product' },
        { label: 'Label', key: 'labelDisplay', render: r => pill(r.labelDisplay) },
        { label: 'Follow-Up Stage', key: 'nextFollowup', render: r => esc(followupStageName(r.nextFollowup)) },
        { label: 'Scheduled Send Time', key: 'nextDueAt', render: r => fmtTime(r.nextDueAt) },
        { label: 'Status', key: 'status', render: r => pill(r.status) },
        { label: 'Dispatch Queue', key: 'queueStatus', render: r => r.queueStatus ? pill(r.queueStatus + (r.queueAttempts ? ' / attempt ' + r.queueAttempts : '')) : '-' },
        { label: 'Guardrail', key: 'guardrail', render: r => pill(r.guardrail) },
        { label: 'Sent Count', key: 'sentCount', render: r => esc((r.sentCount || 0) + ' / ' + (r.totalFollowups || 0)) },
        { label: 'First Follow-Up Sent', key: 'sentFirst', render: r => fmtTime(r.sentFirst) },
        { label: 'Second Follow-Up Sent', key: 'sentDay1', render: r => fmtTime(r.sentDay1) }
      ], [{ key: "delete-customers", label: "Delete Selected", danger: true }], r => r.customerId);
      bindBulkSelection("followups");
    }

    function followupStageName(value) {
      if (value === "first_day_followup") return "First follow-up";
      if (value === "day_1_followup") return "Second follow-up";
      const dayMatch = String(value || "").match(/^day_(\d+)_followup$/);
      if (dayMatch) return "Day " + dayMatch[1] + " follow-up";
      return "-";
    }

    function setupDateFilter(inputId, allId, getValue, setValue, render) {
      const input = document.querySelector(inputId);
      input.value = getValue();
      input.addEventListener("change", () => {
        setValue(input.value);
        render();
      });
      document.querySelector(allId).addEventListener("click", () => {
        setValue("");
        input.value = "";
        render();
      });
    }

    setupDateFilter("#handoff-date", "#handoff-all", () => activeHandoffDate, value => activeHandoffDate = value, renderHandoff);
    setupDateFilter("#order-customers-date", "#order-customers-all", () => activeOrderCustomersDate, value => {
      activeOrderCustomersDate = value;
      renderOrderCustomerSkuFilter();
    }, renderOrderCustomers);
    setupDateFilter("#orders-date", "#orders-all", () => activeOrdersDate, value => activeOrdersDate = value, renderOrders);
    document.querySelector("#customer-sku-filter").addEventListener("change", event => {
      activeCustomerSku = event.target.value || "ALL";
      activeCustomerLabel = "ALL";
      renderCustomerLabelTabs(customerFilterBase());
      renderCustomers();
    });
    document.querySelector("#customer-phone-search").addEventListener("input", event => {
      activeCustomerPhoneSearch = event.target.value || "";
      activeCustomerLabel = "ALL";
      renderCustomerLabelTabs(customerFilterBase());
      renderCustomers();
    });
    document.querySelector("#customer-last-message-date").addEventListener("change", event => {
      activeCustomerLastMessageDate = event.target.value || "";
      activeCustomerLabel = "ALL";
      renderCustomerLabelTabs(customerFilterBase());
      renderCustomers();
    });
    document.querySelector("#customer-last-message-all").addEventListener("click", () => {
      activeCustomerLastMessageDate = "";
      document.querySelector("#customer-last-message-date").value = "";
      activeCustomerLabel = "ALL";
      renderCustomerLabelTabs(customerFilterBase());
      renderCustomers();
    });
    document.querySelector("#customer-last-message-sort").addEventListener("change", event => {
      activeCustomerLastMessageSort = event.target.value || "desc";
      renderCustomers();
    });
    document.querySelector("#order-customers-sku-filter").addEventListener("change", event => {
      activeOrderCustomersSku = event.target.value || "ALL";
      renderOrderCustomers();
    });
    function openDashboardTab(tabId) {
      document.querySelector("main").classList.toggle("profile-only", tabId === "profile");
      document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === tabId));
      document.querySelector("#profile-nav").classList.toggle("active", tabId === "profile");
      document.querySelectorAll('.panel').forEach(panel => panel.classList.toggle('active', panel.id === tabId));
    }

    document.querySelector("#profile-form").addEventListener("submit", saveProfile);
    document.querySelector('#refresh').addEventListener('click', loadDashboard);
    document.querySelector("#profile-nav").addEventListener("click", () => openDashboardTab("profile"));
    document.querySelectorAll('.tab').forEach(button => {
      button.addEventListener('click', () => openDashboardTab(button.dataset.tab));
    });
    setupDashboardDate();
    const requestedTab = new URLSearchParams(window.location.search).get("tab");
    if (requestedTab && document.getElementById(requestedTab)) openDashboardTab(requestedTab);
    loadDashboard();
    setInterval(loadDashboard, 15000);
  </script>
</body>
</html>`;
}

function adminChatPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp Chat Inbox</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Arial, sans-serif; color: #1d1d1f; background: #f5f5f7; --surface: #fff; --soft: #fbfbfd; --line: #d2d2d7; --muted: #6e6e73; --accent: #0071e3; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f5f7; }
    header { padding: 16px 22px 10px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); backdrop-filter: saturate(180%) blur(16px); }
    h1 { margin: 0; font-size: 20px; }
    .sub { margin-top: 4px; color: var(--muted); font-size: 13px; min-height: 18px; }
    nav { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 22px 14px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); }
    nav a, button { border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px; background: var(--surface); color: #1d1d1f; text-decoration: none; font: inherit; font-weight: 600; cursor: pointer; }
    nav a:hover, button:hover { border-color: #a8a8ad; }
    main { max-width: 1320px; margin: 0 auto; padding: 18px; }
    .chat-shell { display: grid; grid-template-columns: minmax(260px, 340px) minmax(0, 1fr); min-height: calc(100vh - 150px); border: 1px solid #e5e5ea; border-radius: 10px; background: var(--surface); overflow: hidden; }
    .sidebar { border-right: 1px solid #e5e5ea; background: var(--soft); display: grid; grid-template-rows: auto 1fr; min-width: 0; }
    .sidebar-tools { padding: 12px; border-bottom: 1px solid #e5e5ea; display: grid; gap: 8px; }
    .sidebar-tools label { display: grid; gap: 4px; color: var(--muted); font-size: 12px; font-weight: 700; }
    .sidebar-tools input { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; font: inherit; background: #fff; }
    .customer-list { overflow: auto; }
    .customer-item { display: block; width: 100%; text-align: left; border: 0; border-bottom: 1px solid #e5e5ea; border-radius: 0; padding: 12px; background: transparent; color: #1d1d1f; }
    .customer-item:hover, .customer-item.active { background: #fff; }
    .customer-item strong { display: block; overflow-wrap: anywhere; }
    .customer-item span { display: block; margin-top: 3px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .pane { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; }
    .chat-header { padding: 14px 16px; border-bottom: 1px solid #e5e5ea; background: #fff; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .chat-header strong { display: block; overflow-wrap: anywhere; }
    .chat-header span { color: var(--muted); font-size: 13px; }
    .chat-header-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
    .chat-header-actions .danger { border-color: #fecaca; background: #fee2e2; color: #991b1b; }
    .thread { padding: 18px; overflow: auto; background: #f7f7f8; }
    .row { display: flex; margin: 0 0 10px; }
    .row.customer { justify-content: flex-start; }
    .row.agent, .row.staff, .row.admin { justify-content: flex-end; }
    .bubble { max-width: min(680px, 86%); padding: 9px 11px; border-radius: 10px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.38; border: 1px solid #e5e5ea; background: #fff; }
    .row.customer .bubble { background: #fff; }
    .row.agent .bubble { background: #e8f2ff; border-color: #cfe4ff; }
    .row.staff .bubble { background: #dff6dd; border-color: #bee8ba; }
    .row.admin .bubble { background: #fff8e8; border-color: #f5dfaa; }
    .meta { margin-bottom: 5px; color: var(--muted); font-size: 11px; font-weight: 700; }
    .composer { padding: 12px; border-top: 1px solid #e5e5ea; background: #fff; }
    .composer-state { min-height: 18px; color: var(--muted); font-size: 12px; margin-bottom: 7px; }
    .composer-row { display: flex; gap: 8px; align-items: end; }
    textarea { flex: 1; min-height: 58px; max-height: 160px; resize: vertical; border: 1px solid var(--line); border-radius: 8px; padding: 10px; font: inherit; }
    textarea:focus, input:focus { outline: 3px solid rgba(0,113,227,.18); border-color: var(--accent); }
    .composer button { min-width: 80px; background: var(--accent); border-color: var(--accent); color: #fff; }
    .empty { color: var(--muted); padding: 18px; }
    @media (max-width: 820px) { main { padding: 0; } .chat-shell { grid-template-columns: 1fr; border-radius: 0; border-left: 0; border-right: 0; } .sidebar { max-height: 260px; border-right: 0; border-bottom: 1px solid #e5e5ea; } .chat-header { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
  <header>
    <h1 id="chat-title">WhatsApp Chat Inbox</h1>
    <div class="sub" id="status">Loading conversations...</div>
  </header>
  <nav>
    <a href="/admin/dashboard">Dashboard</a>
    <a href="/admin/chat">Chat Inbox</a>
    <a href="/admin/whatsapp-web">WhatsApp Web</a>
    <a href="/admin/analytics">Analytics</a>
    <a href="/admin/reply-library">Reply Library</a>
    <a href="/admin/product-flow">Product Flow</a>
    <a href="/admin/follow-up-settings">Follow-Up Settings</a>
    <a href="/admin/compliance">Compliance</a>
    <a href="/demo/chat">Customer Demo</a>
    <button id="refresh" type="button">Refresh</button>
    <a href="/admin/dashboard?tab=profile">Profile</a>
  </nav>
  <main>
    <div class="chat-shell">
      <aside class="sidebar">
        <div class="sidebar-tools">
          <label for="chat-date">Conversation Date <input id="chat-date" type="date" /></label>
          <input id="search" placeholder="Search customer or product..." />
        </div>
        <div class="customer-list" id="customer-list"></div>
      </aside>
      <section class="pane">
        <div class="chat-header" id="chat-header"><div><strong>No customer selected</strong><span>Select a customer on the left.</span></div></div>
        <div class="thread" id="thread"><div class="empty">No conversation selected.</div></div>
        <form class="composer" id="composer">
          <div class="composer-state" id="composer-state"></div>
          <div class="composer-row">
            <textarea id="reply-text" maxlength="${escapeHtml(config.maxReplyChars)}" placeholder="Type manual WhatsApp reply..." disabled></textarea>
            <button id="send-reply" type="submit" disabled>Send</button>
          </div>
        </form>
      </section>
    </div>
  </main>
  <script>
    let data = null;
    let activeCustomerId = new URLSearchParams(window.location.search).get("customerId") || "";
    const list = document.querySelector("#customer-list");
    const thread = document.querySelector("#thread");
    const header = document.querySelector("#chat-header");
    const chatDate = document.querySelector("#chat-date");
    const search = document.querySelector("#search");
    const replyText = document.querySelector("#reply-text");
    const sendButton = document.querySelector("#send-reply");
    const state = document.querySelector("#composer-state");

    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, function(ch) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
      });
    }
    function fmtTime(value) {
      if (!value) return "";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    }
    function applyProfile(profile = {}) {
      const name = String(profile.name || "").trim();
      const accentColor = /^#[0-9a-fA-F]{6}$/.test(String(profile.accentColor || "")) ? profile.accentColor : "#0071e3";
      document.documentElement.style.setProperty("--accent", accentColor);
      document.querySelector("#chat-title").textContent = name ? name + " Chat Inbox" : "WhatsApp Chat Inbox";
    }
    function localDateInput(value) {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return year + "-" + month + "-" + day;
    }
    function selectedChatDate() {
      return chatDate.value || localDateInput(new Date());
    }
    function matchesChatDate(value) {
      const selectedDate = selectedChatDate();
      if (!selectedDate) return true;
      return localDateInput(value) === selectedDate;
    }
    function messagesForCustomer(customerId, selectedDateOnly = false) {
      return (data ? data.conversationMessages || [] : [])
        .filter(message => message.to === customerId || message.from === customerId)
        .filter(message => !selectedDateOnly || matchesChatDate(message.createdAt));
    }
    function customerHasConversationOnSelectedDate(customer) {
      if (messagesForCustomer(customer.id, true).length) return true;
      return matchesChatDate(customer.lastMessageAt) || matchesChatDate(customer.firstSeenAt);
    }
    async function request(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Request failed");
      return result;
    }
    function customerRows() {
      const q = search.value.trim().toLowerCase();
      const rows = data ? data.customers || [] : [];
      return rows
        .filter(customer => customerHasConversationOnSelectedDate(customer))
        .filter(customer => {
          if (!q) return true;
          return [customer.id, customer.product, customer.name, customer.status, customer.labelDisplay]
            .some(value => String(value || "").toLowerCase().includes(q));
        })
        .sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)));
    }
    function renderList() {
      const rows = customerRows();
      if (!rows.length) {
        list.innerHTML = '<div class="empty">No customers found.</div>';
        return;
      }
      if (!activeCustomerId || !rows.some(customer => customer.id === activeCustomerId)) {
        activeCustomerId = rows[0].id;
      }
      list.innerHTML = rows.map(customer => {
        const active = customer.id === activeCustomerId ? " active" : "";
        return '<button type="button" class="customer-item' + active + '" data-customer-id="' + esc(customer.id) + '">' +
          '<strong>' + esc(customer.id) + '</strong>' +
          '<span>' + esc(customer.product || '-') + ' | ' + esc(customer.status || '-') + '</span>' +
          '<span>Last: ' + esc(fmtTime(customer.lastMessageAt)) + '</span>' +
        '</button>';
      }).join("");
      list.querySelectorAll("button[data-customer-id]").forEach(button => {
        button.addEventListener("click", () => {
          activeCustomerId = button.dataset.customerId;
          render();
        });
      });
    }
    function renderThread() {
      const customer = customerRows().find(item => item.id === activeCustomerId);
      replyText.disabled = !customer;
      sendButton.disabled = !customer;
      if (!customer) {
        header.innerHTML = '<div><strong>No customer selected</strong><span>Select a customer on the left.</span></div>';
        thread.innerHTML = '<div class="empty">No conversation selected.</div>';
        return;
      }
      header.innerHTML = '<div><strong>' + esc(customer.id) + '</strong><span>' +
        esc(customer.product || '-') + ' | ' + esc(customer.status || '-') + ' | ' + esc(customer.guardrail || '') +
        '</span></div><div class="chat-header-actions"><button id="delete-conversation" class="danger" type="button">Delete Chat</button></div>';
      document.querySelector("#delete-conversation").addEventListener("click", deleteConversation);
      const messages = messagesForCustomer(activeCustomerId, true)
        .slice()
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      if (!messages.length) {
        thread.innerHTML = '<div class="empty">No messages for this customer on ' + esc(selectedChatDate()) + '.</div>';
        return;
      }
      thread.innerHTML = messages.map(message => {
        const role = message.direction === "inbound" ? "customer" : message.channel === "business_admin" ? "staff" : message.channel === "admin" ? "admin" : "agent";
        const label = role === "customer" ? "Customer" : role === "staff" ? "You" : role === "admin" ? "Admin alert" : "AI agent";
        return '<div class="row ' + role + '"><div class="bubble">' +
          '<div class="meta">' + esc(label) + ' | ' + esc(fmtTime(message.createdAt)) + '</div>' +
          esc(message.body || '') +
        '</div></div>';
      }).join("");
      thread.scrollTop = thread.scrollHeight;
    }
    function render() {
      renderList();
      renderThread();
    }
    async function load() {
      const selectedDate = selectedChatDate();
      const response = await fetch("/admin/dashboard-data?date=" + encodeURIComponent(selectedDate));
      data = await response.json();
      applyProfile(data.profile);
      document.querySelector("#status").textContent = "Loaded " + customerRows().length + " conversation(s) for " + selectedDate + ".";
      render();
    }
    async function deleteConversation() {
      if (!activeCustomerId) return;
      const deletedCustomerId = activeCustomerId;
      const ok = confirm("Delete chat with " + deletedCustomerId + "? This moves the customer to Deleted and removes them from active lists.");
      if (!ok) return;
      state.textContent = "Deleting chat for " + deletedCustomerId + "...";
      try {
        await request("/admin/customer/delete", {
          customerId: deletedCustomerId,
          reason: "Manual deletion from chat inbox"
        });
        activeCustomerId = "";
        state.textContent = "Deleted chat for " + deletedCustomerId + ".";
        await load();
      } catch (error) {
        state.textContent = error.message;
      }
    }
    document.querySelector("#composer").addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = replyText.value.trim();
      if (!activeCustomerId || !text) return;
      sendButton.disabled = true;
      state.textContent = "Sending to " + activeCustomerId + "...";
      try {
        await request("/admin/manual-reply", { customerId: activeCustomerId, text });
        replyText.value = "";
        state.textContent = "Sent.";
        await load();
      } catch (error) {
        state.textContent = error.message;
      } finally {
        sendButton.disabled = false;
        replyText.focus();
      }
    });
    search.addEventListener("input", render);
    chatDate.value = localDateInput(new Date());
    chatDate.addEventListener("change", () => {
      activeCustomerId = "";
      load().catch(error => {
        document.querySelector("#status").textContent = error.message;
      });
    });
    document.querySelector("#refresh").addEventListener("click", load);
    load().catch(error => {
      document.querySelector("#status").textContent = error.message;
    });
  </script>
</body>
</html>`;
}

function replyLibraryPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Reply Library</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Arial, sans-serif; color: #1d1d1f; background: #f5f5f7; --surface: #fff; --soft: #fbfbfd; --line: #d2d2d7; --muted: #6e6e73; --accent: #0071e3; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f5f7; }
    header { padding: 16px 22px 10px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); backdrop-filter: saturate(180%) blur(16px); }
    h1 { margin: 0; font-size: 20px; }
    .sub { margin-top: 4px; min-height: 18px; color: var(--muted); font-size: 13px; }
    nav { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 22px 14px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); backdrop-filter: saturate(180%) blur(16px); }
    nav a, button { border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px; background: var(--surface); color: #1d1d1f; text-decoration: none; font: inherit; font-weight: 600; cursor: pointer; }
    nav a:hover, button:hover { border-color: #a8a8ad; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    main { max-width: 1280px; margin: 0 auto; padding: 22px; display: grid; gap: 14px; }
    section { background: var(--surface); border: 1px solid #e5e5ea; border-radius: 8px; overflow: hidden; }
    h2 { margin: 0; padding: 12px 14px; font-size: 16px; background: var(--soft); border-bottom: 1px solid #e5e5ea; }
    .note { padding: 10px 14px; color: var(--muted); font-size: 13px; border-bottom: 1px solid #f0f0f2; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; min-width: 760px; border-collapse: collapse; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #f0f0f2; text-align: left; vertical-align: top; font-size: 13px; line-height: 1.4; }
    th { background: var(--soft); color: var(--muted); font-size: 12px; text-transform: uppercase; }
    td.reply { white-space: pre-wrap; max-width: 380px; }
    .pill { display: inline-block; border-radius: 999px; padding: 3px 8px; background: #e6f6e8; color: #176028; font-size: 12px; font-weight: 700; }
    .pill.off { background: #f0f0f2; color: var(--muted); }
    .empty { padding: 14px; color: var(--muted); }
    .editor { padding: 14px; display: grid; gap: 12px; }
    .fields { display: grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap: 12px; }
    .field { display: grid; gap: 7px; font-size: 13px; font-weight: 700; }
    .field.wide { grid-column: 1 / -1; }
    .field-help { color: var(--muted); font-size: 12px; font-weight: 500; line-height: 1.35; }
    .field[hidden] { display: none; }
    input, textarea, select { border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; font: inherit; background: #fff; }
    input:focus, textarea:focus, select:focus { outline: 3px solid rgba(0,113,227,.18); border-color: var(--accent); }
    textarea { min-height: 88px; resize: vertical; line-height: 1.42; }
    textarea.reply { min-height: 118px; }
    .editor-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }
    .editor-actions label { display: inline-flex; align-items: center; gap: 7px; margin-right: auto; font-size: 13px; font-weight: 700; }
    .editor-actions input { width: auto; padding: 0; }
    #faq-state, #sales-state { color: var(--muted); font-size: 13px; min-height: 18px; }
    @media (max-width: 720px) { main { padding: 14px; } .fields { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>Reply Library</h1>
    <div class="sub" id="page-state">Loading general replies...</div>
  </header>
  <nav>
    <a href="/admin/dashboard">Dashboard</a>
    <a href="/admin/chat">Chat Inbox</a>
    <a href="/admin/whatsapp-web">WhatsApp Web</a>
    <a href="/admin/analytics">Analytics</a>
    <a href="/admin/reply-library">Reply Library</a>
    <a href="/admin/product-flow">Product Flow</a>
    <a href="/admin/follow-up-settings">Follow-Up Settings</a>
    <a href="/admin/compliance">Compliance</a>
    <a href="/demo/chat">Customer Demo</a>
    <button id="refresh" type="button">Refresh</button>
    <a href="/admin/dashboard?tab=profile">Profile</a>
  </nav>
  <main>
    <section>
      <h2>General FAQ</h2>
      <div class="note">For business-level questions only, such as delivery, location, COD, payment, pickup, and stock arrival. Product-specific FAQs stay inside each product setup.</div>
      <div class="table-wrap" id="faq-list"></div>
    </section>
    <section>
      <h2 id="faq-title">New General FAQ</h2>
      <form id="faq-form" class="editor">
        <input id="faq-id" type="hidden" />
        <div class="fields">
          <label class="field wide" for="faq-topic-key">FAQ Topic / Category
            <select id="faq-topic-key"></select>
            <span class="field-help">Choose an existing topic for similar questions, or choose "Add new FAQ topic" to create a new category.</span>
          </label>
          <label class="field wide" id="faq-new-topic-wrap" for="faq-new-topic">New FAQ Topic Name
            <input id="faq-new-topic" />
            <span class="field-help">Example: Delivery Fee. This creates the stable topic used by the AI classifier.</span>
          </label>
          <label class="field wide" for="faq-topic">Topic Name Shown in Library
            <input id="faq-topic" required />
            <span class="field-help">This is the admin-facing display name. Keep it short and clear.</span>
          </label>
          <label class="field wide" for="faq-examples">Example Customer Questions <textarea id="faq-examples" required></textarea></label>
          <label class="field wide" for="faq-reply">Approved Reply <textarea class="reply" id="faq-reply" required></textarea></label>
        </div>
        <div class="editor-actions">
          <label for="faq-active"><input id="faq-active" type="checkbox" checked /> Active</label>
          <button id="new-faq" type="button">New General FAQ</button>
          <button class="primary" id="save-faq" type="submit">Save FAQ</button>
        </div>
        <div id="faq-state"></div>
      </form>
    </section>
    <section>
      <h2>General Sales Replies</h2>
      <div class="note">For sales objections and hesitation replies that can apply across products. Sales replies are general only.</div>
      <div class="table-wrap" id="sales-list"></div>
    </section>
    <section>
      <h2 id="sales-title">New General Sales Reply</h2>
      <form id="sales-form" class="editor">
        <input id="sales-id" type="hidden" />
        <div class="fields">
          <label class="field wide" for="sales-intent-key">Sales Intent / Category
            <select id="sales-intent-key"></select>
            <span class="field-help">Choose an existing hesitation/objection intent, or choose "Add new sales intent".</span>
          </label>
          <label class="field wide" id="sales-new-intent-wrap" for="sales-new-intent">New Sales Intent Name
            <input id="sales-new-intent" />
            <span class="field-help">Example: Wants to ask husband first. This creates the stable intent used by the sales classifier.</span>
          </label>
          <label class="field wide" for="sales-intent-label">Sales Intent Name Shown in Library
            <input id="sales-intent-label" required />
            <span class="field-help">This is the admin-facing display name for the sales reply category.</span>
          </label>
          <label class="field wide" for="sales-examples">Example Customer Messages <textarea id="sales-examples" required></textarea></label>
          <label class="field wide" for="sales-approved">Approved Sales Reply <textarea class="reply" id="sales-approved" required></textarea></label>
          <label class="field wide" for="sales-repeat-action">Same Intent Again <select id="sales-repeat-action"></select></label>
        </div>
        <div class="editor-actions">
          <label for="sales-active"><input id="sales-active" type="checkbox" checked /> Active</label>
          <button id="new-sales" type="button">New General Sales Reply</button>
          <button class="primary" id="save-sales" type="submit">Save Sales Reply</button>
        </div>
        <div id="sales-state"></div>
      </form>
    </section>
  </main>
  <script>
    let faqLibrary = { general: [] };
    let salesLibrary = { general: [] };
    const salesIntentOptions = ${JSON.stringify(SALES_INTENT_OPTIONS)};
    const salesRepeatActionOptions = ${JSON.stringify(SALES_REPEAT_ACTION_OPTIONS)};
    function esc(value) { return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]); }
    function readableLabel(value) {
      return String(value || "").replace(/[_-]+/g, " ").replace(/\\s+/g, " ").trim().replace(/\\b\\w/g, ch => ch.toUpperCase());
    }
    function stableKey(value, fallback) {
      return String(value || fallback || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || String(fallback || "custom").toLowerCase();
    }
    const faqTopicLabelMap = new Map([
      ["Business or warehouse location and how delivery is arranged", "Business / warehouse location"],
      ["Whether customer needs to pay a delivery charge or whether delivery is free", "Delivery fee"],
      ["Whether delivery service is available", "Delivery availability"],
      ["Whether customer may pay at the end of the month", "End-of-month payment"],
      ["How many days new stock takes to arrive", "Stock arrival time"],
      ["Whether the business delivers the arrived item or customer must collect it", "Delivery or self-collect"],
      ["Learned: Kedai dekat mane?", "Business location"],
      ["Learned: Kedai dekat mana?", "Business location"],
    ]);
    function friendlyFaqTopicLabel(value) {
      const text = String(value || "").trim();
      return faqTopicLabelMap.get(text) || text.replace(/^Learned:\\s*/i, "");
    }
    function salesIntentKey(reply) { return reply.sales_intent || reply.intent_key || String(reply.objection_type || "").toLowerCase().replace(/[\\s-]+/g, "_"); }
    function salesIntentLabel(key, reply) { return (salesIntentOptions.find(item => item.key === key) || {}).label || reply?.objection_type || readableLabel(key) || ""; }
    function salesIntentChoices() {
      const choices = [...salesIntentOptions];
      (salesLibrary.general || []).forEach(reply => {
        const key = salesIntentKey(reply);
        if (key && !choices.some(item => item.key === key)) choices.push({ key, label: salesIntentLabel(key, reply) });
      });
      return choices;
    }
    function renderSalesIntentOptions(selected) {
      return '<option value="">Add new sales intent</option>' + salesIntentChoices().map(item => '<option value="' + esc(item.key) + '"' + (item.key === selected ? ' selected' : '') + '>' + esc(item.label) + '</option>').join('');
    }
    function salesRepeatActionKey(reply) { return reply.repeat_action || "openai_acknowledge"; }
    function salesRepeatActionLabel(key) { return (salesRepeatActionOptions.find(item => item.key === key) || {}).label || key || ""; }
    function renderSalesRepeatActionOptions(selected) {
      return salesRepeatActionOptions.map(item => '<option value="' + esc(item.key) + '"' + (item.key === selected ? ' selected' : '') + '>' + esc(item.label) + '</option>').join('');
    }
    function faqTopicKey(faq) { return faq.topic_key || faq.topicKey || faq.id || ""; }
    function renderFaqTopicOptions(selected) {
      const records = faqLibrary.general || [];
      return '<option value="">Add new FAQ topic</option>' + records.map(faq => '<option value="' + esc(faqTopicKey(faq)) + '"' + (faqTopicKey(faq) === selected ? ' selected' : '') + '>' + esc(friendlyFaqTopicLabel(faq.topic || faq.id)) + '</option>').join('');
    }
    function selectedFaqTopic() {
      const key = document.querySelector("#faq-topic-key").value;
      return (faqLibrary.general || []).find(faq => faqTopicKey(faq) === key);
    }
    function selectedSalesIntent() {
      const key = document.querySelector("#sales-intent-key").value;
      return (salesLibrary.general || []).find(reply => salesIntentKey(reply) === key);
    }
    function syncFaqTopicFields() {
      const selected = selectedFaqTopic();
      const isNew = !document.querySelector("#faq-topic-key").value;
      document.querySelector("#faq-new-topic-wrap").hidden = !isNew;
      if (selected && !document.querySelector("#faq-id").value) {
        document.querySelector("#faq-topic").value = friendlyFaqTopicLabel(selected.topic || selected.id);
      }
    }
    function syncSalesIntentFields() {
      const selected = selectedSalesIntent();
      const selectedKey = document.querySelector("#sales-intent-key").value;
      const isNew = !selectedKey;
      document.querySelector("#sales-new-intent-wrap").hidden = !isNew;
      if (selected && !document.querySelector("#sales-id").value) {
        document.querySelector("#sales-intent-label").value = salesIntentLabel(selectedKey, selected);
      } else if (!selected && selectedKey) {
        document.querySelector("#sales-intent-label").value = salesIntentLabel(selectedKey);
      }
    }
    function renderFaqRows(records) {
      if (!records.length) return '<div class="empty">No general FAQs yet.</div>';
      return '<table><thead><tr><th>Topic</th><th>Example Questions</th><th>Approved Reply</th><th>Status</th><th></th></tr></thead><tbody>' + records.map(faq => {
        const questions = (faq.example_questions || []).map(esc).join('<br>');
        const status = faq.active === false ? '<span class="pill off">Inactive</span>' : '<span class="pill">Active</span>';
        return '<tr><td>' + esc(friendlyFaqTopicLabel(faq.topic)) + '</td><td>' + questions + '</td><td class="reply">' + esc(faq.approved_reply) + '</td><td>' + status + '</td><td><button type="button" class="edit-faq" data-id="' + esc(faq.id) + '">Edit</button> <button type="button" class="delete-faq" data-id="' + esc(faq.id) + '" data-topic="' + esc(friendlyFaqTopicLabel(faq.topic || faq.id)) + '">Delete</button></td></tr>';
      }).join('') + '</tbody></table>';
    }
    function renderSalesRows(records) {
      if (!records.length) return '<div class="empty">No general sales replies yet.</div>';
      return '<table><thead><tr><th>Sales Intent</th><th>Examples</th><th>Approved Reply</th><th>Same Intent Again</th><th>Status</th><th></th></tr></thead><tbody>' + records.map(reply => {
        const examples = (reply.example_messages || []).map(esc).join('<br>');
        const status = reply.active === false ? '<span class="pill off">Inactive</span>' : '<span class="pill">Active</span>';
        const intentKey = salesIntentKey(reply);
        return '<tr><td>' + esc(salesIntentLabel(intentKey, reply)) + '</td><td>' + examples + '</td><td class="reply">' + esc(reply.approved_reply) + '</td><td>' + esc(salesRepeatActionLabel(salesRepeatActionKey(reply))) + '</td><td>' + status + '</td><td><button type="button" class="edit-sales" data-id="' + esc(reply.id) + '">Edit</button> <button type="button" class="delete-sales" data-id="' + esc(reply.id) + '" data-label="' + esc(salesIntentLabel(intentKey, reply) || reply.id) + '">Delete</button></td></tr>';
      }).join('') + '</tbody></table>';
    }
    function renderFaq() {
      document.querySelector("#faq-topic-key").innerHTML = renderFaqTopicOptions(document.querySelector("#faq-topic-key").value);
      document.querySelector("#faq-list").innerHTML = renderFaqRows(faqLibrary.general || []);
      document.querySelectorAll(".edit-faq").forEach(button => button.addEventListener("click", () => editFaq(button.dataset.id)));
      document.querySelectorAll(".delete-faq").forEach(button => button.addEventListener("click", () => deleteFaq(button.dataset.id, button.dataset.topic)));
      syncFaqTopicFields();
    }
    function renderSales() {
      document.querySelector("#sales-intent-key").innerHTML = renderSalesIntentOptions(document.querySelector("#sales-intent-key").value);
      document.querySelector("#sales-list").innerHTML = renderSalesRows(salesLibrary.general || []);
      document.querySelectorAll(".edit-sales").forEach(button => button.addEventListener("click", () => editSales(button.dataset.id)));
      document.querySelectorAll(".delete-sales").forEach(button => button.addEventListener("click", () => deleteSales(button.dataset.id, button.dataset.label)));
      syncSalesIntentFields();
    }
    function newFaq() {
      document.querySelector("#faq-id").value = ""; document.querySelector("#faq-topic-key").innerHTML = renderFaqTopicOptions(""); document.querySelector("#faq-new-topic").value = ""; document.querySelector("#faq-topic").value = ""; document.querySelector("#faq-examples").value = ""; document.querySelector("#faq-reply").value = ""; document.querySelector("#faq-active").checked = true; document.querySelector("#faq-title").textContent = "New General FAQ"; document.querySelector("#faq-state").textContent = ""; syncFaqTopicFields();
    }
    function editFaq(id) {
      const faq = (faqLibrary.general || []).find(item => item.id === id); if (!faq) return;
      document.querySelector("#faq-id").value = faq.id; document.querySelector("#faq-topic-key").innerHTML = renderFaqTopicOptions(faqTopicKey(faq)); document.querySelector("#faq-new-topic").value = ""; document.querySelector("#faq-topic").value = friendlyFaqTopicLabel(faq.topic || ""); document.querySelector("#faq-examples").value = (faq.example_questions || []).join("\\n"); document.querySelector("#faq-reply").value = faq.approved_reply || ""; document.querySelector("#faq-active").checked = faq.active !== false; document.querySelector("#faq-title").textContent = "Edit General FAQ"; document.querySelector("#faq-state").textContent = ""; syncFaqTopicFields();
    }
    function newSales() {
      document.querySelector("#sales-id").value = ""; document.querySelector("#sales-intent-key").innerHTML = renderSalesIntentOptions(""); document.querySelector("#sales-new-intent").value = ""; document.querySelector("#sales-intent-label").value = ""; document.querySelector("#sales-examples").value = ""; document.querySelector("#sales-approved").value = ""; document.querySelector("#sales-repeat-action").innerHTML = renderSalesRepeatActionOptions("openai_acknowledge"); document.querySelector("#sales-active").checked = true; document.querySelector("#sales-title").textContent = "New General Sales Reply"; document.querySelector("#sales-state").textContent = ""; syncSalesIntentFields();
    }
    function editSales(id) {
      const reply = (salesLibrary.general || []).find(item => item.id === id); if (!reply) return;
      document.querySelector("#sales-id").value = reply.id; document.querySelector("#sales-intent-key").innerHTML = renderSalesIntentOptions(salesIntentKey(reply)); document.querySelector("#sales-new-intent").value = ""; document.querySelector("#sales-intent-label").value = salesIntentLabel(salesIntentKey(reply), reply); document.querySelector("#sales-examples").value = (reply.example_messages || []).join("\\n"); document.querySelector("#sales-approved").value = reply.approved_reply || ""; document.querySelector("#sales-repeat-action").innerHTML = renderSalesRepeatActionOptions(salesRepeatActionKey(reply)); document.querySelector("#sales-active").checked = reply.active !== false; document.querySelector("#sales-title").textContent = "Edit General Sales Reply"; document.querySelector("#sales-state").textContent = ""; syncSalesIntentFields();
    }
    async function loadFaq() {
      const response = await fetch("/admin/faq-library-data"); faqLibrary = await response.json(); if (!response.ok) throw new Error(faqLibrary.error || "Could not load FAQ library"); renderFaq();
    }
    async function loadSales() {
      const response = await fetch("/admin/sales-replies-data"); salesLibrary = await response.json(); if (!response.ok) throw new Error(salesLibrary.error || "Could not load sales replies"); renderSales();
    }
    async function saveFaq(event) {
      event.preventDefault(); const button = document.querySelector("#save-faq"); const state = document.querySelector("#faq-state"); button.disabled = true; state.textContent = "Saving...";
      try {
        const selectedTopicKey = document.querySelector("#faq-topic-key").value;
        const newTopicName = document.querySelector("#faq-new-topic").value.trim();
        const displayName = document.querySelector("#faq-topic").value.trim() || newTopicName;
        const topicKey = selectedTopicKey || stableKey(newTopicName || displayName, "faq_topic");
        const response = await fetch("/admin/faq-library/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: document.querySelector("#faq-id").value, scope: "general", topicKey, topic: displayName, exampleQuestions: document.querySelector("#faq-examples").value.split(/\\r?\\n/), approvedReply: document.querySelector("#faq-reply").value, active: document.querySelector("#faq-active").checked }) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || "Save failed"); faqLibrary = result.data; renderFaq(); editFaq(result.faq.id); state.textContent = "Saved";
      } catch (error) { state.textContent = error.message; } finally { button.disabled = false; }
    }
    async function saveSales(event) {
      event.preventDefault(); const button = document.querySelector("#save-sales"); const state = document.querySelector("#sales-state"); button.disabled = true; state.textContent = "Saving...";
      try {
        const selectedIntentKey = document.querySelector("#sales-intent-key").value;
        const newIntentName = document.querySelector("#sales-new-intent").value.trim();
        const displayName = document.querySelector("#sales-intent-label").value.trim() || newIntentName;
        const salesIntent = selectedIntentKey || stableKey(newIntentName || displayName, "sales_intent");
        const response = await fetch("/admin/sales-replies/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: document.querySelector("#sales-id").value, scope: "general", salesIntent, salesIntentLabel: displayName, objectionType: displayName, intent: displayName ? "Customer sales response or hesitation: " + displayName : "", exampleMessages: document.querySelector("#sales-examples").value.split(/\\r?\\n/), approvedReply: document.querySelector("#sales-approved").value, repeatAction: document.querySelector("#sales-repeat-action").value, active: document.querySelector("#sales-active").checked }) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || "Save failed"); salesLibrary = result.data; renderSales(); editSales(result.salesReply.id); state.textContent = "Saved";
      } catch (error) { state.textContent = error.message; } finally { button.disabled = false; }
    }
    async function deleteFaq(id, topic) {
      if (!window.confirm('Delete FAQ "' + (topic || id) + '"?')) return;
      const response = await fetch("/admin/faq-library/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: "general", id }) });
      const result = await response.json(); if (!response.ok) { document.querySelector("#faq-state").textContent = result.error || "Delete failed"; return; }
      faqLibrary = result.data; renderFaq(); newFaq(); document.querySelector("#faq-state").textContent = "Deleted";
    }
    async function deleteSales(id, label) {
      if (!window.confirm('Delete sales reply "' + (label || id) + '"?')) return;
      const response = await fetch("/admin/sales-replies/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: "general", id }) });
      const result = await response.json(); if (!response.ok) { document.querySelector("#sales-state").textContent = result.error || "Delete failed"; return; }
      salesLibrary = result.data; renderSales(); newSales(); document.querySelector("#sales-state").textContent = "Deleted";
    }
    document.querySelector("#new-faq").addEventListener("click", newFaq);
    document.querySelector("#new-sales").addEventListener("click", newSales);
    document.querySelector("#faq-topic-key").addEventListener("change", syncFaqTopicFields);
    document.querySelector("#sales-intent-key").addEventListener("change", syncSalesIntentFields);
    document.querySelector("#faq-new-topic").addEventListener("input", () => { if (!document.querySelector("#faq-topic").value.trim()) document.querySelector("#faq-topic").value = document.querySelector("#faq-new-topic").value; });
    document.querySelector("#sales-new-intent").addEventListener("input", () => { if (!document.querySelector("#sales-intent-label").value.trim()) document.querySelector("#sales-intent-label").value = document.querySelector("#sales-new-intent").value; });
    document.querySelector("#faq-form").addEventListener("submit", saveFaq);
    document.querySelector("#sales-form").addEventListener("submit", saveSales);
    document.querySelector("#refresh").addEventListener("click", () => { loadFaq(); loadSales(); });
    Promise.all([loadFaq(), loadSales()]).then(() => { newFaq(); newSales(); document.querySelector("#page-state").textContent = "General replies ready"; }).catch(error => { document.querySelector("#page-state").textContent = error.message; });
  </script>
</body>
</html>`;
}

function faqLibraryPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Reply Library</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Arial, sans-serif; color: #1d1d1f; background: #f5f5f7; --surface: #fff; --soft: #fbfbfd; --line: #d2d2d7; --muted: #6e6e73; --accent: #0071e3; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f5f7; }
    header { padding: 16px 22px 10px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); backdrop-filter: saturate(180%) blur(16px); }
    h1 { margin: 0; font-size: 20px; }
    .sub { margin-top: 4px; min-height: 18px; color: var(--muted); font-size: 13px; }
    nav { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 22px 14px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); backdrop-filter: saturate(180%) blur(16px); }
    nav a, button { border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px; background: var(--surface); color: #1d1d1f; text-decoration: none; font: inherit; font-weight: 600; cursor: pointer; }
    nav a:hover, button:hover { border-color: #a8a8ad; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    main { max-width: 1380px; margin: 0 auto; padding: 22px; display: grid; gap: 14px; }
    section { background: var(--surface); border: 1px solid #e5e5ea; border-radius: 8px; overflow: hidden; }
    h2 { margin: 0; padding: 12px 14px; font-size: 16px; background: var(--soft); border-bottom: 1px solid #e5e5ea; }
    .section-tools { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; background: var(--soft); border-bottom: 1px solid #e5e5ea; }
    .section-tools label { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; }
    select, input, textarea { border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; font: inherit; background: #fff; }
    select:focus, input:focus, textarea:focus { outline: 3px solid rgba(0,113,227,.18); border-color: var(--accent); }
    select { min-width: 230px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; min-width: 760px; border-collapse: collapse; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #f0f0f2; text-align: left; vertical-align: top; font-size: 13px; line-height: 1.4; }
    th { background: var(--soft); color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0; }
    td.reply { white-space: pre-wrap; max-width: 360px; }
    .pill { display: inline-block; border-radius: 999px; padding: 3px 8px; background: #e6f6e8; color: #176028; font-size: 12px; font-weight: 700; }
    .pill.off { background: #f0f0f2; color: var(--muted); }
    .empty { padding: 14px; color: var(--muted); }
    .editor { padding: 14px; display: grid; gap: 12px; }
    .fields { display: grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap: 12px; }
    .field { display: grid; gap: 7px; color: #1d1d1f; font-size: 13px; font-weight: 700; }
    .field.wide { grid-column: 1 / -1; }
    textarea { min-height: 92px; resize: vertical; line-height: 1.42; }
    textarea.reply { min-height: 112px; }
    .editor-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }
    .editor-actions label { display: inline-flex; align-items: center; gap: 7px; margin-right: auto; font-size: 13px; font-weight: 700; }
    .editor-actions input { width: auto; padding: 0; }
    #save-state, #sales-save-state { color: var(--muted); font-size: 13px; min-height: 18px; }
    @media (max-width: 720px) { main { padding: 14px; } .fields { grid-template-columns: 1fr; } select { min-width: 0; max-width: 100%; } }
  </style>
</head>
<body>
  <header>
    <h1>Reply Library</h1>
    <div class="sub" id="page-state">Loading approved replies and sales replies...</div>
  </header>
  <nav>
    <a href="/admin/dashboard">Dashboard</a>
    <a href="/admin/chat">Chat Inbox</a>
    <a href="/admin/whatsapp-web">WhatsApp Web</a>
    <a href="/admin/analytics">Analytics</a>
    <a href="/admin/reply-library">Reply Library</a>
    <a href="/admin/product-flow">Product Flow</a>
    <a href="/admin/follow-up-settings">Follow-Up Settings</a>
    <a href="/admin/compliance">Compliance</a>
    <a href="/demo/chat">Customer Demo</a>
    <button id="refresh" type="button">Refresh</button>
    <a href="/admin/dashboard?tab=profile">Profile</a>
  </nav>
  <main>
    <section>
      <h2>General FAQ</h2>
      <div class="table-wrap" id="general-list"></div>
    </section>
    <section>
      <h2>Product FAQ</h2>
      <div class="section-tools">
        <label for="list-product">Product <select id="list-product"></select></label>
        <button id="new-product-faq" type="button">New Product FAQ</button>
      </div>
      <div class="table-wrap" id="product-list"></div>
    </section>
    <section>
      <h2 id="editor-title">New General FAQ</h2>
      <form id="faq-form" class="editor">
        <input id="faq-id" type="hidden" />
        <div class="fields">
          <label class="field" for="faq-scope">Scope
            <select id="faq-scope">
              <option value="general">General</option>
              <option value="product">Product</option>
            </select>
          </label>
          <label class="field" for="faq-product">Product
            <select id="faq-product" disabled></select>
          </label>
          <label class="field wide" for="faq-topic">Topic
            <input id="faq-topic" required />
          </label>
          <label class="field wide" for="faq-examples">Example Customer Questions
            <textarea id="faq-examples" required></textarea>
          </label>
          <label class="field wide" for="faq-reply">Approved Reply
            <textarea class="reply" id="faq-reply" required></textarea>
          </label>
        </div>
        <div class="editor-actions">
          <label for="faq-active"><input id="faq-active" type="checkbox" checked /> Active</label>
          <button id="new-general-faq" type="button">New General FAQ</button>
          <button class="primary" id="save-faq" type="submit">Save FAQ</button>
        </div>
        <div id="save-state"></div>
      </form>
    </section>
    <section>
      <h2>General Sales Replies</h2>
      <div class="table-wrap" id="sales-general-list"></div>
    </section>
    <section>
      <h2>Product Sales Replies</h2>
      <div class="section-tools">
        <label for="sales-list-product">Product <select id="sales-list-product"></select></label>
        <button id="sales-new-product-reply" type="button">New Product Sales Reply</button>
      </div>
      <div class="table-wrap" id="sales-product-list"></div>
    </section>
    <section>
      <h2 id="sales-editor-title">New General Sales Reply</h2>
      <form id="sales-reply-form" class="editor">
        <input id="sales-reply-id" type="hidden" />
        <div class="fields">
          <label class="field" for="sales-reply-scope">Scope
            <select id="sales-reply-scope">
              <option value="general">General</option>
              <option value="product">Product</option>
            </select>
          </label>
          <label class="field" for="sales-reply-product">Product
            <select id="sales-reply-product"></select>
          </label>
          <label class="field wide" for="sales-reply-objection">Objection Type
            <input id="sales-reply-objection" placeholder="price_concern, thinking_first, fear_concern" required />
          </label>
          <label class="field wide" for="sales-reply-intent">Intent Description
            <textarea id="sales-reply-intent" required placeholder="Customer feels the price is expensive or asks for discount."></textarea>
          </label>
          <label class="field wide" for="sales-reply-examples">Example Customer Messages
            <textarea id="sales-reply-examples" required placeholder="Mahal&#10;Ada kurang?&#10;Boleh discount?"></textarea>
          </label>
          <label class="field wide" for="sales-reply-approved">Approved Sales Reply
            <textarea class="reply" id="sales-reply-approved" required></textarea>
          </label>
        </div>
        <div class="editor-actions">
          <label for="sales-reply-active"><input id="sales-reply-active" type="checkbox" checked /> Active</label>
          <button id="sales-new-general-reply" type="button">New General Sales Reply</button>
          <button class="primary" id="sales-save-reply" type="submit">Save Sales Reply</button>
        </div>
        <div id="sales-save-state"></div>
      </form>
    </section>
  </main>
  <script>
    let library = { general: [], products: [] };
    let selectedProductId = "";

    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, function(ch) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
      });
    }

    function productById(id) {
      return library.products.find(function(product) { return product.id === id; });
    }

    function renderRows(records, scope, productId) {
      if (!records.length) return '<div class="empty">No approved FAQs yet.</div>';
      return '<table><thead><tr><th>Topic</th><th>Example Questions</th><th>Approved Reply</th><th>Status</th><th></th></tr></thead><tbody>' +
        records.map(function(faq) {
          const questions = (faq.example_questions || []).map(esc).join('<br>');
          const status = faq.active === false ? '<span class="pill off">Inactive</span>' : '<span class="pill">Active</span>';
          return '<tr><td>' + esc(faq.topic) + '</td><td>' + questions + '</td><td class="reply">' +
            esc(faq.approved_reply) + '</td><td>' + status + '</td><td><button type="button" class="edit-faq" data-scope="' +
            esc(scope) + '" data-product="' + esc(productId || "") + '" data-id="' + esc(faq.id) + '">Edit</button> ' +
            '<button type="button" class="delete-faq" data-scope="' + esc(scope) + '" data-product="' +
            esc(productId || "") + '" data-id="' + esc(faq.id) + '" data-topic="' + esc(faq.topic || faq.id) +
            '">Delete</button></td></tr>';
        }).join('') + '</tbody></table>';
    }

    function fillProductOptions() {
      const options = library.products.map(function(product) {
        return '<option value="' + esc(product.id) + '">' + esc(product.name) + '</option>';
      }).join('');
      document.querySelector("#list-product").innerHTML = options;
      document.querySelector("#faq-product").innerHTML = options;
      if (!selectedProductId && library.products[0]) selectedProductId = library.products[0].id;
      document.querySelector("#list-product").value = selectedProductId;
      document.querySelector("#faq-product").value = selectedProductId;
    }

    function bindEditButtons() {
      document.querySelectorAll(".edit-faq").forEach(function(button) {
        button.addEventListener("click", function() {
          editFaq(button.dataset.scope, button.dataset.product, button.dataset.id);
        });
      });
      document.querySelectorAll(".delete-faq").forEach(function(button) {
        button.addEventListener("click", function() {
          deleteFaq(button.dataset.scope, button.dataset.product, button.dataset.id, button.dataset.topic);
        });
      });
    }

    function render() {
      fillProductOptions();
      document.querySelector("#general-list").innerHTML = renderRows(library.general, "general", "");
      const product = productById(selectedProductId);
      document.querySelector("#product-list").innerHTML = renderRows(product ? product.faqs : [], "product", selectedProductId);
      bindEditButtons();
    }

    function setScope(scope) {
      const isProduct = scope === "product";
      document.querySelector("#faq-scope").value = scope;
      document.querySelector("#faq-product").disabled = !isProduct;
    }

    function newFaq(scope) {
      document.querySelector("#faq-id").value = "";
      document.querySelector("#faq-topic").value = "";
      document.querySelector("#faq-examples").value = "";
      document.querySelector("#faq-reply").value = "";
      document.querySelector("#faq-active").checked = true;
      setScope(scope);
      document.querySelector("#editor-title").textContent = scope === "product" ? "New Product FAQ" : "New General FAQ";
      document.querySelector("#save-state").textContent = "";
      document.querySelector("#faq-topic").focus();
    }

    function editFaq(scope, productId, id) {
      const records = scope === "general" ? library.general : ((productById(productId) || {}).faqs || []);
      const faq = records.find(function(record) { return record.id === id; });
      if (!faq) return;
      if (productId) {
        selectedProductId = productId;
        render();
      }
      setScope(scope);
      document.querySelector("#faq-product").value = productId || selectedProductId;
      document.querySelector("#faq-id").value = faq.id;
      document.querySelector("#faq-topic").value = faq.topic || "";
      document.querySelector("#faq-examples").value = (faq.example_questions || []).join("\\n");
      document.querySelector("#faq-reply").value = faq.approved_reply || "";
      document.querySelector("#faq-active").checked = faq.active !== false;
      document.querySelector("#editor-title").textContent = "Edit " + (scope === "product" ? "Product" : "General") + " FAQ";
      document.querySelector("#save-state").textContent = "";
    }

    async function loadLibrary() {
      const response = await fetch("/admin/faq-library-data");
      library = await response.json();
      if (!response.ok) throw new Error(library.error || "Could not load FAQ library");
      if (!selectedProductId && library.products[0]) selectedProductId = library.products[0].id;
      render();
      document.querySelector("#page-state").textContent = "Approved replies ready";
    }

    async function saveFaq(event) {
      event.preventDefault();
      const button = document.querySelector("#save-faq");
      const state = document.querySelector("#save-state");
      button.disabled = true;
      state.textContent = "Saving...";
      const body = {
        id: document.querySelector("#faq-id").value,
        scope: document.querySelector("#faq-scope").value,
        productId: document.querySelector("#faq-product").value,
        topic: document.querySelector("#faq-topic").value,
        exampleQuestions: document.querySelector("#faq-examples").value.split(/\\r?\\n/),
        approvedReply: document.querySelector("#faq-reply").value,
        active: document.querySelector("#faq-active").checked
      };
      try {
        const response = await fetch("/admin/faq-library/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Save failed");
        library = result.data;
        if (body.scope === "product") selectedProductId = body.productId;
        render();
        editFaq(body.scope, body.productId, result.faq.id);
        state.textContent = "Saved";
      } catch (error) {
        state.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    }

    async function deleteFaq(scope, productId, id, topic) {
      const label = topic || id;
      if (!window.confirm('Delete FAQ "' + label + '"? This cannot be undone.')) return;
      const state = document.querySelector("#save-state");
      state.textContent = "Deleting...";
      try {
        const response = await fetch("/admin/faq-library/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope, productId, id })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Delete failed");
        library = result.data;
        if (scope === "product" && productId) selectedProductId = productId;
        render();
        newFaq(scope);
        state.textContent = "Deleted";
      } catch (error) {
        state.textContent = error.message;
      }
    }

    document.querySelector("#list-product").addEventListener("change", function(event) {
      selectedProductId = event.target.value;
      render();
    });
    document.querySelector("#faq-scope").addEventListener("change", function(event) {
      setScope(event.target.value);
    });
    document.querySelector("#new-product-faq").addEventListener("click", function() { newFaq("product"); });
    document.querySelector("#new-general-faq").addEventListener("click", function() { newFaq("general"); });
    let salesLibrary = { general: [], products: [] };
    let salesSelectedProductId = "";

    function salesProductById(id) {
      return salesLibrary.products.find(function(product) { return product.id === id; });
    }

    function renderSalesRows(records, scope, productId) {
      if (!records.length) return '<div class="empty">No sales replies yet.</div>';
      return '<table><thead><tr><th>Objection</th><th>Intent</th><th>Examples</th><th>Approved Reply</th><th>Status</th><th></th></tr></thead><tbody>' +
        records.map(function(reply) {
          const examples = (reply.example_messages || []).map(esc).join('<br>');
          const status = reply.legacy_standard_reply
            ? '<span class="pill off">Legacy</span>'
            : reply.active === false ? '<span class="pill off">Inactive</span>' : '<span class="pill">Active</span>';
          return '<tr><td>' + esc(reply.objection_type) + '</td><td>' + esc(reply.intent || "") + '</td><td>' + examples +
            '</td><td class="reply">' + esc(reply.approved_reply) +
            '</td><td>' + status + '</td><td><button type="button" class="sales-edit-reply" data-scope="' + esc(scope) +
            '" data-product="' + esc(productId || "") + '" data-id="' + esc(reply.id) + '">Edit</button> ' +
            '<button type="button" class="sales-delete-reply" data-scope="' + esc(scope) + '" data-product="' +
            esc(productId || "") + '" data-id="' + esc(reply.id) + '" data-label="' + esc(reply.objection_type || reply.id) +
            '">Delete</button></td></tr>';
        }).join('') + '</tbody></table>';
    }

    function fillSalesProductOptions() {
      const options = salesLibrary.products.map(function(product) {
        return '<option value="' + esc(product.id) + '">' + esc(product.name) + '</option>';
      }).join('');
      document.querySelector("#sales-list-product").innerHTML = options;
      document.querySelector("#sales-reply-product").innerHTML = options;
      if (!salesSelectedProductId && salesLibrary.products[0]) salesSelectedProductId = salesLibrary.products[0].id;
      document.querySelector("#sales-list-product").value = salesSelectedProductId;
      document.querySelector("#sales-reply-product").value = salesSelectedProductId;
    }

    function bindSalesButtons() {
      document.querySelectorAll(".sales-edit-reply").forEach(function(button) {
        button.addEventListener("click", function() {
          editSalesReply(button.dataset.scope, button.dataset.product, button.dataset.id);
        });
      });
      document.querySelectorAll(".sales-delete-reply").forEach(function(button) {
        button.addEventListener("click", function() {
          deleteSalesReply(button.dataset.scope, button.dataset.product, button.dataset.id, button.dataset.label);
        });
      });
    }

    function renderSales() {
      fillSalesProductOptions();
      document.querySelector("#sales-general-list").innerHTML = renderSalesRows(salesLibrary.general, "general", "");
      const product = salesProductById(salesSelectedProductId);
      document.querySelector("#sales-product-list").innerHTML = renderSalesRows(product ? product.salesReplies : [], "product", salesSelectedProductId);
      bindSalesButtons();
    }

    function setSalesScope(scope) {
      const isProduct = scope === "product";
      document.querySelector("#sales-reply-scope").value = scope;
      document.querySelector("#sales-reply-product").disabled = !isProduct;
    }

    function newSalesReply(scope) {
      document.querySelector("#sales-reply-id").value = "";
      document.querySelector("#sales-reply-objection").value = "";
      document.querySelector("#sales-reply-intent").value = "";
      document.querySelector("#sales-reply-examples").value = "";
      document.querySelector("#sales-reply-approved").value = "";
      document.querySelector("#sales-reply-active").checked = true;
      setSalesScope(scope);
      document.querySelector("#sales-editor-title").textContent = scope === "product" ? "New Product Sales Reply" : "New General Sales Reply";
      document.querySelector("#sales-save-state").textContent = "";
    }

    function editSalesReply(scope, productId, id) {
      const records = scope === "general" ? salesLibrary.general : ((salesProductById(productId) || {}).salesReplies || []);
      const reply = records.find(function(record) { return record.id === id; });
      if (!reply) return;
      if (productId) {
        salesSelectedProductId = productId;
        renderSales();
      }
      setSalesScope(scope);
      document.querySelector("#sales-reply-product").value = productId || salesSelectedProductId;
      document.querySelector("#sales-reply-id").value = reply.id;
      document.querySelector("#sales-reply-objection").value = reply.objection_type || "";
      document.querySelector("#sales-reply-intent").value = reply.intent || "";
      document.querySelector("#sales-reply-examples").value = (reply.example_messages || []).join("\\n");
      document.querySelector("#sales-reply-approved").value = reply.approved_reply || "";
      document.querySelector("#sales-reply-active").checked = reply.active !== false;
      document.querySelector("#sales-editor-title").textContent = "Edit " + (scope === "product" ? "Product" : "General") + " Sales Reply";
      document.querySelector("#sales-save-state").textContent = "";
    }

    async function loadSalesLibrary() {
      const response = await fetch("/admin/sales-replies-data");
      salesLibrary = await response.json();
      if (!response.ok) throw new Error(salesLibrary.error || "Could not load sales reply library");
      if (!salesSelectedProductId && salesLibrary.products[0]) salesSelectedProductId = salesLibrary.products[0].id;
      renderSales();
    }

    async function saveSalesReply(event) {
      event.preventDefault();
      const button = document.querySelector("#sales-save-reply");
      const state = document.querySelector("#sales-save-state");
      button.disabled = true;
      state.textContent = "Saving...";
      const body = {
        id: document.querySelector("#sales-reply-id").value,
        scope: document.querySelector("#sales-reply-scope").value,
        productId: document.querySelector("#sales-reply-product").value,
        objectionType: document.querySelector("#sales-reply-objection").value,
        intent: document.querySelector("#sales-reply-intent").value,
        exampleMessages: document.querySelector("#sales-reply-examples").value.split(/\\r?\\n/),
        approvedReply: document.querySelector("#sales-reply-approved").value,
        active: document.querySelector("#sales-reply-active").checked
      };
      try {
        const response = await fetch("/admin/sales-replies/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Save failed");
        salesLibrary = result.data;
        if (body.scope === "product") salesSelectedProductId = body.productId;
        renderSales();
        editSalesReply(body.scope, body.productId, result.salesReply.id);
        state.textContent = "Saved";
      } catch (error) {
        state.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    }

    async function deleteSalesReply(scope, productId, id, label) {
      if (!window.confirm('Delete sales reply "' + (label || id) + '"? This cannot be undone.')) return;
      const state = document.querySelector("#sales-save-state");
      state.textContent = "Deleting...";
      try {
        const response = await fetch("/admin/sales-replies/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope, productId, id })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Delete failed");
        salesLibrary = result.data;
        if (scope === "product" && productId) salesSelectedProductId = productId;
        renderSales();
        newSalesReply(scope);
        state.textContent = "Deleted";
      } catch (error) {
        state.textContent = error.message;
      }
    }

    document.querySelector("#sales-list-product").addEventListener("change", function(event) {
      salesSelectedProductId = event.target.value;
      renderSales();
    });
    document.querySelector("#sales-reply-scope").addEventListener("change", function(event) {
      setSalesScope(event.target.value);
    });
    document.querySelector("#sales-new-product-reply").addEventListener("click", function() { newSalesReply("product"); });
    document.querySelector("#sales-new-general-reply").addEventListener("click", function() { newSalesReply("general"); });
    document.querySelector("#sales-reply-form").addEventListener("submit", saveSalesReply);

    document.querySelector("#faq-form").addEventListener("submit", saveFaq);
    document.querySelector("#refresh").addEventListener("click", function() {
      loadLibrary();
      loadSalesLibrary();
    });
    loadLibrary().then(function() { newFaq("general"); }).catch(function(error) {
      document.querySelector("#page-state").textContent = error.message;
    });
    loadSalesLibrary().then(function() { newSalesReply("general"); }).catch(function(error) {
      document.querySelector("#sales-save-state").textContent = error.message;
    });
  </script>
</body>
</html>`;
}

function salesRepliesPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sales Replies</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Arial, sans-serif; color: #1d1d1f; background: #f5f5f7; --surface: #fff; --soft: #fbfbfd; --line: #d2d2d7; --muted: #6e6e73; --accent: #0071e3; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f5f7; }
    header { padding: 16px 22px 10px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); backdrop-filter: saturate(180%) blur(16px); }
    h1 { margin: 0; font-size: 20px; }
    .sub { margin-top: 4px; min-height: 18px; color: var(--muted); font-size: 13px; }
    nav { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 22px 14px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); backdrop-filter: saturate(180%) blur(16px); }
    nav a, button { border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px; background: var(--surface); color: #1d1d1f; text-decoration: none; font: inherit; font-weight: 600; cursor: pointer; }
    nav a:hover, button:hover { border-color: #a8a8ad; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    main { max-width: 1380px; margin: 0 auto; padding: 22px; display: grid; gap: 14px; }
    section { background: var(--surface); border: 1px solid #e5e5ea; border-radius: 8px; overflow: hidden; }
    h2 { margin: 0; padding: 12px 14px; font-size: 16px; background: var(--soft); border-bottom: 1px solid #e5e5ea; }
    .section-tools { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; background: var(--soft); border-bottom: 1px solid #e5e5ea; }
    .section-tools label { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; }
    select, input, textarea { border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; font: inherit; background: #fff; }
    select:focus, input:focus, textarea:focus { outline: 3px solid rgba(0,113,227,.18); border-color: var(--accent); }
    select { min-width: 230px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; min-width: 900px; border-collapse: collapse; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #f0f0f2; text-align: left; vertical-align: top; font-size: 13px; line-height: 1.4; }
    th { background: var(--soft); color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0; }
    td.reply { white-space: pre-wrap; max-width: 360px; }
    .pill { display: inline-block; border-radius: 999px; padding: 3px 8px; background: #e6f6e8; color: #176028; font-size: 12px; font-weight: 700; }
    .pill.off { background: #f0f0f2; color: var(--muted); }
    .empty { padding: 14px; color: var(--muted); }
    .editor { padding: 14px; display: grid; gap: 12px; }
    .fields { display: grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap: 12px; }
    .field { display: grid; gap: 7px; font-size: 13px; font-weight: 700; }
    .field.wide { grid-column: 1 / -1; }
    textarea { min-height: 82px; resize: vertical; line-height: 1.42; font-weight: 400; }
    textarea.reply { min-height: 120px; }
    .editor-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    #save-state { min-height: 18px; color: var(--muted); font-size: 13px; }
    @media (max-width: 760px) { main { padding: 14px; } .fields { grid-template-columns: 1fr; } select { min-width: 0; width: 100%; } }
  </style>
</head>
<body>
  <header>
    <h1>Sales Replies</h1>
    <div class="sub" id="page-state">Loading sales reply library...</div>
  </header>
  <nav>
    <a href="/admin/dashboard">Dashboard</a>
    <a href="/admin/chat">Chat Inbox</a>
    <a href="/admin/whatsapp-web">WhatsApp Web</a>
    <a href="/admin/analytics">Analytics</a>
    <a href="/admin/reply-library">Reply Library</a>
    <a href="/admin/product-flow">Product Flow</a>
    <a href="/admin/follow-up-settings">Follow-Up Settings</a>
    <a href="/admin/compliance">Compliance</a>
    <a href="/demo/chat">Customer Demo</a>
    <button id="refresh" type="button">Refresh</button>
    <a href="/admin/dashboard?tab=profile">Profile</a>
  </nav>
  <main>
    <section>
      <h2>General Sales Replies</h2>
      <div class="table-wrap" id="general-list"></div>
    </section>
    <section>
      <h2>Product Sales Replies</h2>
      <div class="section-tools">
        <label for="list-product">Product <select id="list-product"></select></label>
        <button id="new-product-reply" type="button">New Product Sales Reply</button>
      </div>
      <div class="table-wrap" id="product-list"></div>
    </section>
    <section>
      <h2 id="editor-title">New General Sales Reply</h2>
      <form id="reply-form" class="editor">
        <input id="reply-id" type="hidden" />
        <div class="fields">
          <label class="field" for="reply-scope">Scope
            <select id="reply-scope">
              <option value="general">General</option>
              <option value="product">Product</option>
            </select>
          </label>
          <label class="field" for="reply-product">Product
            <select id="reply-product"></select>
          </label>
          <label class="field wide" for="reply-objection">Objection Type
            <input id="reply-objection" placeholder="price_concern, thinking_first, fear_concern" required />
          </label>
          <label class="field wide" for="reply-intent">Intent Description
            <textarea id="reply-intent" required placeholder="Customer feels the price is expensive or asks for discount."></textarea>
          </label>
          <label class="field wide" for="reply-examples">Example Customer Messages
            <textarea id="reply-examples" required placeholder="Mahal&#10;Ada kurang?&#10;Boleh discount?"></textarea>
          </label>
          <label class="field wide" for="reply-approved">Approved Sales Reply
            <textarea class="reply" id="reply-approved" required></textarea>
          </label>
        </div>
        <div class="editor-actions">
          <label for="reply-active"><input id="reply-active" type="checkbox" checked /> Active</label>
          <button id="new-general-reply" type="button">New General Sales Reply</button>
          <button class="primary" id="save-reply" type="submit">Save Sales Reply</button>
        </div>
        <div id="save-state"></div>
      </form>
    </section>
  </main>
  <script>
    let library = { general: [], products: [] };
    let selectedProductId = "";

    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, function(ch) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
      });
    }

    function productById(id) {
      return library.products.find(function(product) { return product.id === id; });
    }

    function renderRows(records, scope, productId) {
      if (!records.length) return '<div class="empty">No sales replies yet.</div>';
      return '<table><thead><tr><th>Objection</th><th>Intent</th><th>Examples</th><th>Approved Reply</th><th>Status</th><th></th></tr></thead><tbody>' +
        records.map(function(reply) {
          const examples = (reply.example_messages || []).map(esc).join('<br>');
          const status = reply.legacy_standard_reply
            ? '<span class="pill off">Legacy</span>'
            : reply.active === false ? '<span class="pill off">Inactive</span>' : '<span class="pill">Active</span>';
          return '<tr><td>' + esc(reply.objection_type) + '</td><td>' + esc(reply.intent || "") + '</td><td>' + examples +
            '</td><td class="reply">' + esc(reply.approved_reply) +
            '</td><td>' + status + '</td><td><button type="button" class="edit-reply" data-scope="' + esc(scope) +
            '" data-product="' + esc(productId || "") + '" data-id="' + esc(reply.id) + '">Edit</button> ' +
            '<button type="button" class="delete-reply" data-scope="' + esc(scope) + '" data-product="' +
            esc(productId || "") + '" data-id="' + esc(reply.id) + '" data-label="' + esc(reply.objection_type || reply.id) +
            '">Delete</button></td></tr>';
        }).join('') + '</tbody></table>';
    }

    function fillProductOptions() {
      const options = library.products.map(function(product) {
        return '<option value="' + esc(product.id) + '">' + esc(product.name) + '</option>';
      }).join('');
      document.querySelector("#list-product").innerHTML = options;
      document.querySelector("#reply-product").innerHTML = options;
      if (!selectedProductId && library.products[0]) selectedProductId = library.products[0].id;
      document.querySelector("#list-product").value = selectedProductId;
      document.querySelector("#reply-product").value = selectedProductId;
    }

    function bindButtons() {
      document.querySelectorAll(".edit-reply").forEach(function(button) {
        button.addEventListener("click", function() {
          editReply(button.dataset.scope, button.dataset.product, button.dataset.id);
        });
      });
      document.querySelectorAll(".delete-reply").forEach(function(button) {
        button.addEventListener("click", function() {
          deleteReply(button.dataset.scope, button.dataset.product, button.dataset.id, button.dataset.label);
        });
      });
    }

    function render() {
      fillProductOptions();
      document.querySelector("#general-list").innerHTML = renderRows(library.general, "general", "");
      const product = productById(selectedProductId);
      document.querySelector("#product-list").innerHTML = renderRows(product ? product.salesReplies : [], "product", selectedProductId);
      bindButtons();
    }

    function setScope(scope) {
      const isProduct = scope === "product";
      document.querySelector("#reply-scope").value = scope;
      document.querySelector("#reply-product").disabled = !isProduct;
    }

    function newReply(scope) {
      document.querySelector("#reply-id").value = "";
      document.querySelector("#reply-objection").value = "";
      document.querySelector("#reply-intent").value = "";
      document.querySelector("#reply-examples").value = "";
      document.querySelector("#reply-approved").value = "";
      document.querySelector("#reply-active").checked = true;
      setScope(scope);
      document.querySelector("#editor-title").textContent = scope === "product" ? "New Product Sales Reply" : "New General Sales Reply";
      document.querySelector("#save-state").textContent = "";
      document.querySelector("#reply-objection").focus();
    }

    function editReply(scope, productId, id) {
      const records = scope === "general" ? library.general : ((productById(productId) || {}).salesReplies || []);
      const reply = records.find(function(record) { return record.id === id; });
      if (!reply) return;
      if (productId) {
        selectedProductId = productId;
        render();
      }
      setScope(scope);
      document.querySelector("#reply-product").value = productId || selectedProductId;
      document.querySelector("#reply-id").value = reply.id;
      document.querySelector("#reply-objection").value = reply.objection_type || "";
      document.querySelector("#reply-intent").value = reply.intent || "";
      document.querySelector("#reply-examples").value = (reply.example_messages || []).join("\\n");
      document.querySelector("#reply-approved").value = reply.approved_reply || "";
      document.querySelector("#reply-active").checked = reply.active !== false;
      document.querySelector("#editor-title").textContent = "Edit " + (scope === "product" ? "Product" : "General") + " Sales Reply";
      document.querySelector("#save-state").textContent = "";
    }

    async function loadLibrary() {
      const response = await fetch("/admin/sales-replies-data");
      library = await response.json();
      if (!response.ok) throw new Error(library.error || "Could not load sales reply library");
      if (!selectedProductId && library.products[0]) selectedProductId = library.products[0].id;
      render();
      document.querySelector("#page-state").textContent = "Approved sales replies ready";
    }

    async function saveReply(event) {
      event.preventDefault();
      const button = document.querySelector("#save-reply");
      const state = document.querySelector("#save-state");
      button.disabled = true;
      state.textContent = "Saving...";
      const body = {
        id: document.querySelector("#reply-id").value,
        scope: document.querySelector("#reply-scope").value,
        productId: document.querySelector("#reply-product").value,
        objectionType: document.querySelector("#reply-objection").value,
        intent: document.querySelector("#reply-intent").value,
        exampleMessages: document.querySelector("#reply-examples").value.split(/\\r?\\n/),
        approvedReply: document.querySelector("#reply-approved").value,
        active: document.querySelector("#reply-active").checked
      };
      try {
        const response = await fetch("/admin/sales-replies/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Save failed");
        library = result.data;
        if (body.scope === "product") selectedProductId = body.productId;
        render();
        editReply(body.scope, body.productId, result.salesReply.id);
        state.textContent = "Saved";
      } catch (error) {
        state.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    }

    async function deleteReply(scope, productId, id, label) {
      if (!window.confirm('Delete sales reply "' + (label || id) + '"? This cannot be undone.')) return;
      const state = document.querySelector("#save-state");
      state.textContent = "Deleting...";
      try {
        const response = await fetch("/admin/sales-replies/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope, productId, id })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Delete failed");
        library = result.data;
        if (scope === "product" && productId) selectedProductId = productId;
        render();
        newReply(scope);
        state.textContent = "Deleted";
      } catch (error) {
        state.textContent = error.message;
      }
    }

    document.querySelector("#list-product").addEventListener("change", function(event) {
      selectedProductId = event.target.value;
      render();
    });
    document.querySelector("#reply-scope").addEventListener("change", function(event) {
      setScope(event.target.value);
    });
    document.querySelector("#new-product-reply").addEventListener("click", function() { newReply("product"); });
    document.querySelector("#new-general-reply").addEventListener("click", function() { newReply("general"); });
    document.querySelector("#reply-form").addEventListener("submit", saveReply);
    document.querySelector("#refresh").addEventListener("click", loadLibrary);
    loadLibrary().then(function() { newReply("general"); }).catch(function(error) {
      document.querySelector("#page-state").textContent = error.message;
    });
  </script>
</body>
</html>`;
}

function followupSettingsPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Follow-Up Settings</title>
  <style>
    :root { --accent:#0071e3; font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Arial,sans-serif; color:#1d1d1f; background:#f5f5f7; }
    * { box-sizing:border-box; }
    body { margin:0; }
    header { padding:16px 22px 10px; background:rgba(251,251,253,.9); border-bottom:1px solid rgba(210,210,215,.8); backdrop-filter:saturate(180%) blur(16px); }
    h1 { margin:0; font-size:20px; }
    header .muted { margin-top:4px; min-height:18px; font-size:13px; }
    .muted { color:#6e6e73; }
    nav { display:flex; flex-wrap:wrap; gap:8px; padding:10px 22px 14px; background:rgba(251,251,253,.9); border-bottom:1px solid rgba(210,210,215,.8); backdrop-filter:saturate(180%) blur(16px); }
    nav a, button { border:1px solid #d2d2d7; border-radius:8px; background:#fff; color:#1d1d1f; padding:8px 11px; text-decoration:none; font:inherit; font-weight:600; cursor:pointer; }
    button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
    main { max-width:1380px; margin:0 auto; display:grid; gap:14px; padding:22px; }
    section { background:#fff; border:1px solid #e5e5ea; border-radius:8px; overflow:hidden; }
    h2 { margin:0; padding:12px 14px; font-size:16px; background:#fbfbfd; border-bottom:1px solid #e5e5ea; }
    section > .muted { margin:12px 14px; font-size:13px; }
    .settings-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; align-items:end; padding:14px; }
    .settings-grid .wide { grid-column:1 / -1; }
    label { display:grid; gap:7px; font-size:13px; font-weight:700; }
    input, textarea, select { width:100%; border:1px solid #d2d2d7; border-radius:8px; padding:9px 10px; font:inherit; background:#fff; }
    input[type="checkbox"] { width:auto; }
    textarea { min-height:110px; resize:vertical; line-height:1.38; }
    .stage-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:14px; padding:0 14px 14px; }
    .stage-card { display:grid; gap:10px; border:1px solid #e5e5ea; border-radius:8px; padding:14px; background:#fbfbfd; }
    .stage-head { display:flex; justify-content:space-between; gap:10px; align-items:center; }
    .stage-head strong { font-size:16px; }
    .block { display:grid; gap:8px; border:1px solid #d2d2d7; border-radius:8px; padding:10px; background:#fff; }
    .block-head { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; color:#6e6e73; font-weight:800; text-transform:uppercase; }
    .block-actions { display:flex; gap:8px; flex-wrap:wrap; }
    section > .block-actions { margin-top:0 !important; padding:0 14px 14px; }
    .media-preview { max-width:100%; max-height:220px; border-radius:8px; background:#f5f5f7; }
    .danger { color:#a11; border-color:#f0c7c7; background:#fff5f5; }
    .state { color:#6e6e73; }
  </style>
</head>
<body>
  <header>
    <h1 id="page-title">Follow-Up Settings</h1>
    <p class="muted">Edit team follow-up messages, media, send hours, and first-follow-up cutoff rules.</p>
  </header>
  <nav>
    <a href="/admin/dashboard">Dashboard</a>
    <a href="/admin/chat">Chat Inbox</a>
    <a href="/admin/whatsapp-web">WhatsApp Web</a>
    <a href="/admin/analytics">Analytics</a>
    <a href="/admin/reply-library">Reply Library</a>
    <a href="/admin/product-flow">Product Flow</a>
    <a href="/admin/follow-up-settings">Follow-Up Settings</a>
    <a href="/admin/compliance">Compliance</a>
    <a href="/demo/chat">Customer Demo</a>
    <button id="refresh" type="button">Refresh</button>
    <a href="/admin/dashboard?tab=profile">Profile</a>
  </nav>
  <main>
    <section>
      <h2>Schedule Controls</h2>
      <div class="settings-grid">
        <label>Follow-Up Sends Per Minute
          <input id="followup-sends-per-minute" type="number" min="1" max="100" />
        </label>
        <label>Follow-Up Worker Interval Minutes
          <input id="followup-interval-minutes" type="number" min="1" max="1440" />
        </label>
        <label>Active Send Window Minutes
          <input id="followup-active-window-minutes" type="number" min="1" max="1440" />
        </label>
        <label>Pause Window Minutes
          <input id="followup-pause-window-minutes" type="number" min="0" max="1440" />
        </label>
        <label>
          <span><input id="first-cutoff-enabled" type="checkbox" /> Enable first follow-up cutoff</span>
          <span class="muted">When enabled, customers who first message at/after the cutoff hour skip the first follow-up until the next day.</span>
        </label>
        <label>First Follow-Up Cutoff Hour
          <input id="first-cutoff-hour" type="number" min="0" max="23" />
        </label>
      </div>
    </section>
    <section>
      <h2>Follow-Up Messages</h2>
      <p class="muted">Each stage can contain as many text, image, or video blocks as you need. Empty stages are disabled.</p>
      <div class="stage-grid" id="followup-stage-grid"></div>
    </section>
    <section>
      <h2>Another Date Purchase Follow-Up</h2>
      <p class="muted">For customers who say they will buy on another date. If no date is mentioned, this sends on the fallback day of month.</p>
      <div class="settings-grid">
        <label>
          <span><input id="another-date-enabled" type="checkbox" /> Enable another-date purchase follow-up</span>
        </label>
        <label>Fallback Day of Month
          <input id="another-date-fallback-day" type="number" min="1" max="31" />
        </label>
        <label>Send Hour
          <input id="another-date-send-hour" type="number" min="0" max="23" />
        </label>
        <label class="wide">Message Content
          <textarea id="another-date-message"></textarea>
        </label>
      </div>
    </section>
    <section>
      <div class="block-actions" style="margin-top:14px;">
        <button class="primary" id="save-followups" type="button">Save Follow-Up Settings</button>
        <span class="state" id="save-state"></span>
      </div>
    </section>
  </main>
  <script>
    const defaultFollowupStages = ${JSON.stringify(FOLLOWUP_EDITOR_STAGES.map((stage) => ({
      key: stage.key,
      label: stage.label,
      dayOffset: stage.dayOffset,
      sendHour: stage.defaultSendHour,
      message: "",
      messages: [],
      firstChatCutoffEnabled: stage.firstChatCutoffHour === undefined ? undefined : true,
      firstChatCutoffHour: stage.firstChatCutoffHour,
    })))};
    const defaultFollowupSettings = {
      followupSendsPerMinute: ${JSON.stringify(Math.max(config.followupSendsPerMinute, 1))},
      followupIntervalMinutes: ${JSON.stringify(Math.max(config.followupIntervalMinutes, 1))},
      followupActiveWindowMinutes: ${JSON.stringify(Math.max(config.followupActiveWindowMinutes, 1))},
      followupPauseWindowMinutes: ${JSON.stringify(Math.max(config.followupPauseWindowMinutes, 0))}
    };
    const defaultAnotherDatePurchaseFollowup = ${JSON.stringify(defaultAnotherDatePurchaseFollowupSettings())};
    let data = null;
    const mediaInput = document.createElement("input");
    mediaInput.type = "file";
    mediaInput.style.display = "none";
    document.body.appendChild(mediaInput);

    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, function(ch) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
      });
    }
    function blockId() {
      return "block_" + Date.now() + "_" + Math.random().toString(16).slice(2);
    }
    async function readResponseJson(response) {
      const text = await response.text();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch (error) {
        return { error: text };
      }
    }
    async function request(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const result = await readResponseJson(response);
      if (!response.ok) throw new Error(result.error || "Action failed.");
      return result;
    }
    function normalizeBlock(block) {
      if (!block || typeof block !== "object") return null;
      const type = String(block.type || "text").toLowerCase();
      if (type === "image" || type === "video") {
        return { id: block.id || blockId(), type, url: block.url || "", caption: block.caption || "" };
      }
      return { id: block.id || blockId(), type: "text", body: block.body || block.message || "" };
    }
    function render() {
      data = data && typeof data === "object" ? data : {};
      const settings = data.settings || defaultFollowupSettings;
      document.querySelector("#followup-sends-per-minute").value = settings.followupSendsPerMinute || "";
      document.querySelector("#followup-interval-minutes").value = settings.followupIntervalMinutes || "";
      document.querySelector("#followup-active-window-minutes").value = settings.followupActiveWindowMinutes || "";
      document.querySelector("#followup-pause-window-minutes").value = settings.followupPauseWindowMinutes ?? "";
      const stages = Array.isArray(data.followupMessages) && data.followupMessages.length
        ? data.followupMessages
        : defaultFollowupStages;
      const anotherDate = data.anotherDatePurchaseFollowup || defaultAnotherDatePurchaseFollowup;
      document.querySelector("#another-date-enabled").checked = anotherDate.enabled !== false;
      document.querySelector("#another-date-fallback-day").value = anotherDate.fallbackDayOfMonth || 20;
      document.querySelector("#another-date-send-hour").value = anotherDate.sendHour ?? 20;
      document.querySelector("#another-date-message").value = anotherDate.message || "";
      const first = stages.find(stage => stage.key === "first_day_followup") || {};
      document.querySelector("#first-cutoff-enabled").checked = first.firstChatCutoffEnabled !== false;
      document.querySelector("#first-cutoff-hour").value = first.firstChatCutoffHour ?? 19;
      document.querySelector("#followup-stage-grid").innerHTML = stages.map(renderStage).join("");
      bindStageButtons();
    }
    function renderStage(stage) {
      const blocks = (stage.messages || (stage.message ? [{ type: "text", body: stage.message }] : [])).map(normalizeBlock).filter(Boolean);
      if (!blocks.length) blocks.push({ id: blockId(), type: "text", body: "" });
      return '<article class="stage-card" data-stage-key="' + esc(stage.key) + '">' +
        '<div class="stage-head"><strong>' + esc(stage.label) + '</strong><span class="muted">Day offset: ' + esc(stage.dayOffset) + '</span></div>' +
        '<label>Send Hour<input data-stage-field="sendHour" type="number" min="0" max="23" value="' + esc(stage.sendHour ?? 20) + '" /></label>' +
        '<div class="blocks">' + blocks.map(renderBlock).join("") + '</div>' +
        '<div class="block-actions">' +
          '<button type="button" data-add-block="text">Add Text</button>' +
          '<button type="button" data-add-block="image">Add Image</button>' +
          '<button type="button" data-add-block="video">Add Video</button>' +
        '</div>' +
      '</article>';
    }
    function renderBlock(block) {
      if (block.type === "image") {
        return '<div class="block" data-block-id="' + esc(block.id) + '" data-block-type="image">' +
          '<div class="block-head"><span>Image</span><button class="danger" type="button" data-remove-block>Remove</button></div>' +
          '<img class="media-preview" src="' + esc(block.url) + '" alt="Follow-up image" />' +
          '<input data-block-field="url" type="hidden" value="' + esc(block.url) + '" />' +
          '<label>Caption<textarea data-block-field="caption">' + esc(block.caption || "") + '</textarea></label>' +
        '</div>';
      }
      if (block.type === "video") {
        return '<div class="block" data-block-id="' + esc(block.id) + '" data-block-type="video">' +
          '<div class="block-head"><span>Video</span><button class="danger" type="button" data-remove-block>Remove</button></div>' +
          '<video class="media-preview" controls src="' + esc(block.url) + '"></video>' +
          '<input data-block-field="url" type="hidden" value="' + esc(block.url) + '" />' +
          '<label>Caption<textarea data-block-field="caption">' + esc(block.caption || "") + '</textarea></label>' +
        '</div>';
      }
      return '<div class="block" data-block-id="' + esc(block.id) + '" data-block-type="text">' +
        '<div class="block-head"><span>Text</span><button class="danger" type="button" data-remove-block>Remove</button></div>' +
        '<textarea data-block-field="body">' + esc(block.body || "") + '</textarea>' +
      '</div>';
    }
    function bindStageButtons() {
      document.querySelectorAll("[data-add-block]").forEach(button => {
        button.addEventListener("click", () => addBlock(button.closest(".stage-card"), button.dataset.addBlock));
      });
      document.querySelectorAll("[data-remove-block]").forEach(button => {
        button.addEventListener("click", () => button.closest(".block").remove());
      });
    }
    function addBlock(card, type) {
      if (type === "text") {
        card.querySelector(".blocks").insertAdjacentHTML("beforeend", renderBlock({ id: blockId(), type: "text", body: "" }));
        bindStageButtons();
        return;
      }
      mediaInput.accept = type === "image" ? "image/png,image/jpeg,image/webp" : "video/mp4,video/webm,video/quicktime";
      mediaInput.onchange = async () => {
        const file = mediaInput.files && mediaInput.files[0];
        mediaInput.value = "";
        if (!file) return;
        const state = document.querySelector("#save-state");
        state.textContent = "Uploading " + type + "...";
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        try {
          const result = await request("/admin/followup-settings/media", { dataUrl, originalName: file.name });
          card.querySelector(".blocks").insertAdjacentHTML("beforeend", renderBlock(result.block));
          bindStageButtons();
          state.textContent = "Uploaded. Remember to save.";
        } catch (error) {
          state.textContent = error.message;
        }
      };
      mediaInput.click();
    }
    function readStage(card) {
      return {
        key: card.dataset.stageKey,
        sendHour: card.querySelector('[data-stage-field="sendHour"]').value,
        messages: [...card.querySelectorAll(".block")].map(block => {
          const type = block.dataset.blockType;
          if (type === "image" || type === "video") {
            return {
              id: block.dataset.blockId,
              type,
              url: block.querySelector('[data-block-field="url"]').value,
              caption: block.querySelector('[data-block-field="caption"]').value
            };
          }
          return {
            id: block.dataset.blockId,
            type: "text",
            body: block.querySelector('[data-block-field="body"]').value
          };
        }),
      };
    }
    async function save() {
      const state = document.querySelector("#save-state");
      state.textContent = "Saving...";
      const followups = [...document.querySelectorAll(".stage-card")].map(readStage);
      const first = followups.find(stage => stage.key === "first_day_followup");
      if (first) {
        first.firstChatCutoffEnabled = document.querySelector("#first-cutoff-enabled").checked;
        first.firstChatCutoffHour = document.querySelector("#first-cutoff-hour").value;
      }
      try {
        data = await request("/admin/followup-settings/save", {
          settings: {
            followupSendsPerMinute: document.querySelector("#followup-sends-per-minute").value,
            followupIntervalMinutes: document.querySelector("#followup-interval-minutes").value,
            followupActiveWindowMinutes: document.querySelector("#followup-active-window-minutes").value,
            followupPauseWindowMinutes: document.querySelector("#followup-pause-window-minutes").value
          },
          followups,
          anotherDatePurchaseFollowup: {
            enabled: document.querySelector("#another-date-enabled").checked,
            fallbackDayOfMonth: document.querySelector("#another-date-fallback-day").value,
            sendHour: document.querySelector("#another-date-send-hour").value,
            message: document.querySelector("#another-date-message").value,
            messages: [{ id: "text_another_date_purchase_followup", type: "text", body: document.querySelector("#another-date-message").value }]
          }
        });
        render();
        state.textContent = "Saved";
      } catch (error) {
        state.textContent = error.message;
      }
    }
    async function load() {
      const state = document.querySelector("#save-state");
      state.textContent = "Loading...";
      try {
        const response = await fetch("/admin/followup-settings-data", { cache: "no-store" });
        const result = await readResponseJson(response);
        if (!response.ok) throw new Error(result.error || "Unable to load follow-up settings.");
        data = result;
        const name = String(data.profile?.name || "").trim();
        if (name) document.querySelector("#page-title").textContent = name + " Follow-Up Settings";
        render();
        state.textContent = "";
      } catch (error) {
        data = { settings: defaultFollowupSettings, followupMessages: defaultFollowupStages, anotherDatePurchaseFollowup: defaultAnotherDatePurchaseFollowup };
        render();
        state.textContent = "Could not load saved settings: " + (error.message || error);
      }
    }
    document.querySelector("#save-followups").addEventListener("click", save);
    document.querySelector("#refresh").addEventListener("click", load);
    load();
  </script>
</body>
</html>`;
}

function productFlowPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Product Flow</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Arial, sans-serif; color: #1d1d1f; background: #f5f5f7; --surface: #ffffff; --surface-soft: #fbfbfd; --line: #d2d2d7; --muted: #6e6e73; --accent: #0071e3; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f5f7; }
    header { padding: 16px 22px 10px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); backdrop-filter: saturate(180%) blur(16px); }
    h1 { margin: 0; font-size: 20px; }
    .sub { margin-top: 4px; color: var(--muted); font-size: 13px; min-height: 18px; }
    nav { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 22px 14px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); backdrop-filter: saturate(180%) blur(16px); }
    nav a, button { border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px; background: var(--surface); color: #1d1d1f; text-decoration: none; font: inherit; font-weight: 600; cursor: pointer; }
    nav a:hover, button:hover { border-color: #a8a8ad; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button:disabled { opacity: .55; cursor: wait; }
    main { padding: 22px; max-width: 1380px; margin: 0 auto; }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; margin-bottom: 14px; border: 1px solid #e5e5ea; border-radius: 8px; background: var(--surface); }
    .toolbar label { display: inline-flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 700; }
    .toolbar-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .status-badge { border-radius: 999px; padding: 5px 10px; font-size: 12px; font-weight: 700; background: #fff3d8; color: #7b4d00; }
    .status-badge.ready { background: #e6f6e8; color: #176028; }
    select { min-width: 230px; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font: inherit; background: #fff; }
    section { margin-bottom: 14px; background: var(--surface); border: 1px solid #e5e5ea; border-radius: 8px; overflow: hidden; }
    h2 { margin: 0; padding: 12px 14px; font-size: 16px; background: var(--surface-soft); border-bottom: 1px solid #e5e5ea; }
    .create-fields { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; padding: 14px; }
    .create-fields label { display: grid; gap: 7px; flex: 1 1 280px; color: #1d1d1f; font-size: 13px; font-weight: 700; }
    .create-fields input, .field input { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; font: inherit; background: #fff; }
    .steps { padding: 14px; display: grid; gap: 12px; }
    .step { display: grid; grid-template-columns: 46px 1fr; gap: 12px; align-items: start; padding-bottom: 12px; border-bottom: 1px solid #f0f0f2; }
    .step:last-child { border-bottom: 0; padding-bottom: 0; }
    .number { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 8px; color: var(--accent); background: #eaf4ff; font-size: 13px; font-weight: 700; }
    .field label, .group-title { display: block; margin-bottom: 7px; color: #1d1d1f; font-size: 13px; font-weight: 700; }
    textarea { display: block; width: 100%; min-height: 72px; resize: vertical; border: 1px solid var(--line); border-radius: 8px; padding: 10px; font: inherit; line-height: 1.42; background: #fff; }
    textarea.long { min-height: 200px; }
    textarea.medium { min-height: 126px; }
    textarea:focus, select:focus, input:focus { outline: 3px solid rgba(0,113,227,.18); border-color: var(--accent); }
    .image-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
    .image-slot { min-width: 0; padding: 10px; border: 1px solid #e5e5ea; border-radius: 8px; background: var(--surface-soft); }
    .image-slot.missing-image { border-color: #f3b3ad; background: #fff7f6; }
    .image-slot label { display: block; min-height: 34px; margin-bottom: 7px; font-size: 12px; font-weight: 700; color: #1d1d1f; }
    .image-slot img { display: block; width: 100%; height: 190px; object-fit: contain; background: #f5f5f7; border-radius: 6px; margin-bottom: 9px; }
    .image-slot input { display: block; width: 100%; font-size: 12px; color: var(--muted); }
    .image-missing-note { display: none; margin: 0 0 8px; font-size: 12px; color: #9f1d12; overflow-wrap: anywhere; }
    .image-slot.missing-image .image-missing-note { display: block; }
    .order-options-panel { padding: 14px; border: 1px solid #e5e5ea; border-radius: 10px; background: #fbfbfd; }
    .order-options-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .order-options-head h3 { margin: 0; font-size: 14px; font-weight: 700; }
    .order-options-head p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
    .option-list { display: grid; gap: 10px; }
    .option-card { border: 1px solid #e5e5ea; border-radius: 10px; background: #fff; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,.03); }
    .option-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; background: #f5f5f7; border-bottom: 1px solid #e5e5ea; }
    .option-card-title { display: flex; align-items: center; gap: 8px; font-weight: 800; }
    .option-index { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 999px; background: #eaf4ff; color: var(--accent); font-size: 12px; }
    .option-grid { display: grid; grid-template-columns: minmax(220px, 1.3fr) minmax(120px, .6fr) minmax(100px, .4fr); gap: 10px; padding: 12px; }
    .option-extra { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 0 12px 12px; }
    .option-card label { display: grid; gap: 6px; margin: 0; font-size: 12px; font-weight: 700; color: #1d1d1f; }
    .option-card input, .option-card textarea { width: 100%; min-height: 40px; border: 1px solid var(--line); border-radius: 8px; padding: 8px; font: inherit; background: #fff; }
    .option-card textarea { min-height: 82px; }
    .option-card .check { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; color: #1d1d1f; }
    .option-card .check input { width: auto; min-height: 0; }
    .option-card .remove-option { padding: 6px 10px; border-color: #ffd1d1; color: #9b1c12; background: #fff7f7; }
    .flow-builder { padding: 14px; border: 1px solid #e5e5ea; border-radius: 10px; background: #fbfbfd; }
    .flow-builder-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .flow-builder-head h3 { margin: 0; font-size: 14px; font-weight: 700; }
    .flow-builder-head p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
    .flow-block-list { display: grid; gap: 10px; }
    .flow-block { border: 1px solid #e5e5ea; border-radius: 10px; background: #fff; overflow: hidden; }
    .flow-block.disabled { opacity: .62; }
    .flow-block-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; background: #f5f5f7; border-bottom: 1px solid #e5e5ea; }
    .flow-block-title { display: flex; align-items: center; gap: 8px; font-weight: 800; }
    .flow-block-type { border-radius: 999px; padding: 3px 8px; background: #eaf4ff; color: var(--accent); font-size: 11px; text-transform: uppercase; }
    .flow-block-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .flow-block-body { display: grid; grid-template-columns: minmax(180px, .45fr) minmax(240px, 1fr); gap: 10px; padding: 12px; }
    .flow-block-body label { display: grid; gap: 6px; margin: 0; font-size: 12px; font-weight: 700; color: #1d1d1f; }
    .flow-block-body input, .flow-block-body textarea { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 8px; font: inherit; background: #fff; }
    .flow-block-body textarea { min-height: 78px; }
    .flow-block-body .image-preview { width: 100%; max-height: 110px; object-fit: contain; background: #f5f5f7; border-radius: 6px; }
    .flow-block-body .image-url { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .closing-sequence { margin-top: 14px; padding: 14px; border: 1px solid #e5e5ea; border-radius: 10px; background: #fbfbfd; }
    .closing-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .closing-head h3 { margin: 0; font-size: 14px; font-weight: 700; }
    .closing-head p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
    .closing-list { display: grid; gap: 10px; }
    .closing-card { border: 1px solid #e5e5ea; border-radius: 10px; background: #fff; overflow: hidden; }
    .closing-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; background: #f5f5f7; border-bottom: 1px solid #e5e5ea; }
    .closing-card-title { display: flex; align-items: center; gap: 8px; font-weight: 800; }
    .closing-card-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .closing-card-body { padding: 12px; }
    .closing-card-body textarea { min-height: 92px; }
    .status-message-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; margin-top: 12px; }
    #order-status-replies-state { color: var(--muted); font-size: 13px; }
    .empty-options { padding: 12px; border: 1px dashed #d2d2d7; border-radius: 8px; color: var(--muted); background: #fff; }
    .knowledge-panel { padding: 14px; border-top: 1px solid #e5e5ea; background: #fff; }
    .knowledge-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
    .knowledge-head h3 { margin: 0; font-size: 14px; font-weight: 700; }
    .knowledge-note { color: var(--muted); font-size: 13px; }
    .knowledge-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .knowledge-list { display: grid; gap: 8px; }
    .knowledge-item { padding: 10px; border: 1px solid #e5e5ea; border-radius: 8px; background: #fbfbfd; }
    .knowledge-item strong { display: block; margin-bottom: 4px; }
    .knowledge-item p { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .knowledge-meta { margin-top: 5px; color: var(--muted); font-size: 12px; }
    .knowledge-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .knowledge-actions button { padding: 6px 9px; font-size: 12px; }
    .knowledge-actions .danger { color: #9b1c12; border-color: #ffd1d1; background: #fff7f7; }
    button.danger { color: #9b1c12; border-color: #ffd1d1; background: #fff7f7; }
    .knowledge-empty { color: var(--muted); padding: 10px; border: 1px dashed #d2d2d7; border-radius: 8px; background: #fff; }
    .editor { margin-top: 12px; padding: 12px; border: 1px solid #e5e5ea; border-radius: 8px; background: #fbfbfd; }
    .fields { display: grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap: 12px; }
    .field.wide { grid-column: 1 / -1; }
    .field input, .field textarea { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; font: inherit; background: #fff; }
    .field textarea { min-height: 96px; }
    .editor-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; margin-top: 12px; }
    .editor-actions label { display: inline-flex; align-items: center; gap: 7px; margin-right: auto; font-size: 13px; font-weight: 700; }
    .editor-actions input { width: auto; }
    .actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 14px; border-top: 1px solid #e5e5ea; background: var(--surface-soft); }
    #save-state { color: var(--muted); font-size: 13px; margin-right: auto; }
    @media (max-width: 680px) {
      main { padding: 14px; }
      .step { grid-template-columns: 1fr; }
      .order-options-head { align-items: stretch; flex-direction: column; }
      .option-grid, .option-extra, .fields { grid-template-columns: 1fr; }
      .knowledge-grid { grid-template-columns: 1fr; }
      .number { margin-bottom: -4px; }
      select { min-width: 0; max-width: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Product Flow</h1>
    <div class="sub" id="page-state">Loading products...</div>
  </header>
  <nav>
    <a href="/admin/dashboard">Dashboard</a>
    <a href="/admin/chat">Chat Inbox</a>
    <a href="/admin/whatsapp-web">WhatsApp Web</a>
    <a href="/admin/analytics">Analytics</a>
    <a href="/admin/reply-library">Reply Library</a>
    <a href="/admin/product-flow">Product Flow</a>
    <a href="/admin/follow-up-settings">Follow-Up Settings</a>
    <a href="/admin/compliance">Compliance</a>
    <a href="/demo/chat">Customer Demo</a>
    <button id="refresh" type="button">Refresh</button>
    <a href="/admin/dashboard?tab=profile">Profile</a>
  </nav>
  <main>
    <div class="toolbar">
      <label for="product-select">Product <select id="product-select"></select></label>
      <div class="toolbar-tools">
        <span class="status-badge" id="flow-readiness">Setup</span>
        <button id="show-create-product" type="button">New Product</button>
        <button class="danger" id="delete-product" type="button">Delete Product</button>
        <button id="sync-vector-store" type="button">Sync Knowledge to Vector Store</button>
        <span id="vector-sync-status" class="knowledge-note"></span>
      </div>
    </div>
    <section id="create-product-panel" hidden>
      <h2>New Product</h2>
      <form id="create-product-form" class="create-fields">
        <label for="new-product-name">Product Name<input id="new-product-name" name="name" required /></label>
        <button class="primary" id="create-product" type="submit">Create Product</button>
        <button id="cancel-create-product" type="button">Cancel</button>
      </form>
    </section>
    <section>
      <h2>Order Supply</h2>
      <form id="supply-form">
        <div class="steps">
          <div class="step">
            <div class="number">SKU</div>
            <div class="field">
              <label for="skuCode">Product SKU Code</label>
              <input id="skuCode" name="skuCode" placeholder="BR-BHR-001" />
            </div>
          </div>
          <div class="step">
            <div class="number">URL</div>
            <div class="field">
              <label for="shoppingLink">Shopping Link for Order Admin</label>
              <input id="shoppingLink" name="shoppingLink" type="url" placeholder="https://supplier.example.com/product" />
            </div>
          </div>
        </div>
        <div class="actions">
          <span id="supply-save-state"></span>
          <button class="primary" id="save-supply" type="submit">Save Supply Details</button>
        </div>
      </form>
    </section>
    <section>
      <h2>WhatsApp Opening Flow</h2>
      <form id="flow-form" novalidate>
        <div class="knowledge-panel">
          <div class="knowledge-head">
            <div>
              <h3>Order Status Messages</h3>
              <div class="knowledge-note">Edit messages for order status replies and the Reached Warehouse button. Available placeholders: {quantity}, {product}, {productName}, {unitText}</div>
            </div>
          </div>
          <div class="fields">
            <label class="field wide" for="orderStatusPending">Order Submitted status reply
              <textarea id="orderStatusPending"></textarea>
            </label>
            <label class="field wide" for="orderStatusWarehouse">Reached Warehouse button message
              <textarea id="orderStatusWarehouse"></textarea>
            </label>
          </div>
          <div class="status-message-actions">
            <button id="save-order-status-replies" type="button">Save Order Status Messages</button>
            <span id="order-status-replies-state"></span>
          </div>
        </div>
        <div class="order-options-panel">
          <div class="order-options-head">
            <div>
              <h3>Order Options</h3>
              <p>Set how this product is sold. Add-ons are only needed for combo-style offers.</p>
            </div>
            <button id="add-order-option" type="button">Add Option</button>
          </div>
          <div class="option-list" id="order-options"></div>
        </div>
        <div class="knowledge-panel">
          <div class="knowledge-head">
            <div>
              <h3>Order Form Fields</h3>
              <div class="knowledge-note">Edit the message and field labels shown when the customer wants to order. The parser still treats these as name, address, phone, and order option.</div>
            </div>
          </div>
          <div class="fields">
            <label class="field wide" for="orderFormIntro">Order form intro message
              <textarea id="orderFormIntro" placeholder="Can you help me fill up this details for hold promo?"></textarea>
            </label>
            <label class="field" for="orderFormNameLabel">Name field label
              <input id="orderFormNameLabel" placeholder="Full name" />
            </label>
            <label class="field" for="orderFormAddressLabel">Address field label
              <input id="orderFormAddressLabel" placeholder="Full address" />
            </label>
            <label class="field" for="orderFormPhoneLabel">Phone field label
              <input id="orderFormPhoneLabel" placeholder="Phone number" />
            </label>
            <label class="field" for="orderFormOptionLabel">Order option field label
              <input id="orderFormOptionLabel" placeholder="Order option" />
            </label>
          </div>
        </div>
        <div class="knowledge-panel">
          <div class="knowledge-head">
            <div>
              <h3>FAQ Sales Follow-Up</h3>
              <div class="knowledge-note">Sent after approved FAQ, general FAQ, or vector-store product answers. Set frequency to 1 for every answer, 2 for every second answer, or 0 to disable.</div>
            </div>
          </div>
          <div class="fields">
            <label class="field wide" for="salesPrompt">Follow-up message after answering customer questions
              <textarea id="salesPrompt" placeholder="Ada kita rasa minat nak ambil Package B = 2 FREE 2?"></textarea>
            </label>
            <label class="field" for="salesPromptFrequency">Message frequency
              <input id="salesPromptFrequency" type="number" min="0" max="20" step="1" />
            </label>
          </div>
        </div>
        <div class="knowledge-panel">
          <div class="knowledge-head">
            <div>
              <h3>Approved Product FAQ</h3>
              <div class="knowledge-note">Create product-specific FAQ here, then sync knowledge to embed it into the team vector store.</div>
            </div>
            <div class="toolbar-tools">
              <button id="new-product-faq" type="button">New Product FAQ</button>
              <span id="product-faq-status" class="knowledge-note"></span>
            </div>
          </div>
          <div class="knowledge-list" id="approved-product-faqs"></div>
          <div id="product-faq-form" class="editor" hidden>
            <input id="product-faq-id" type="hidden" />
            <div class="fields">
              <label class="field wide" for="product-faq-topic">Topic
                <input id="product-faq-topic" />
              </label>
              <label class="field wide" for="product-faq-examples">Example Customer Questions
                <textarea id="product-faq-examples"></textarea>
              </label>
              <label class="field wide" for="product-faq-reply">Approved Reply
                <textarea class="reply" id="product-faq-reply"></textarea>
              </label>
              <label class="field wide" for="product-faq-bm-topic">Brunei-Malay Topic
                <input id="product-faq-bm-topic" />
              </label>
              <label class="field wide" for="product-faq-bm-examples">Brunei-Malay Example Questions
                <textarea id="product-faq-bm-examples"></textarea>
              </label>
              <label class="field wide" for="product-faq-bm-reply">Brunei-Malay Approved Reply
                <textarea class="reply" id="product-faq-bm-reply"></textarea>
              </label>
              <label class="field wide" for="product-faq-bm-search">Brunei-Malay Search Text
                <textarea id="product-faq-bm-search"></textarea>
              </label>
            </div>
            <div class="editor-actions">
              <label for="product-faq-active"><input id="product-faq-active" type="checkbox" checked /> Active</label>
              <button id="cancel-product-faq" type="button">Cancel</button>
              <button class="primary" id="save-product-faq" type="button">Save Product FAQ</button>
            </div>
          </div>
        </div>
        <div class="knowledge-panel">
          <div class="knowledge-head">
            <div>
              <h3>Extracted Product Knowledge</h3>
              <div class="knowledge-note">Upload product/price photos, or scan existing product images. Approve image chunks before the agent uses them.</div>
            </div>
            <div class="toolbar-tools">
              <button id="extract-existing-images" type="button">Extract From Existing Images</button>
              <button id="clean-pending-facts" type="button">Remove Fact Rows</button>
              <span id="knowledge-status" class="knowledge-note"></span>
            </div>
          </div>
          <div class="knowledge-grid">
            <div>
              <div class="group-title">Pending Review</div>
              <div class="knowledge-list" id="pending-knowledge"></div>
            </div>
            <div>
              <div class="group-title">Approved Knowledge</div>
              <div class="knowledge-list" id="approved-knowledge"></div>
            </div>
          </div>
        </div>
        <div class="flow-builder">
          <div class="flow-builder-head">
            <div>
              <h3>Opening Flow Sequence</h3>
              <p>Reorder, disable, or add blocks for this product. The agent sends enabled blocks from top to bottom.</p>
            </div>
            <div class="toolbar-tools">
              <button id="add-text-block" type="button">Add Text Block</button>
              <button id="add-image-block" type="button">Add Image Block</button>
            </div>
          </div>
          <div class="flow-block-list" id="opening-flow-blocks"></div>
        </div>
        <div class="closing-sequence">
          <div class="closing-head">
            <div>
              <h3>Order Closing Sequence</h3>
              <p>Sent after the customer submits complete order details. Add as many messages as you want; the agent sends them from top to bottom.</p>
            </div>
            <button id="add-closing-message" type="button">Add Message</button>
          </div>
          <div class="closing-list" id="order-closing-messages"></div>
        </div>
        <div class="actions">
          <span id="save-state"></span>
          <button class="primary" id="save-flow" type="submit">Save Flow</button>
        </div>
      </form>
    </section>
  </main>
  <script>
    let products = [];
    let selectedProduct = null;
    let vectorStoreId = "";
    let orderStatusReplies = {};

    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, function(ch) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
      });
    }

    function status(text) {
      document.querySelector("#save-state").textContent = text;
      document.querySelector("#page-state").textContent = selectedProduct ? selectedProduct.name : text;
    }

    function renderReadiness() {
      const badge = document.querySelector("#flow-readiness");
      const ready = selectedProduct && selectedProduct.ready;
      badge.textContent = ready ? "Ready" : "Setup";
      badge.classList.toggle("ready", Boolean(ready));
    }

    function renderOrderStatusReplies() {
      document.querySelector("#orderStatusPending").value = orderStatusReplies.pending_admin_order || "";
      document.querySelector("#orderStatusWarehouse").value = orderStatusReplies.reached_warehouse || "";
    }

    async function saveOrderStatusReplies() {
      const button = document.querySelector("#save-order-status-replies");
      const state = document.querySelector("#order-status-replies-state");
      button.disabled = true;
      state.textContent = "Saving...";
      try {
        const response = await fetch("/admin/order-status-replies", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            replies: {
              pending_admin_order: document.querySelector("#orderStatusPending").value,
              reached_warehouse: document.querySelector("#orderStatusWarehouse").value
            }
          })
        });
        const data = await response.json();
        if (!response.ok) {
          state.textContent = data.error || "Save failed";
          return;
        }
        orderStatusReplies = data.replies || {};
        renderOrderStatusReplies();
        state.textContent = "Saved";
      } catch (error) {
        state.textContent = error.message || "Save failed";
      } finally {
        button.disabled = false;
      }
    }

    function updateSelectedOptionLabel() {
      if (!selectedProduct) return;
      const option = document.querySelector("#product-select option[value='" + CSS.escape(selectedProduct.id) + "']");
      if (option) option.textContent = selectedProduct.name + (selectedProduct.ready ? "" : " (Setup)");
    }

    function optionCardHtml(option, index) {
      const addOns = (option.add_ons || []).join("\\n");
      const aliases = (option.aliases || []).join("\\n");
      return '<div class="option-card" data-option-index="' + index + '">' +
        '<div class="option-card-head">' +
          '<div class="option-card-title"><span class="option-index">' + esc(index + 1) + '</span><span>' + esc(option.name || "New option") + '</span></div>' +
          '<button class="remove-option" type="button" data-remove-option="' + index + '">Delete</button>' +
        '</div>' +
        '<div class="option-grid">' +
          '<label>Option name<input data-option-field="name" value="' + esc(option.name || "") + '" placeholder="Special Combo" /></label>' +
          '<label>Price<input data-option-field="price" value="' + esc(option.price || "") + '" placeholder="B$55" /></label>' +
          '<label>Quantity<input data-option-field="quantity" type="number" min="1" value="' + esc(option.quantity || 1) + '" /></label>' +
        '</div>' +
        '<div class="option-extra">' +
          '<label>Add-ons / Combo choices<textarea data-option-field="add_ons" placeholder="Only for combo options\\nBio Collagen Mask x 5\\nGreen Mask Stick x 2">' + esc(addOns) + '</textarea></label>' +
          '<label>Customer keywords / aliases<textarea data-option-field="aliases" placeholder="combo\\n1 unit\\nspecial combo">' + esc(aliases) + '</textarea></label>' +
        '</div>' +
        '<div class="option-extra">' +
          '<label class="check"><input data-option-field="requires_add_on" type="checkbox" ' + (option.requires_add_on ? 'checked' : '') + ' /> Customer must choose an add-on for this option</label>' +
        '</div>' +
      '</div>';
    }

    function renderOrderOptions() {
      const options = selectedProduct.orderOptions || [];
      document.querySelector("#order-options").innerHTML = options.map(optionCardHtml).join("") || '<div class="empty-options">No order options yet. Add at least one option before real testing.</div>';
      document.querySelectorAll("button[data-remove-option]").forEach(button => {
        button.addEventListener("click", () => {
          selectedProduct.orderOptions = (selectedProduct.orderOptions || []).filter((_, index) => index !== Number(button.dataset.removeOption));
          renderOrderOptions();
        });
      });
    }

    function renderOrderForm() {
      const form = selectedProduct.orderForm || {};
      document.querySelector("#orderFormIntro").value = form.intro || "";
      document.querySelector("#orderFormNameLabel").value = form.nameLabel || "";
      document.querySelector("#orderFormAddressLabel").value = form.addressLabel || "";
      document.querySelector("#orderFormPhoneLabel").value = form.phoneLabel || "";
      document.querySelector("#orderFormOptionLabel").value = form.optionLabel || "";
    }

    function readOrderForm() {
      return {
        intro: document.querySelector("#orderFormIntro").value,
        nameLabel: document.querySelector("#orderFormNameLabel").value,
        addressLabel: document.querySelector("#orderFormAddressLabel").value,
        phoneLabel: document.querySelector("#orderFormPhoneLabel").value,
        optionLabel: document.querySelector("#orderFormOptionLabel").value
      };
    }

    function blockHtml(block, index) {
      const disabled = block.enabled === false;
      const type = block.type === "image" ? "image" : "text";
      const preview = type === "image" && block.url
        ? '<img class="image-preview" src="' + esc(block.url) + '" alt="' + esc(block.label || "Opening flow image") + '" />'
        : '';
      const content = type === "image"
        ? '<label>Caption<textarea data-block-field="caption">' + esc(block.caption || "") + '</textarea></label>' +
          '<div><div class="image-url">' + esc(block.url || "No image uploaded for this block yet") + '</div>' + preview +
          '<input type="file" accept="image/png,image/jpeg,image/webp" data-block-image-upload data-slot="' + esc(block.imageKey || block.id) + '" /></div>'
        : '<label>Message<textarea data-block-field="body">' + esc(block.body || "") + '</textarea></label>';
      return '<div class="flow-block' + (disabled ? ' disabled' : '') + '" data-block-index="' + index + '">' +
        '<div class="flow-block-head">' +
          '<div class="flow-block-title"><span class="option-index">' + esc(index + 1) + '</span><span class="flow-block-type">' + esc(type) + '</span><span>' + esc(block.label || "Opening block") + '</span></div>' +
          '<div class="flow-block-actions">' +
            '<button type="button" data-move-block="up">Up</button>' +
            '<button type="button" data-move-block="down">Down</button>' +
            '<button type="button" data-toggle-block>' + (disabled ? 'Enable' : 'Disable') + '</button>' +
            '<button class="danger" type="button" data-delete-block>Delete</button>' +
          '</div>' +
        '</div>' +
        '<div class="flow-block-body">' +
          '<label>Label<input data-block-field="label" value="' + esc(block.label || "") + '" /></label>' +
          content +
        '</div>' +
      '</div>';
    }

    function renderOpeningFlowBlocks() {
      selectedProduct.openingFlowBlocks = selectedProduct.openingFlowBlocks || [];
      document.querySelector("#opening-flow-blocks").innerHTML = selectedProduct.openingFlowBlocks.map(blockHtml).join("") || '<div class="empty-options">No opening flow blocks yet. Add a text block or upload product images.</div>';
      document.querySelectorAll(".flow-block").forEach(card => {
        const index = Number(card.dataset.blockIndex);
        card.querySelectorAll("[data-block-field]").forEach(input => {
          input.addEventListener("input", () => {
            const field = input.dataset.blockField;
            selectedProduct.openingFlowBlocks[index][field] = input.value;
          });
        });
        card.querySelector("[data-move-block='up']").addEventListener("click", () => moveBlock(index, -1));
        card.querySelector("[data-move-block='down']").addEventListener("click", () => moveBlock(index, 1));
        card.querySelector("[data-toggle-block]").addEventListener("click", () => {
          selectedProduct.openingFlowBlocks[index].enabled = selectedProduct.openingFlowBlocks[index].enabled === false;
          renderOpeningFlowBlocks();
        });
        card.querySelector("[data-delete-block]").addEventListener("click", () => {
          selectedProduct.openingFlowBlocks.splice(index, 1);
          renderOpeningFlowBlocks();
        });
        const imageInput = card.querySelector("[data-block-image-upload]");
        if (imageInput) imageInput.addEventListener("change", uploadImage);
      });
    }

    function moveBlock(index, delta) {
      const blocks = selectedProduct.openingFlowBlocks || [];
      const target = index + delta;
      if (target < 0 || target >= blocks.length) return;
      const item = blocks[index];
      blocks.splice(index, 1);
      blocks.splice(target, 0, item);
      renderOpeningFlowBlocks();
    }

    function addTextBlock() {
      if (!selectedProduct) return;
      selectedProduct.openingFlowBlocks = selectedProduct.openingFlowBlocks || [];
      selectedProduct.openingFlowBlocks.push({
        id: "custom_text_" + Date.now(),
        type: "text",
        label: "Custom text",
        body: "",
        enabled: true
      });
      renderOpeningFlowBlocks();
    }

    function addImageBlock() {
      if (!selectedProduct) return;
      const id = "custom_image_" + Date.now();
      selectedProduct.openingFlowBlocks = selectedProduct.openingFlowBlocks || [];
      selectedProduct.openingFlowBlocks.push({
        id,
        type: "image",
        label: "Custom image",
        imageKey: id,
        url: "",
        caption: "",
        enabled: true
      });
      renderOpeningFlowBlocks();
    }

    function readOpeningFlowBlocks() {
      return Array.from(document.querySelectorAll(".flow-block")).map(card => {
        const index = Number(card.dataset.blockIndex);
        const original = selectedProduct.openingFlowBlocks[index] || {};
        const read = field => card.querySelector('[data-block-field="' + field + '"]');
        return {
          ...original,
          label: read("label") ? read("label").value : original.label,
          body: read("body") ? read("body").value : original.body,
          caption: read("caption") ? read("caption").value : original.caption
        };
      });
    }

    function closingMessageHtml(message, index) {
      return '<div class="closing-card" data-closing-index="' + index + '">' +
        '<div class="closing-card-head">' +
          '<div class="closing-card-title"><span class="option-index">' + esc(index + 1) + '</span><span>Message ' + esc(index + 1) + '</span></div>' +
          '<div class="closing-card-actions">' +
            '<button type="button" data-move-closing="up">Up</button>' +
            '<button type="button" data-move-closing="down">Down</button>' +
            '<button class="danger" type="button" data-delete-closing>Delete</button>' +
          '</div>' +
        '</div>' +
        '<div class="closing-card-body">' +
          '<textarea data-closing-message placeholder="Closing message after order submission">' + esc(message || "") + '</textarea>' +
        '</div>' +
      '</div>';
    }

    function renderOrderClosingMessages() {
      selectedProduct.orderClosingMessages = selectedProduct.orderClosingMessages || [];
      document.querySelector("#order-closing-messages").innerHTML = selectedProduct.orderClosingMessages.map(closingMessageHtml).join("") || '<div class="empty-options">No closing messages. Add at least one message if you want the agent to reply after order submission.</div>';
      document.querySelectorAll(".closing-card").forEach(card => {
        const index = Number(card.dataset.closingIndex);
        card.querySelector("[data-closing-message]").addEventListener("input", event => {
          selectedProduct.orderClosingMessages[index] = event.target.value;
        });
        card.querySelector("[data-move-closing='up']").addEventListener("click", () => moveClosingMessage(index, -1));
        card.querySelector("[data-move-closing='down']").addEventListener("click", () => moveClosingMessage(index, 1));
        card.querySelector("[data-delete-closing]").addEventListener("click", () => {
          selectedProduct.orderClosingMessages.splice(index, 1);
          renderOrderClosingMessages();
        });
      });
    }

    function moveClosingMessage(index, delta) {
      const messages = selectedProduct.orderClosingMessages || [];
      const target = index + delta;
      if (target < 0 || target >= messages.length) return;
      const item = messages[index];
      messages.splice(index, 1);
      messages.splice(target, 0, item);
      renderOrderClosingMessages();
    }

    function addClosingMessage() {
      if (!selectedProduct) return;
      selectedProduct.orderClosingMessages = selectedProduct.orderClosingMessages || [];
      selectedProduct.orderClosingMessages.push("");
      renderOrderClosingMessages();
    }

    function readOrderClosingMessages() {
      return Array.from(document.querySelectorAll("[data-closing-message]"))
        .map(textarea => textarea.value)
        .filter(message => message.trim());
    }

    function faqItemHtml(faq) {
      const questions = [
        ...(faq.exampleQuestions || []),
        ...(faq.bruneiMalayExampleQuestions || [])
      ].filter(Boolean).join("\\n");
      return '<div class="knowledge-item">' +
        '<strong>' + esc(faq.topic || faq.id || "Approved product FAQ") + '</strong>' +
        (questions ? '<p><b>Questions:</b>\\n' + esc(questions) + '</p>' : '') +
        (faq.approvedReply ? '<p><b>Approved answer:</b>\\n' + esc(faq.approvedReply) + '</p>' : '') +
        (faq.bruneiMalayApprovedReply ? '<p><b>Brunei-Malay answer:</b>\\n' + esc(faq.bruneiMalayApprovedReply) + '</p>' : '') +
        (faq.bruneiMalaySearchText ? '<div class="knowledge-meta">Search text: ' + esc(faq.bruneiMalaySearchText) + '</div>' : '') +
        '<div class="knowledge-actions">' +
          '<button type="button" data-edit-product-faq="' + esc(faq.id) + '">Edit</button>' +
          '<button class="danger" type="button" data-delete-product-faq="' + esc(faq.id) + '" data-faq-topic="' + esc(faq.topic || faq.id) + '">Delete</button>' +
        '</div>' +
      '</div>';
    }

    function renderApprovedFaqs() {
      const faqs = selectedProduct.approvedFaqs || [];
      document.querySelector("#approved-product-faqs").innerHTML = faqs.map(faqItemHtml).join("") || '<div class="knowledge-empty">No approved product FAQ for this product yet. Click New Product FAQ to add one.</div>';
      document.querySelectorAll("button[data-edit-product-faq]").forEach(button => {
        button.addEventListener("click", () => editProductFaq(button.dataset.editProductFaq));
      });
      document.querySelectorAll("button[data-delete-product-faq]").forEach(button => {
        button.addEventListener("click", () => deleteProductFaq(button.dataset.deleteProductFaq, button.dataset.faqTopic));
      });
    }

    function resetProductFaqForm() {
      document.querySelector("#product-faq-id").value = "";
      document.querySelector("#product-faq-topic").value = "";
      document.querySelector("#product-faq-examples").value = "";
      document.querySelector("#product-faq-reply").value = "";
      document.querySelector("#product-faq-bm-topic").value = "";
      document.querySelector("#product-faq-bm-examples").value = "";
      document.querySelector("#product-faq-bm-reply").value = "";
      document.querySelector("#product-faq-bm-search").value = "";
      document.querySelector("#product-faq-active").checked = true;
    }

    function showProductFaqForm() {
      document.querySelector("#product-faq-form").hidden = false;
      document.querySelector("#product-faq-topic").focus();
    }

    function newProductFaq() {
      resetProductFaqForm();
      document.querySelector("#product-faq-status").textContent = "New product FAQ";
      showProductFaqForm();
    }

    function editProductFaq(faqId) {
      const faq = (selectedProduct.approvedFaqs || []).find(item => item.id === faqId);
      if (!faq) return;
      document.querySelector("#product-faq-id").value = faq.id || "";
      document.querySelector("#product-faq-topic").value = faq.topic || "";
      document.querySelector("#product-faq-examples").value = (faq.exampleQuestions || []).join("\\n");
      document.querySelector("#product-faq-reply").value = faq.approvedReply || "";
      document.querySelector("#product-faq-bm-topic").value = faq.bruneiMalayTopic || "";
      document.querySelector("#product-faq-bm-examples").value = (faq.bruneiMalayExampleQuestions || []).join("\\n");
      document.querySelector("#product-faq-bm-reply").value = faq.bruneiMalayApprovedReply || "";
      document.querySelector("#product-faq-bm-search").value = faq.bruneiMalaySearchText || "";
      document.querySelector("#product-faq-active").checked = faq.active !== false;
      document.querySelector("#product-faq-status").textContent = "Editing product FAQ";
      showProductFaqForm();
    }

    async function saveProductFaq() {
      if (!selectedProduct) return;
      const button = document.querySelector("#save-product-faq");
      if (!document.querySelector("#product-faq-topic").value.trim() || !document.querySelector("#product-faq-reply").value.trim() || !document.querySelector("#product-faq-examples").value.trim()) {
        document.querySelector("#product-faq-status").textContent = "Topic, questions, and approved reply are required";
        return;
      }
      button.disabled = true;
      document.querySelector("#product-faq-status").textContent = "Saving...";
      try {
        const response = await fetch("/admin/faq-library/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: document.querySelector("#product-faq-id").value,
            scope: "product",
            productId: selectedProduct.id,
            topic: document.querySelector("#product-faq-topic").value,
            exampleQuestions: document.querySelector("#product-faq-examples").value.split(/\\r?\\n/),
            approvedReply: document.querySelector("#product-faq-reply").value,
            bruneiMalayTopic: document.querySelector("#product-faq-bm-topic").value,
            bruneiMalayExampleQuestions: document.querySelector("#product-faq-bm-examples").value.split(/\\r?\\n/),
            bruneiMalayApprovedReply: document.querySelector("#product-faq-bm-reply").value,
            bruneiMalaySearchText: document.querySelector("#product-faq-bm-search").value,
            active: document.querySelector("#product-faq-active").checked
          })
        });
        const data = await response.json();
        if (!response.ok) {
          document.querySelector("#product-faq-status").textContent = data.error || "Save failed";
          return;
        }
        await loadProducts(selectedProduct.id);
        document.querySelector("#product-faq-form").hidden = true;
        document.querySelector("#product-faq-status").textContent = "Product FAQ saved";
      } finally {
        button.disabled = false;
      }
    }

    async function deleteProductFaq(faqId, topic) {
      if (!selectedProduct || !confirm('Delete product FAQ "' + (topic || faqId) + '"?')) return;
      document.querySelector("#product-faq-status").textContent = "Deleting...";
      const response = await fetch("/admin/faq-library/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "product", productId: selectedProduct.id, id: faqId })
      });
      const data = await response.json();
      if (!response.ok) {
        document.querySelector("#product-faq-status").textContent = data.error || "Delete failed";
        return;
      }
      await loadProducts(selectedProduct.id);
      resetProductFaqForm();
      document.querySelector("#product-faq-form").hidden = true;
      document.querySelector("#product-faq-status").textContent = "Product FAQ deleted";
    }

    function knowledgeItemHtml(fact, status) {
      const category = fact.category ? String(fact.category).replace(/_/g, " ") : "";
      const safeText = fact.customer_safe === false ? "needs review" : "";
      const isImageChunk = fact.kind === "image_chunk";
      const title = isImageChunk
        ? ["image chunk", category, fact.title || "Image knowledge"].filter(Boolean).join(" | ")
        : [category, fact.label || "Fact"].filter(Boolean).join(" | ");
      const body = isImageChunk
        ? (fact.summary || fact.extracted_text || fact.embedding_text || "")
        : (fact.value || "");
      return '<div class="knowledge-item">' +
        '<strong>' + esc(title) + '</strong>' +
        '<div>' + esc(body) + '</div>' +
        '<div class="knowledge-meta">' + esc([fact.confidence ? "confidence: " + fact.confidence : "", safeText, fact.sourceFilename || "", fact.sourceLabel || fact.sourceSlot || "", fact.approval_note || ""].filter(Boolean).join(" | ")) + '</div>' +
        '<div class="knowledge-actions">' +
          (status === "pending" ? '<button type="button" data-approve-fact="' + esc(fact.id) + '">Approve</button>' : '') +
          '<button class="danger" type="button" data-delete-fact="' + esc(fact.id) + '" data-fact-status="' + esc(status) + '">Delete</button>' +
        '</div>' +
      '</div>';
    }

    function renderKnowledge() {
      const knowledge = selectedProduct.extractedKnowledge || {};
      const pending = knowledge.pending || [];
      const approved = knowledge.approved || [];
      const last = knowledge.lastExtraction;
      document.querySelector("#knowledge-status").textContent = last
        ? (last.status === "completed"
            ? "Last extraction: " + (last.imageChunkAdded || last.imageChunksAdded || 0) + " image chunk(s)"
            : "Last extraction: " + last.status + (last.reason ? " - " + last.reason : ""))
        : "No image extraction yet";
      document.querySelector("#pending-knowledge").innerHTML = pending.map(fact => knowledgeItemHtml(fact, "pending")).join("") || '<div class="knowledge-empty">No pending image chunks.</div>';
      document.querySelector("#approved-knowledge").innerHTML = approved.map(fact => knowledgeItemHtml(fact, "approved")).join("") || '<div class="knowledge-empty">No approved image chunks yet.</div>';
      document.querySelectorAll("button[data-approve-fact]").forEach(button => {
        button.addEventListener("click", () => approveFact(button.dataset.approveFact));
      });
      document.querySelectorAll("button[data-delete-fact]").forEach(button => {
        button.addEventListener("click", () => deleteFact(button.dataset.deleteFact, button.dataset.factStatus));
      });
    }

    async function approveFact(factId) {
      if (!selectedProduct) return;
      status("Approving knowledge...");
      const response = await fetch("/admin/product-flow/knowledge/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: selectedProduct.id, factId })
      });
      const data = await response.json();
      if (!response.ok) return status(data.error || "Approve failed");
      selectedProduct = data.product;
      products = products.map(product => product.id === selectedProduct.id ? selectedProduct : product);
      renderKnowledge();
      status("Knowledge approved");
    }

    async function deleteFact(factId, factStatus) {
      if (!selectedProduct) return;
      status("Deleting knowledge...");
      const response = await fetch("/admin/product-flow/knowledge/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: selectedProduct.id, factId, status: factStatus })
      });
      const data = await response.json();
      if (!response.ok) return status(data.error || "Delete failed");
      selectedProduct = data.product;
      products = products.map(product => product.id === selectedProduct.id ? selectedProduct : product);
      renderKnowledge();
      status("Knowledge deleted");
    }

    async function extractExistingKnowledge() {
      if (!selectedProduct) return;
      const button = document.querySelector("#extract-existing-images");
      button.disabled = true;
      status("Extracting knowledge from existing images...");
      try {
        const response = await fetch("/admin/product-flow/knowledge/extract-existing", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId: selectedProduct.id })
        });
        const data = await response.json();
        if (!response.ok) {
          status(data.error || "Extraction failed");
          return;
        }
        selectedProduct = data.product;
        products = products.map(product => product.id === selectedProduct.id ? selectedProduct : product);
        renderKnowledge();
        const extraction = data.extraction || {};
        status("Extraction complete: " + (extraction.imageChunksAdded || 0) + " image chunk(s) from " + (extraction.imagesCompleted || 0) + " image(s)");
      } finally {
        button.disabled = false;
      }
    }

    async function cleanPendingFacts() {
      if (!selectedProduct) return;
      const button = document.querySelector("#clean-pending-facts");
      button.disabled = true;
      status("Removing separate fact rows...");
      try {
        const response = await fetch("/admin/product-flow/knowledge/clean-pending", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId: selectedProduct.id })
        });
        const data = await response.json();
        if (!response.ok) {
          status(data.error || "Clean failed");
          return;
        }
        selectedProduct = data.product;
        products = products.map(product => product.id === selectedProduct.id ? selectedProduct : product);
        renderKnowledge();
        status("Removed separate fact rows: " + (data.result && data.result.removed || 0) + " pending, " + (data.result && data.result.approvedRemoved || 0) + " approved");
      } finally {
        button.disabled = false;
      }
    }

    function readOrderOptions() {
      return Array.from(document.querySelectorAll(".option-card")).map(card => {
        const get = field => card.querySelector('[data-option-field="' + field + '"]');
        return {
          name: get("name").value,
          price: get("price").value,
          quantity: Number(get("quantity").value || 1),
          add_ons: get("add_ons").value.split(/\\r?\\n/),
          aliases: get("aliases").value.split(/\\r?\\n/),
          requires_add_on: get("requires_add_on").checked
        };
      }).filter(option => option.name.trim());
    }

    function renderProduct() {
      if (!selectedProduct) return;
      document.querySelector("#product-faq-form").hidden = true;
      document.querySelector("#product-faq-status").textContent = "";
      resetProductFaqForm();
      document.querySelector("#skuCode").value = selectedProduct.skuCode || "";
      document.querySelector("#shoppingLink").value = selectedProduct.shoppingLink || "";
      document.querySelector("#salesPrompt").value = selectedProduct.salesPrompt || "";
      document.querySelector("#salesPromptFrequency").value = Number.isFinite(Number(selectedProduct.salesPromptFrequency))
        ? selectedProduct.salesPromptFrequency
        : 1;
      renderOrderOptions();
      renderOrderForm();
      renderApprovedFaqs();
      renderKnowledge();
      renderOpeningFlowBlocks();
      renderOrderClosingMessages();
      renderReadiness();
      status(selectedProduct.ready ? "Ready for opening flow" : "Setup in progress");
    }

    async function loadProducts(preferredId) {
      const response = await fetch("/admin/product-flow-data");
      const data = await response.json();
      products = data.products || [];
      vectorStoreId = data.vectorStoreId || "";
      orderStatusReplies = data.orderStatusReplies || {};
      renderOrderStatusReplies();
      document.querySelector("#vector-sync-status").textContent = vectorStoreId
        ? "Vector store: " + vectorStoreId
        : "No vector store synced yet";
      const select = document.querySelector("#product-select");
      select.innerHTML = products.map(product =>
        '<option value="' + esc(product.id) + '">' + esc(product.name + (product.ready ? "" : " (Setup)")) + '</option>'
      ).join("");
      const requested = preferredId || select.value || (products[0] && products[0].id);
      selectedProduct = products.find(product => product.id === requested) || products[0] || null;
      if (selectedProduct) {
        select.value = selectedProduct.id;
        renderProduct();
      } else {
        renderReadiness();
        status("No configured products");
      }
    }

    async function syncVectorStore() {
      const button = document.querySelector("#sync-vector-store");
      if (!confirm("Sync approved general FAQ, product FAQ, and product image knowledge for this team to the same OpenAI vector store? This removes old attached files first, then uploads the latest files.")) {
        return;
      }
      button.disabled = true;
      document.querySelector("#vector-sync-status").textContent = "Syncing same team vector store...";
      status("Syncing approved FAQ and product image knowledge to OpenAI vector store...");
      try {
        const response = await fetch("/admin/product-flow/knowledge/sync-vector-store", {
          method: "POST",
          headers: { "Content-Type": "application/json" }
        });
        const data = await response.json();
        if (!response.ok) {
          document.querySelector("#vector-sync-status").textContent = data.error || "Sync failed";
          status(data.error || "Sync failed");
          return;
        }
        vectorStoreId = data.vectorStoreId || vectorStoreId;
        const files = data.files && data.files.length ? data.files.join(", ") : "knowledge files";
        document.querySelector("#vector-sync-status").textContent = "Synced " + files + (vectorStoreId ? " to " + vectorStoreId : "");
        status("Vector store knowledge synced");
      } finally {
        button.disabled = false;
      }
    }

    function readFileDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(reader.result));
        reader.addEventListener("error", reject);
        reader.readAsDataURL(file);
      });
    }

    async function uploadImage(event) {
      const input = event.target;
      const file = input.files && input.files[0];
      if (!file || !selectedProduct) return;
      status("Uploading " + file.name + "...");
      const response = await fetch("/admin/product-flow/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: selectedProduct.id,
          slot: input.dataset.slot,
          originalName: file.name,
          openingFlowBlocks: readOpeningFlowBlocks(),
          dataUrl: await readFileDataUrl(file)
        })
      });
      const data = await response.json();
      if (!response.ok) {
        status(data.error || "Upload failed");
        return;
      }
      selectedProduct = data.product;
      products = products.map(product => product.id === selectedProduct.id ? selectedProduct : product);
      renderKnowledge();
      renderOpeningFlowBlocks();
      renderReadiness();
      updateSelectedOptionLabel();
      status(data.extraction && data.extraction.status === "completed"
        ? "Image saved, " + (data.extraction.imageChunkAdded ? "1 image chunk extracted" : "no new image chunk")
        : "Image saved");
    }

    async function saveFlow(event) {
      event.preventDefault();
      if (!selectedProduct) return;
      const button = document.querySelector("#save-flow");
      button.disabled = true;
      status("Saving...");
      const body = {
        productId: selectedProduct.id,
        skuCode: document.querySelector("#skuCode").value,
        shoppingLink: selectedProduct.shoppingLink || "",
        salesPrompt: document.querySelector("#salesPrompt").value,
        salesPromptFrequency: document.querySelector("#salesPromptFrequency").value
      };
      body.orderOptions = readOrderOptions();
      body.orderForm = readOrderForm();
      body.openingFlowBlocks = readOpeningFlowBlocks();
      body.orderClosingMessages = readOrderClosingMessages();
      try {
        const response = await fetch("/admin/product-flow/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) {
          status(data.error || "Save failed");
          return;
        }
        selectedProduct = data.product;
        products = products.map(product => product.id === selectedProduct.id ? selectedProduct : product);
        renderOpeningFlowBlocks();
        renderOrderClosingMessages();
        renderReadiness();
        updateSelectedOptionLabel();
        status("Saved");
      } catch (error) {
        status(error.message || "Save failed");
      } finally {
        button.disabled = false;
      }
    }

    async function saveSupply(event) {
      event.preventDefault();
      if (!selectedProduct) return;
      const button = document.querySelector("#save-supply");
      const message = document.querySelector("#supply-save-state");
      button.disabled = true;
      message.textContent = "Saving...";
      try {
        const response = await fetch("/admin/product-flow/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productId: selectedProduct.id,
            skuCode: document.querySelector("#skuCode").value,
            shoppingLink: document.querySelector("#shoppingLink").value
          })
        });
        const data = await response.json();
        if (!response.ok) {
          message.textContent = data.error || "Save failed";
          return;
        }
        selectedProduct = data.product;
        products = products.map(product => product.id === selectedProduct.id ? selectedProduct : product);
        renderProduct();
        updateSelectedOptionLabel();
        message.textContent = "Supply details saved";
      } finally {
        button.disabled = false;
      }
    }

    async function createProduct(event) {
      event.preventDefault();
      const input = document.querySelector("#new-product-name");
      const name = input.value.trim();
      if (!name) return;
      const button = document.querySelector("#create-product");
      button.disabled = true;
      try {
        const response = await fetch("/admin/product-flow/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name })
        });
        const data = await response.json();
        if (!response.ok) {
          status(data.error || "Create failed");
          return;
        }
        document.querySelector("#create-product-panel").hidden = true;
        input.value = "";
        await loadProducts(data.product.id);
        status("Product created");
      } finally {
        button.disabled = false;
      }
    }

    async function deleteSelectedProduct() {
      if (!selectedProduct) return;
      if (products.length <= 1) {
        status("Cannot delete the last product");
        return;
      }
      const label = selectedProduct.name || selectedProduct.id;
      if (!confirm('Delete entire product flow for "' + label + '"? This removes this product setup, approved product FAQ, and extracted image knowledge from this team.')) {
        return;
      }
      const button = document.querySelector("#delete-product");
      button.disabled = true;
      status("Deleting product...");
      try {
        const response = await fetch("/admin/product-flow/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId: selectedProduct.id })
        });
        const data = await response.json();
        if (!response.ok) {
          status(data.error || "Delete failed");
          return;
        }
        const nextProduct = (data.products || []).find(product => product.id !== selectedProduct.id) || (data.products || [])[0] || null;
        await loadProducts(nextProduct && nextProduct.id);
        status("Deleted product: " + label);
      } finally {
        button.disabled = false;
      }
    }

    document.querySelector("#product-select").addEventListener("change", event => {
      selectedProduct = products.find(product => product.id === event.target.value) || null;
      renderProduct();
    });
    document.querySelector("#show-create-product").addEventListener("click", () => {
      document.querySelector("#create-product-panel").hidden = false;
      document.querySelector("#new-product-name").focus();
    });
    document.querySelector("#cancel-create-product").addEventListener("click", () => {
      document.querySelector("#create-product-panel").hidden = true;
      document.querySelector("#new-product-name").value = "";
    });
    document.querySelector("#create-product-form").addEventListener("submit", createProduct);
    document.querySelector("#delete-product").addEventListener("click", deleteSelectedProduct);
    document.querySelector("#supply-form").addEventListener("submit", saveSupply);
    document.querySelector("#flow-form").addEventListener("submit", saveFlow);
    document.querySelector("#add-text-block").addEventListener("click", addTextBlock);
    document.querySelector("#add-image-block").addEventListener("click", addImageBlock);
    document.querySelector("#add-closing-message").addEventListener("click", addClosingMessage);
    document.querySelector("#new-product-faq").addEventListener("click", newProductFaq);
    document.querySelector("#cancel-product-faq").addEventListener("click", () => {
      document.querySelector("#product-faq-form").hidden = true;
      document.querySelector("#product-faq-status").textContent = "";
      resetProductFaqForm();
    });
    document.querySelector("#save-product-faq").addEventListener("click", saveProductFaq);
    document.querySelector("#extract-existing-images").addEventListener("click", extractExistingKnowledge);
    document.querySelector("#clean-pending-facts").addEventListener("click", cleanPendingFacts);
    document.querySelector("#save-order-status-replies").addEventListener("click", saveOrderStatusReplies);
    document.querySelector("#sync-vector-store").addEventListener("click", syncVectorStore);
    document.querySelector("#add-order-option").addEventListener("click", () => {
      if (!selectedProduct) return;
      selectedProduct.orderOptions = [
        ...(selectedProduct.orderOptions || []),
        { name: "", price: "", quantity: 1, aliases: [], requires_add_on: false, add_ons: [] }
      ];
      renderOrderOptions();
    });
    document.querySelector("#refresh").addEventListener("click", () => loadProducts(selectedProduct && selectedProduct.id));
    loadProducts();
  </script>
</body>
</html>`;
}

function analyticsPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI Agent Analytics</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Arial, sans-serif; color: #1d1d1f; background: #f5f5f7; --surface: #ffffff; --surface-soft: #fbfbfd; --line: #d2d2d7; --muted: #6e6e73; --accent: #0071e3; }
    body { margin: 0; background: #f5f5f7; }
    header { padding: 16px 22px 10px; background: rgba(251,251,253,.9); color: #1d1d1f; border-bottom: 1px solid rgba(210,210,215,.8); backdrop-filter: saturate(180%) blur(16px); }
    h1 { margin: 0; font-size: 20px; }
    .sub { margin-top: 4px; color: var(--muted); font-size: 13px; }
    nav { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 22px 14px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); backdrop-filter: saturate(180%) blur(16px); }
    nav a, button { border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px; background: var(--surface); color: #1d1d1f; text-decoration: none; font-weight: 600; cursor: pointer; }
    nav a:hover, button:hover { border-color: #a8a8ad; }
    main { padding: 22px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-bottom: 18px; }
    .metric { background: var(--surface); border: 1px solid #e5e5ea; border-radius: 8px; padding: 14px; box-shadow: 0 1px 2px rgba(0,0,0,.03); }
    .metric strong { display: block; font-size: 26px; margin-bottom: 3px; }
    .filterbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin: 0 0 14px;
      padding: 10px 12px;
      background: var(--surface);
      border: 1px solid #e5e5ea;
      border-radius: 8px;
    }
    .filterbar label {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: #1d1d1f;
      font-size: 13px;
      font-weight: 700;
    }
    .filterbar input {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 7px 9px;
      font: inherit;
    }
    .charts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 14px;
      margin-bottom: 18px;
    }
    .chart-card {
      background: var(--surface);
      border: 1px solid #e5e5ea;
      border-radius: 8px;
      overflow: hidden;
    }
    .chart-card h2 {
      border-bottom: 1px solid #e5e5ea;
    }
    .bar-chart {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(22px, 1fr);
      align-items: end;
      gap: 6px;
      height: 230px;
      padding: 16px 14px 10px;
      border-bottom: 1px solid #f0f0f2;
    }
    .bar-item {
      min-width: 0;
      height: 100%;
      display: grid;
      grid-template-rows: 1fr auto;
      gap: 6px;
      align-items: end;
    }
    .bar-wrap {
      height: 100%;
      display: flex;
      align-items: flex-end;
      justify-content: center;
    }
    .bar {
      width: 100%;
      min-height: 2px;
      max-width: 34px;
      border-radius: 4px 4px 0 0;
      background: var(--accent);
      color: #fff;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 4px;
      font-size: 11px;
      font-weight: 700;
      box-sizing: border-box;
    }
    .bar.zero {
      background: #d2d2d7;
      color: #6e6e73;
    }
    .bar-label {
      min-height: 28px;
      color: #6e6e73;
      font-size: 11px;
      line-height: 1.1;
      text-align: center;
      overflow-wrap: anywhere;
    }
    .chart-note {
      padding: 10px 14px;
      color: #6e6e73;
      font-size: 13px;
    }
    .followup-chart {
      display: grid;
      gap: 12px;
      padding: 16px 14px;
    }
    .followup-row {
      display: grid;
      grid-template-columns: 130px 1fr 70px;
      align-items: center;
      gap: 10px;
      font-size: 13px;
    }
    .followup-label {
      font-weight: 700;
      color: #1d1d1f;
    }
    .followup-track {
      height: 30px;
      display: grid;
      grid-template-columns: 1fr;
      border-radius: 5px;
      background: #f0f0f2;
      overflow: hidden;
      position: relative;
    }
    .followup-bar {
      min-width: 2px;
      background: var(--accent);
      color: #fff;
      display: flex;
      align-items: center;
      padding-left: 8px;
      font-weight: 700;
      box-sizing: border-box;
      white-space: nowrap;
    }
    .followup-rate {
      font-weight: 700;
      color: #1d1d1f;
      text-align: right;
    }
    .followup-meta {
      grid-column: 2 / 4;
      color: #6e6e73;
      font-size: 12px;
    }
    section { margin: 0 0 22px; background: var(--surface); border: 1px solid #e5e5ea; border-radius: 8px; overflow: hidden; }
    h2 { margin: 0; padding: 12px 14px; font-size: 16px; background: var(--surface-soft); border-bottom: 1px solid #e5e5ea; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 560px; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #f0f0f2; text-align: left; font-size: 13px; }
    th { background: var(--surface-soft); color: #6e6e73; font-size: 12px; text-transform: uppercase; letter-spacing: 0; }
    .empty { padding: 14px; color: #6e6e73; }
  </style>
</head>
<body>
  <header>
    <h1>AI Agent Analytics</h1>
    <div class="sub" id="generated">Loading analytics...</div>
  </header>
  <nav>
    <a href="/admin/dashboard">Dashboard</a>
    <a href="/admin/chat">Chat Inbox</a>
    <a href="/admin/whatsapp-web">WhatsApp Web</a>
    <a href="/admin/analytics">Analytics</a>
    <a href="/admin/reply-library">Reply Library</a>
    <a href="/admin/product-flow">Product Flow</a>
    <a href="/admin/follow-up-settings">Follow-Up Settings</a>
    <a href="/admin/compliance">Compliance</a>
    <a href="/demo/chat">Customer Demo</a>
    <button id="refresh" type="button">Refresh</button>
    <a href="/admin/dashboard?tab=profile">Profile</a>
  </nav>
  <main>
    <div class="filterbar">
      <label for="analytics-date">Analytics Date <input id="analytics-date" type="date" /></label>
    </div>
    <div class="summary" id="analytics-summary"></div>
    <div class="charts">
      <section class="chart-card">
        <h2>Customers By Hour</h2>
        <div id="customers-hourly-chart"></div>
      </section>
      <section class="chart-card">
        <h2>Customers Across Seven Days</h2>
        <div id="customers-seven-day-chart"></div>
      </section>
      <section class="chart-card">
        <h2>Follow-Up Reply Performance</h2>
        <div id="followup-performance-chart"></div>
      </section>
    </div>
    <section>
      <h2>New Customers By Product</h2>
      <div class="table-wrap" id="new-customers-by-product"></div>
    </section>
    <section>
      <h2>New Orders By Product</h2>
      <div class="table-wrap" id="new-orders-by-product"></div>
    </section>
  </main>
  <script>
    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, function(ch) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
      });
    }
    function fmtTime(value) {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return esc(value);
      return date.toLocaleString();
    }
    function localDateInput(value) {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return year + "-" + month + "-" + day;
    }
    function table(rows, columns) {
      if (!rows.length) return '<div class="empty">No records yet.</div>';
      return '<table><thead><tr>' + columns.map(c => '<th>' + esc(c.label) + '</th>').join('') +
        '</tr></thead><tbody>' + rows.map(row => '<tr>' + columns.map(c => '<td>' + esc(row[c.key]) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
    }
    function barChart(rows, note) {
      const max = Math.max(1, ...rows.map(row => Number(row.count || 0)));
      return '<div class="bar-chart">' + rows.map(row => {
        const count = Number(row.count || 0);
        const height = Math.max(count === 0 ? 2 : 8, Math.round((count / max) * 100));
        const zeroClass = count === 0 ? ' zero' : '';
        return '<div class="bar-item" title="' + esc(row.label + ': ' + count) + '">' +
          '<div class="bar-wrap"><div class="bar' + zeroClass + '" style="height:' + height + '%">' + esc(count) + '</div></div>' +
          '<div class="bar-label">' + esc(row.label) + '</div>' +
        '</div>';
      }).join('') + '</div><div class="chart-note">' + esc(note) + '</div>';
    }
    function followupPerformanceChart(rows) {
      const max = Math.max(1, ...rows.map(row => Number(row.sent || 0)));
      return '<div class="followup-chart">' + rows.map(row => {
        const sent = Number(row.sent || 0);
        const replies = Number(row.replies || 0);
        const width = Math.max(sent === 0 ? 2 : 8, Math.round((sent / max) * 100));
        return '<div class="followup-row">' +
          '<div class="followup-label">' + esc(row.label) + '</div>' +
          '<div class="followup-track"><div class="followup-bar" style="width:' + width + '%">' + esc(replies + ' replied / ' + sent + ' sent') + '</div></div>' +
          '<div class="followup-rate">' + esc(row.rateLabel) + '</div>' +
          '<div class="followup-meta">Reply rate for this follow-up message on the selected date</div>' +
        '</div>';
      }).join('') + '</div>';
    }
    async function loadAnalytics() {
      const selectedDate = document.querySelector('#analytics-date').value || localDateInput(new Date());
      const response = await fetch('/admin/dashboard-data?date=' + encodeURIComponent(selectedDate));
      const data = await response.json();
      const analytics = data.analytics;
      document.querySelector('#generated').textContent = 'Date ' + analytics.date + ' | Generated ' + fmtTime(data.generatedAt);
      const metrics = [
        ['New Customers', analytics.totalNewCustomersToday],
        ['Total Orders', analytics.totalOrdersToday],
        ['Total Sales', analytics.totalSalesTodayDisplay]
      ];
      document.querySelector('#analytics-summary').innerHTML = metrics.map(item =>
        '<div class="metric"><strong>' + esc(item[1]) + '</strong><span>' + esc(item[0]) + '</span></div>'
      ).join('');
      document.querySelector('#customers-hourly-chart').innerHTML = barChart(
        analytics.customerCharts.hourly,
        'Total new customers by hour for ' + analytics.date
      );
      document.querySelector('#customers-seven-day-chart').innerHTML = barChart(
        analytics.customerCharts.sevenDays,
        'Total new customers per day, ending ' + analytics.date
      );
      document.querySelector('#followup-performance-chart').innerHTML = followupPerformanceChart(
        analytics.customerCharts.followups
      );
      document.querySelector('#new-customers-by-product').innerHTML = table(analytics.newCustomersByProductToday, [
        { label: 'Product', key: 'product' },
        { label: 'New Customers Today', key: 'count' }
      ]);
      document.querySelector('#new-orders-by-product').innerHTML = table(analytics.newOrdersByProductToday, [
        { label: 'Product', key: 'product' },
        { label: 'New Orders Today', key: 'count' }
      ]);
    }
    document.querySelector('#analytics-date').value = localDateInput(new Date());
    document.querySelector('#analytics-date').addEventListener('change', loadAnalytics);
    document.querySelector('#refresh').addEventListener('click', loadAnalytics);
    loadAnalytics();
    setInterval(loadAnalytics, 15000);
  </script>
</body>
</html>`;
}

function compliancePageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Compliance & Security</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Arial, sans-serif; color: #1d1d1f; background: #f5f5f7; --surface: #ffffff; --surface-soft: #fbfbfd; --line: #d2d2d7; --muted: #6e6e73; --accent: #0071e3; }
    body { margin: 0; background: #f5f5f7; }
    header { padding: 16px 22px 10px; background: rgba(251,251,253,.9); color: #1d1d1f; border-bottom: 1px solid rgba(210,210,215,.8); backdrop-filter: saturate(180%) blur(16px); }
    h1 { margin: 0; font-size: 20px; }
    .sub { margin-top: 4px; color: var(--muted); font-size: 13px; }
    nav { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 22px 14px; background: rgba(251,251,253,.9); border-bottom: 1px solid rgba(210,210,215,.8); backdrop-filter: saturate(180%) blur(16px); }
    nav a, button { border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px; background: var(--surface); color: #1d1d1f; text-decoration: none; font-weight: 600; cursor: pointer; }
    nav a:hover, button:hover { border-color: #a8a8ad; }
    main { padding: 22px; display: grid; gap: 18px; }
    section { background: var(--surface); border: 1px solid #e5e5ea; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,.03); }
    h2 { margin: 0; padding: 12px 14px; font-size: 16px; background: var(--surface-soft); border-bottom: 1px solid #e5e5ea; }
    .content { padding: 14px; }
    .tool-row { display: grid; grid-template-columns: minmax(220px, 1fr) auto auto; gap: 8px; align-items: start; }
    input { border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; font: inherit; }
    input:focus { outline: 3px solid rgba(0,113,227,.18); border-color: var(--accent); }
    pre { white-space: pre-wrap; word-break: break-word; background: #f5f5f7; padding: 12px; border-radius: 8px; max-height: 320px; overflow: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #f0f0f2; text-align: left; vertical-align: top; font-size: 13px; }
    th { background: var(--surface-soft); color: #6e6e73; font-size: 12px; text-transform: uppercase; letter-spacing: 0; }
    .danger { color: #9b1c12; }
    .muted { color: var(--muted); }
    @media (max-width: 720px) { .tool-row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>Compliance & Security</h1>
    <div class="sub" id="generated">Loading compliance status...</div>
  </header>
  <nav>
    <a href="/admin/dashboard">Dashboard</a>
    <a href="/admin/chat">Chat Inbox</a>
    <a href="/admin/whatsapp-web">WhatsApp Web</a>
    <a href="/admin/analytics">Analytics</a>
    <a href="/admin/reply-library">Reply Library</a>
    <a href="/admin/product-flow">Product Flow</a>
    <a href="/admin/follow-up-settings">Follow-Up Settings</a>
    <a href="/admin/compliance">Compliance</a>
    <a href="/demo/chat">Customer Demo</a>
    <button id="refresh" type="button">Refresh</button>
    <a href="/admin/dashboard?tab=profile">Profile</a>
  </nav>
  <main>
    <section>
      <h2>Customer Data Tools</h2>
      <div class="content">
        <div class="tool-row">
          <input id="customer-id" placeholder="Customer WhatsApp ID" />
          <button id="export-customer" type="button">Export Customer Data</button>
          <button id="delete-customer" class="danger" type="button">Delete Customer</button>
        </div>
        <p class="muted">Deletion moves the customer out of active customers and records the action in the audit log.</p>
        <pre id="customer-result">No customer action yet.</pre>
      </div>
    </section>
    <section>
      <h2>Reset Demo Data</h2>
      <div class="content">
        <p class="muted">Use this before a fresh test. It clears demo customers, orders, message logs, deleted customers, and writes an audit event.</p>
        <button id="reset-demo" class="danger" type="button">Reset Demo Data</button>
      </div>
    </section>
    <section>
      <h2>Generate Test Customers</h2>
      <div class="content">
        <p class="muted">Creates local simulated customers only. No real WhatsApp messages are sent.</p>
        <div class="tool-row">
          <input id="test-customer-count" type="number" min="1" max="500" value="100" />
          <button id="generate-test-customers" type="button">Generate Test Customers</button>
        </div>
      </div>
    </section>
    <section><h2>Data Retention Policy</h2><div class="content" id="retention"></div></section>
    <section><h2>Automation Guardrails</h2><div class="content" id="automation-guardrails"></div></section>
    <section><h2>WhatsApp Go-Live Readiness</h2><div class="content" id="whatsapp-readiness"></div></section>
    <section><h2>Security Checklist</h2><div class="content" id="security"></div></section>
    <section><h2>Privacy Notice Template</h2><div class="content" id="privacy"></div></section>
    <section><h2>Human Handoff Rules</h2><div class="content" id="handoff-rules"></div></section>
    <section><h2>Audit Log</h2><div class="content" id="audit-log"></div></section>
  </main>
  <script>
    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, function(ch) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
      });
    }
    function fmtTime(value) {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return esc(value);
      return date.toLocaleString();
    }
    function list(items, render) {
      return '<ul>' + items.map(item => '<li>' + render(item) + '</li>').join('') + '</ul>';
    }
    function table(rows, columns) {
      if (!rows.length) return '<p class="muted">No records yet.</p>';
      return '<table><thead><tr>' + columns.map(c => '<th>' + esc(c.label) + '</th>').join('') +
        '</tr></thead><tbody>' + rows.map(row => '<tr>' + columns.map(c => '<td>' + (c.render ? c.render(row) : esc(row[c.key])) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
    }
    async function loadCompliance() {
      const response = await fetch('/admin/compliance-data');
      const data = await response.json();
      document.querySelector('#generated').textContent = 'Generated ' + fmtTime(data.generatedAt);
      document.querySelector('#retention').innerHTML = table(data.retentionPolicy, [
        { label: 'Data', key: 'item' },
        { label: 'Rule', key: 'rule' }
      ]);
      document.querySelector('#automation-guardrails').innerHTML = table(data.automationGuardrails, [
        { label: 'Guardrail', key: 'item' },
        { label: 'Status', key: 'status' }
      ]);
      document.querySelector('#whatsapp-readiness').innerHTML = table(data.whatsappReadiness, [
        { label: 'Launch Item', key: 'item' },
        { label: 'Status', key: 'status' }
      ]);
      document.querySelector('#security').innerHTML = table(data.securityChecklist, [
        { label: 'Security Item', key: 'item' },
        { label: 'Status', key: 'status' }
      ]);
      document.querySelector('#privacy').innerHTML = list(data.privacyNotice, item => esc(item));
      document.querySelector('#handoff-rules').innerHTML = list(data.handoffRules, item => esc(item));
      document.querySelector('#audit-log').innerHTML = table(data.auditLog, [
        { label: 'Time', key: 'createdAt', render: r => fmtTime(r.createdAt) },
        { label: 'Actor', key: 'actor' },
        { label: 'Action', key: 'action' },
        { label: 'Customer', key: 'customerId' },
        { label: 'Result', key: 'result' },
        { label: 'Reason', key: 'reason' }
      ]);
    }
    async function exportCustomer() {
      const customerId = document.querySelector('#customer-id').value.trim();
      if (!customerId) return;
      const response = await fetch('/admin/customer/export?customerId=' + encodeURIComponent(customerId));
      const data = await response.json();
      document.querySelector('#customer-result').textContent = JSON.stringify(data, null, 2);
      loadCompliance();
    }
    async function deleteCustomer() {
      const customerId = document.querySelector('#customer-id').value.trim();
      if (!customerId) return;
      const reason = 'Manual deletion from compliance page';
      const response = await fetch('/admin/customer/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId, reason })
      });
      const data = await response.json();
      document.querySelector('#customer-result').textContent = JSON.stringify(data, null, 2);
      loadCompliance();
    }
    async function resetDemoData() {
      const ok = confirm('Reset all demo customers, orders, deleted customers, message logs, and audit log?');
      if (!ok) return;
      const response = await fetch('/admin/reset-demo-data', { method: 'POST' });
      const data = await response.json();
      document.querySelector('#customer-result').textContent = JSON.stringify(data, null, 2);
      loadCompliance();
    }
    async function generateTestCustomers() {
      const count = Number(document.querySelector('#test-customer-count').value || 100);
      const button = document.querySelector('#generate-test-customers');
      button.disabled = true;
      button.textContent = 'Generating...';
      document.querySelector('#customer-result').textContent = 'Generating ' + count + ' simulated customer(s)...';
      try {
        const response = await fetch('/admin/generate-test-customers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count })
        });
        const text = await response.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = { ok: false, status: response.status, error: text || 'Unexpected empty response' };
        }
        document.querySelector('#customer-result').textContent = JSON.stringify(data, null, 2);
        loadCompliance();
      } finally {
        button.disabled = false;
        button.textContent = 'Generate Test Customers';
      }
    }
    document.querySelector('#refresh').addEventListener('click', loadCompliance);
    document.querySelector('#export-customer').addEventListener('click', exportCustomer);
    document.querySelector('#delete-customer').addEventListener('click', deleteCustomer);
    document.querySelector('#reset-demo').addEventListener('click', resetDemoData);
    document.querySelector('#generate-test-customers').addEventListener('click', generateTestCustomers);
    loadCompliance();
    setInterval(loadCompliance, 15000);
  </script>
</body>
</html>`;
}

async function demoChatHtml(contentAccountId = config.accountId) {
  const content = await getTeamContent(contentAccountId);
  const demoCatalog = content.catalog || catalog;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp Agent Demo</title>
  <style>
    :root {
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Arial, sans-serif;
      background: #f5f5f7;
      color: #1d1d1f;
      --surface: #ffffff;
      --surface-soft: #fbfbfd;
      --line: #d2d2d7;
      --muted: #6e6e73;
      --accent: #0071e3;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: #f5f5f7;
    }
    .admin-shell {
      width: 100%;
      min-height: 100vh;
    }
    .admin-header {
      padding: 16px 22px 10px;
      background: rgba(251,251,253,.9);
      color: #1d1d1f;
      border-bottom: 1px solid rgba(210,210,215,.8);
      backdrop-filter: saturate(180%) blur(16px);
    }
    .admin-header h1 {
      margin: 0;
      font-size: 20px;
    }
    .admin-header .sub {
      margin-top: 4px;
      color: var(--muted);
      font-size: 13px;
    }
    nav {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 10px 22px 14px;
      background: rgba(251,251,253,.9);
      border-bottom: 1px solid rgba(210,210,215,.8);
      backdrop-filter: saturate(180%) blur(16px);
    }
    nav a {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 11px;
      background: var(--surface);
      color: #1d1d1f;
      text-decoration: none;
      font-weight: 600;
      cursor: pointer;
    }
    nav a:hover { border-color: #a8a8ad; }
    main {
      width: min(760px, 100%);
      min-height: calc(100vh - 118px);
      margin: 0 auto;
      display: grid;
      grid-template-rows: auto 1fr auto;
      background: #fbfbfd;
      border-left: 1px solid #e5e5ea;
      border-right: 1px solid #e5e5ea;
    }
    header {
      padding: 16px 18px;
      background: rgba(255,255,255,.92);
      color: #1d1d1f;
      border-bottom: 1px solid #e5e5ea;
      backdrop-filter: saturate(180%) blur(16px);
    }
    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
    }
    .status {
      margin-top: 4px;
      color: #6e6e73;
      font-size: 13px;
    }
    .demo-controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      color: #6e6e73;
      font-size: 13px;
    }
    .demo-controls select {
      min-width: 220px;
      border: 1px solid #d2d2d7;
      border-radius: 8px;
      padding: 7px 9px;
      font: inherit;
      background: white;
    }
    .product-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .product-buttons button {
      border: 1px solid #d2d2d7;
      background: #fff;
      color: #1d1d1f;
      padding: 7px 9px;
      font-size: 12px;
    }
    .product-buttons button.active {
      border-color: var(--accent);
      background: #e8f2ff;
      color: #0057b8;
    }
    #messages {
      overflow-y: auto;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .bubble {
      max-width: min(560px, 88%);
      padding: 10px 12px;
      border-radius: 8px;
      white-space: pre-wrap;
      line-height: 1.38;
      box-shadow: 0 1px 2px rgba(0,0,0,.06);
      font-size: 15px;
    }
    .customer {
      align-self: flex-end;
      background: #e8f2ff;
    }
    .agent {
      align-self: flex-start;
      background: #fff;
    }
    .agent img {
      max-width: 100%;
      display: block;
      border-radius: 6px;
      margin-bottom: 8px;
    }
    form {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      padding: 14px;
      background: rgba(255,255,255,.92);
      border-top: 1px solid #e5e5ea;
    }
    textarea {
      min-height: 44px;
      max-height: 150px;
      resize: vertical;
      border: 1px solid #d2d2d7;
      border-radius: 8px;
      padding: 11px 12px;
      font: inherit;
      background: white;
    }
    textarea:focus {
      outline: 3px solid rgba(0,113,227,.18);
      border-color: var(--accent);
    }
    button {
      border: 0;
      border-radius: 8px;
      padding: 0 18px;
      background: var(--accent);
      color: white;
      font-weight: 700;
      cursor: pointer;
    }
    button:disabled {
      opacity: .55;
      cursor: wait;
    }
    .quick {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      padding: 0 14px 12px;
      background: rgba(255,255,255,.92);
    }
    .quick button {
      background: #f5f5f7;
      color: #1d1d1f;
      padding: 8px 10px;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="admin-shell">
    <div class="admin-header">
      <h1 id="demo-admin-title">Customer Demo</h1>
      <div class="sub">Test the customer-facing WhatsApp flow.</div>
    </div>
    <nav>
      <a href="/admin/dashboard">Dashboard</a>
      <a href="/admin/chat">Chat Inbox</a>
      <a href="/admin/analytics">Analytics</a>
      <a href="/admin/reply-library">Reply Library</a>
      <a href="/admin/product-flow">Product Flow</a>
      <a href="/admin/follow-up-settings">Follow-Up Settings</a>
      <a href="/admin/compliance">Compliance</a>
      <a href="/demo/chat">Customer Demo</a>
      <button id="refresh" type="button">Refresh</button>
      <a href="/admin/dashboard?tab=profile">Profile</a>
    </nav>
  <main>
    <header>
      <h1>WhatsApp Product Demo</h1>
      <div class="status">You are acting as <span id="customer-id-label"></span></div>
      <div class="demo-controls">
        <label for="demo-product">Demo product</label>
        <select id="demo-product"></select>
      </div>
      <div class="product-buttons" id="demo-product-buttons"></div>
    </header>
    <section id="messages" aria-live="polite"></section>
    <div>
      <div class="quick">
        <button type="button" id="start-from-ad">Start from ad</button>
        <button type="button" data-text="Tanya dulu">Tanya dulu</button>
        <button type="button" data-text="Business location kat mana?">Business location</button>
        <button type="button" data-text="Saya mau order Package B">Order Package B</button>
        <button type="button" data-text="Full name: Ali\\nFull address: Kiulap\\nPhone number: 6731234567\\nOrder Package: B">Fill details</button>
        <button type="button" id="new-customer">New customer</button>
        <button type="button" id="followup-today">Test 8pm follow-up</button>
        <button type="button" id="followup-day1">Test DAY 1 follow-up</button>
        <button type="button" id="delete-day11">Test DAY 11 delete</button>
      </div>
      <form id="chat-form">
        <textarea id="message" placeholder="Type customer message..." autofocus></textarea>
        <button id="send" type="submit">Send</button>
      </form>
    </div>
  </main>
  </div>
  <script>
    const demoProducts = ${JSON.stringify(demoCatalog.products.map((product) => ({
      id: product.id,
      name: product.name,
      adKeyword: product.ad_keywords?.[0] || product.name,
      ready: product.openingFlowEnabled !== false,
    })))};
    const messages = document.querySelector("#messages");
    const form = document.querySelector("#chat-form");
    const input = document.querySelector("#message");
    const send = document.querySelector("#send");
    const productSelect = document.querySelector("#demo-product");
    const productButtons = document.querySelector("#demo-product-buttons");
    function newDemoCustomerId() {
      return "6016" + String(Date.now()).slice(-8);
    }
    let customerId = localStorage.getItem("demoCustomerId") || newDemoCustomerId();
    if (!/^\\d{8,15}$/.test(customerId)) {
      customerId = newDemoCustomerId();
    }
    let selectedProductId = localStorage.getItem("demoProductId") || ${JSON.stringify(demoCatalog.default_product_id)};
    localStorage.setItem("demoCustomerId", customerId);
    document.querySelector("#customer-id-label").textContent = customerId;

    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, function(ch) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
      });
    }

    function applyProfile(profile = {}) {
      const name = String(profile.name || "").trim();
      const accentColor = /^#[0-9a-fA-F]{6}$/.test(String(profile.accentColor || "")) ? profile.accentColor : "#0071e3";
      document.documentElement.style.setProperty("--accent", accentColor);
      document.querySelector("#demo-admin-title").textContent = name ? name + " Customer Demo" : "Customer Demo";
    }

    function selectedProduct() {
      return demoProducts.find(product => product.id === selectedProductId) || demoProducts[0] || {};
    }

    function renderProductOptions() {
      productSelect.innerHTML = demoProducts.map(product =>
        '<option value="' + esc(product.id) + '">' + esc(product.name + (product.ready ? "" : " (Setup)")) + '</option>'
      ).join("");
      if (!demoProducts.some(product => product.id === selectedProductId) && demoProducts[0]) {
        selectedProductId = demoProducts[0].id;
      }
      productSelect.value = selectedProductId;
      productButtons.innerHTML = demoProducts.map(product =>
        '<button type="button" class="' + (product.id === selectedProductId ? 'active' : '') +
        '" data-product-id="' + esc(product.id) + '">' + esc(product.name) + '</button>'
      ).join("");
      productButtons.querySelectorAll("button[data-product-id]").forEach(button => {
        button.addEventListener("click", () => switchDemoProduct(button.dataset.productId));
      });
    }

    function switchDemoProduct(productId) {
      selectedProductId = productId;
      localStorage.setItem("demoProductId", selectedProductId);
      productSelect.value = selectedProductId;
      renderProductOptions();
      customerId = newDemoCustomerId();
      localStorage.setItem("demoCustomerId", customerId);
      document.querySelector("#customer-id-label").textContent = customerId;
      messages.innerHTML = "";
      addBubble("agent", "Switched demo product to " + selectedProduct().name + ". Click Start from ad to test this product.");
    }

    function addBubble(role, content) {
      const bubble = document.createElement("div");
      bubble.className = "bubble " + role;
      if (typeof content === "string") {
        bubble.textContent = content;
      } else {
        bubble.append(content);
      }
      messages.append(bubble);
      messages.scrollTop = messages.scrollHeight;
    }

    async function sendMessage(text) {
      if (!text.trim()) return;
      addBubble("customer", text);
      input.value = "";
      send.disabled = true;
      try {
        const product = selectedProduct();
        const adSource = {
          referralHeadline: "Facebook ad " + (product.adKeyword || product.name || selectedProductId),
          productId: product.id || selectedProductId,
        };
        const source = { productId: product.id || selectedProductId };
        if (text.toLowerCase().includes("berminat")) {
          source.referralHeadline = adSource.referralHeadline;
        }
        const response = await fetch("/demo/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: customerId,
            text,
            productId: product.id || selectedProductId,
            source
          })
        });
        const responseText = await response.text();
        let data;
        try {
          data = JSON.parse(responseText);
        } catch (error) {
          throw new Error(responseText || ("HTTP " + response.status));
        }
        if (!response.ok) {
          throw new Error(data.error || responseText || ("HTTP " + response.status));
        }
        for (const message of data.messages || []) {
          if (message.type === "image") {
            const wrap = document.createElement("div");
            const img = document.createElement("img");
            img.src = message.url;
            img.alt = message.caption || "Product image";
            img.onerror = () => {
              console.warn("Demo image could not load", message.url);
              wrap.remove();
            };
            wrap.append(img);
            if (message.caption) {
              const caption = document.createElement("div");
              caption.textContent = message.caption;
              wrap.append(caption);
            }
            addBubble("agent", wrap);
          } else {
            addBubble("agent", message.body || "");
          }
        }
      } catch (error) {
        addBubble("agent", "Demo error: " + error.message);
      } finally {
        send.disabled = false;
        input.focus();
      }
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      sendMessage(input.value);
    });

    document.querySelectorAll(".quick button").forEach((button) => {
      if (button.dataset.text) {
        button.addEventListener("click", () => sendMessage(button.dataset.text.replace(/\\\\n/g, "\\n")));
      }
    });

    document.querySelector("#start-from-ad").addEventListener("click", () => {
      const product = selectedProduct();
      sendMessage(product.name || selectedProductId);
    });

    document.querySelector("#new-customer").addEventListener("click", () => {
      customerId = newDemoCustomerId();
      localStorage.setItem("demoCustomerId", customerId);
      document.querySelector("#customer-id-label").textContent = customerId;
      messages.innerHTML = "";
      addBubble("agent", "New customer created. Select a product, then click Start from ad to see product info and images.");
    });

    productSelect.addEventListener("change", () => {
      switchDemoProduct(productSelect.value);
    });
    document.querySelector("#refresh").addEventListener("click", () => window.location.reload());

    async function runFollowup(now, label) {
      const response = await fetch("/demo/followups/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ now })
      });
      const data = await response.json();
      addBubble("agent", label + "\\nSent: " + data.sent + "\\nDeleted: " + (data.deleted || 0));
      for (const item of data.customers || []) {
        if (item.customerId === customerId && item.message) {
          addBubble("agent", item.message);
        }
      }
      for (const item of data.deletedCustomers || []) {
        if (item.customerId === customerId) {
          addBubble("agent", "Customer deleted from active list: " + item.deleteReason);
        }
      }
      if (!data.sent) {
        addBubble("agent", "No follow-up due for this customer at that time.");
      }
    }

    async function setCustomerFirstSeen(hour) {
      const firstSeen = new Date();
      firstSeen.setHours(hour, 0, 0, 0);
      await fetch("/demo/customer/time", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, firstSeenAt: firstSeen.toISOString() })
      });
    }

    renderProductOptions();

    fetch("/admin/dashboard-data")
      .then(response => response.ok ? response.json() : null)
      .then(data => { if (data && data.profile) applyProfile(data.profile); })
      .catch(() => {});

    document.querySelector("#followup-today").addEventListener("click", () => {
      const now = new Date();
      now.setHours(20, 0, 0, 0);
      setCustomerFirstSeen(18).then(() => {
        runFollowup(now.toISOString(), "Testing first 8pm follow-up");
      });
    });

    document.querySelector("#followup-day1").addEventListener("click", () => {
      const now = new Date();
      now.setDate(now.getDate() + 1);
      now.setHours(20, 0, 0, 0);
      runFollowup(now.toISOString(), "Testing DAY 1 8pm follow-up");
    });

    document.querySelector("#delete-day11").addEventListener("click", () => {
      const now = new Date();
      now.setDate(now.getDate() + 11);
      now.setHours(9, 0, 0, 0);
      runFollowup(now.toISOString(), "Testing DAY 11 delete");
    });
  </script>
</body>
</html>`;
}


