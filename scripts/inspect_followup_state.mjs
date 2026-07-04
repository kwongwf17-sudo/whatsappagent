import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile, getEnv } from "../lib/env.mjs";
import { JsonStore } from "../lib/store.mjs";
import { OperationsStore } from "../lib/operations.mjs";
import { PostgresJsonAdapter } from "../lib/postgres_adapter.mjs";
import { SqliteJsonAdapter } from "../lib/sqlite_adapter.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

await loadEnvFile(path.join(rootDir, ".env"));
await loadEnvFile();

const timeZone = getEnv("BUSINESS_TIME_ZONE", "Asia/Kuala_Lumpur");
const today = localDateString(new Date());
const date = argValue("date", today);
const previousDate = argValue("prev-date", previousLocalDate(date));
const account = argValue("account", "");
const windowText = argValue("window", "19:30-19:45");
const targetHour = Number(argValue("target-hour", "20"));
const [windowStart, windowEnd] = parseWindow(windowText);

const dataDir = path.resolve(getEnv("WHATSAPP_DATA_DIR", path.join(rootDir, "data")));
const adapter = await createAdapter(dataDir);
const store = new JsonStore(dataDir, { adapter });
const operations = new OperationsStore(dataDir, { adapter });

const [customers, outbox, queue, errors, failed] = await Promise.all([
  store.listCustomers(new Date(), account),
  store.listOutbox(account),
  operations.listFollowupQueue(account),
  operations.listErrors(account),
  operations.listFailedMessages(account),
]);

const followupOutbox = outbox.filter((message) => message.purpose === "followup");
const previousWindowSends = followupOutbox.filter((message) =>
  isLocalDate(message.createdAt, previousDate) &&
  localMinuteOfDay(message.createdAt) >= windowStart &&
  localMinuteOfDay(message.createdAt) <= windowEnd
);
const todayTargetSends = followupOutbox.filter((message) =>
  isLocalDate(message.createdAt, date) &&
  localHour(message.createdAt) === targetHour
);

const previousCustomerIds = new Set(previousWindowSends.map((message) => message.to).filter(Boolean));
const todayCustomerIds = new Set(todayTargetSends.map((message) => message.to).filter(Boolean));
const previousNoToday = [...previousCustomerIds].filter((id) => !todayCustomerIds.has(id));
const todayNoPrevious = [...todayCustomerIds].filter((id) => !previousCustomerIds.has(id));
const customerById = new Map(customers.map((customer) => [customer.id, customer]));

const rows = previousNoToday.map((customerId) => describeCustomer(customerId, customerById.get(customerId)));

console.log(JSON.stringify({
  inspectedAt: new Date().toISOString(),
  account: account || "ALL",
  timeZone,
  previousDate,
  date,
  previousWindow: windowText,
  targetHour,
  totals: {
    customers: customers.length,
    followupOutbox: followupOutbox.length,
    previousWindowSends: previousWindowSends.length,
    todayTargetSends: todayTargetSends.length,
    previousWindowCustomers: previousCustomerIds.size,
    todayTargetCustomers: todayCustomerIds.size,
    previousWindowButNoTodayTarget: previousNoToday.length,
    todayTargetButNoPreviousWindow: todayNoPrevious.length,
  },
  previousWindowMessagesByKey: countBy(previousWindowSends, "followupKey"),
  todayTargetMessagesByKey: countBy(todayTargetSends, "followupKey"),
  previousWindowButNoTodayTarget: rows,
  todayTargetButNoPreviousWindow: todayNoPrevious.slice(0, 50).map((customerId) =>
    describeCustomer(customerId, customerById.get(customerId))
  ),
  queueForPreviousNoToday: queue
    .filter((item) => previousNoToday.includes(item.customerId))
    .slice(0, 100)
    .map(queueSummary),
  recentFollowupErrors: errors
    .filter((error) => /followup/i.test(`${error.scope} ${error.message} ${error.details}`))
    .slice(0, 30),
  recentFailedFollowupMessages: failed
    .filter((message) => message.purpose === "followup" || /followup/i.test(`${message.purpose} ${message.error}`))
    .slice(0, 30),
}, null, 2));

async function createAdapter(dataDir) {
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

function describeCustomer(customerId, customer) {
  const customerOutbox = followupOutbox
    .filter((message) => message.to === customerId)
    .slice(-10)
    .map((message) => ({
      createdAt: message.createdAt,
      localTime: localDateTime(message.createdAt),
      followupKey: message.followupKey || "",
      status: message.status || "",
      body: String(message.body || "").slice(0, 90),
    }));
  const customerQueue = queue
    .filter((item) => item.customerId === customerId)
    .slice(0, 10)
    .map(queueSummary);
  return {
    customerId,
    exists: Boolean(customer),
    productId: customer?.productId || "",
    label: customer?.labelDisplay || customer?.label || "",
    firstSeenAt: customer?.firstSeenAt || "",
    firstSeenLocal: customer?.firstSeenAt ? localDateTime(customer.firstSeenAt) : "",
    lastInboundAt: customer?.lastInboundAt || "",
    lastInboundLocal: customer?.lastInboundAt ? localDateTime(customer.lastInboundAt) : "",
    orderIds: customer?.orderIds || [],
    optedOut: Boolean(customer?.optedOut),
    followupBlocked: Boolean(customer?.followupBlocked),
    followupBlockedReason: customer?.followupBlockedReason || "",
    followupsSent: customer?.followupsSent || {},
    followupsSentLocal: Object.fromEntries(
      Object.entries(customer?.followupsSent || {}).map(([key, value]) => [key, localDateTime(value)])
    ),
    recentFollowupOutbox: customerOutbox,
    queue: customerQueue,
  };
}

function queueSummary(item) {
  return {
    id: item.id,
    customerId: item.customerId,
    followupKey: item.followupKey,
    status: item.status,
    queuedAt: item.queuedAt,
    queuedLocal: item.queuedAt ? localDateTime(item.queuedAt) : "",
    availableAt: item.availableAt,
    availableLocal: item.availableAt ? localDateTime(item.availableAt) : "",
    sentAt: item.sentAt,
    sentLocal: item.sentAt ? localDateTime(item.sentAt) : "",
    attempts: item.attempts,
    lastError: item.lastError || "",
  };
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || "unknown";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function parseWindow(value) {
  const [start, end] = String(value || "").split("-");
  return [parseClockMinute(start, 0), parseClockMinute(end, 23 * 60 + 59)];
}

function parseClockMinute(value, fallback) {
  const match = String(value || "").trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return fallback;
  return Math.max(0, Math.min(23, Number(match[1]))) * 60 + Math.max(0, Math.min(59, Number(match[2] || 0)));
}

function localDateString(date) {
  const parts = localParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function previousLocalDate(dateText) {
  const [year, month, day] = String(dateText).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day) - 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function localDateTime(value) {
  const parts = localParts(new Date(value));
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function isLocalDate(value, dateText) {
  return localDateString(new Date(value)) === dateText;
}

function localHour(value) {
  return localParts(new Date(value)).hour;
}

function localMinuteOfDay(value) {
  const parts = localParts(new Date(value));
  return parts.hour * 60 + parts.minute;
}

function localParts(date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
}
