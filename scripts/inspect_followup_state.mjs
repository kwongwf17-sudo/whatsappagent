import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadEnvFile, getEnv } from "../lib/env.mjs";
import { JsonStore } from "../lib/store.mjs";
import { OperationsStore } from "../lib/operations.mjs";
import { PostgresJsonAdapter } from "../lib/postgres_adapter.mjs";
import { SqliteJsonAdapter } from "../lib/sqlite_adapter.mjs";
import { TeamContentStore } from "../lib/team_content.mjs";

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
const customerFilter = argList("customers");
const [windowStart, windowEnd] = parseWindow(windowText);

const dataDir = path.resolve(getEnv("WHATSAPP_DATA_DIR", path.join(rootDir, "data")));
const adapter = await createAdapter(dataDir);
const store = new JsonStore(dataDir, { adapter });
const operations = new OperationsStore(dataDir, { adapter });
const teamContentStore = new TeamContentStore(dataDir, { adapter });
const defaultCatalog = await readJsonSeed("PRODUCT_CATALOG_PATH", "product_catalog.json", { default_product_id: "", products: [] });
const defaultTeamContent = { catalog: defaultCatalog, faqLibrary: { approved_faqs: [] }, salesReplyLibrary: { sales_replies: [] } };

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
const targetAt = localDateHourToDate(date, targetHour);

const rows = previousNoToday.map((customerId) => describeCustomer(customerId, customerById.get(customerId)));
const inspectedCustomers = customerFilter.length
  ? await Promise.all(customerFilter.map((customerId) => inspectCustomerAtTarget(customerId, customerById.get(customerId))))
  : [];

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
  inspectedCustomers,
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

async function inspectCustomerAtTarget(customerId, customer) {
  const base = describeCustomer(customerId, customer);
  if (!customer) return { ...base, targetDate: date, targetHour, targetLocal: localDateTime(targetAt), reason: "customer_not_found" };
  if ((customer.orderIds || []).length > 0) {
    return { ...base, targetDate: date, targetHour, targetLocal: localDateTime(targetAt), reason: "order_submitted" };
  }
  if (customer.optedOut) {
    return { ...base, targetDate: date, targetHour, targetLocal: localDateTime(targetAt), reason: "opted_out" };
  }
  if (customer.followupBlocked) {
    return {
      ...base,
      targetDate: date,
      targetHour,
      targetLocal: localDateTime(targetAt),
      reason: "followup_blocked",
      followupBlockedReason: customer.followupBlockedReason || "",
    };
  }

  const content = await getContentForCustomer(customer);
  const product = (content.catalog?.products || []).find((item) => item.id === customer.productId);
  if (!product) {
    return { ...base, targetDate: date, targetHour, targetLocal: localDateTime(targetAt), reason: "product_not_found" };
  }

  const sequence = productFollowupSequence(product);
  const currentStage = currentFollowupStage(customer, sequence, targetAt);
  const nextUnsent = sequence.find((item) => !customer.followupsSent?.[item.key]);
  const stageForDue = currentStage || nextUnsent || null;
  const dueAt = stageForDue ? effectiveFollowupDueAt(customer, stageForDue, sequence) : null;
  const inWindow = currentStage ? isCurrentFollowupSendWindow(customer, currentStage, sequence, targetAt) : false;
  const sentAtTargetHour = followupOutbox.some((message) =>
    message.to === customerId &&
    isLocalDate(message.createdAt, date) &&
    localHour(message.createdAt) === targetHour
  );
  return {
    ...base,
    targetDate: date,
    targetHour,
    targetLocal: localDateTime(targetAt),
    productName: product.name || "",
    currentStageKey: currentStage?.key || "",
    nextUnsentKey: nextUnsent?.key || "",
    dueAt: dueAt?.toISOString() || "",
    dueLocal: dueAt ? localDateTime(dueAt) : "",
    inTargetSendWindow: inWindow,
    sentAtTargetHour,
    reason: sentAtTargetHour
      ? "sent_at_target_hour"
      : inWindow
        ? "due_at_target_hour_but_not_sent"
        : stageForDue
          ? "not_due_in_target_hour"
          : "all_followups_already_sent",
  };
}

async function getContentForCustomer(customer) {
  return teamContentStore.getContent(customer.businessAccountId || account || "default", defaultTeamContent);
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

function argList(name) {
  const value = argValue(name, "");
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function readJsonSeed(envName, fallbackName, fallbackValue) {
  const candidate = getEnv(envName, "");
  const paths = [
    candidate ? path.resolve(candidate) : "",
    path.join(dataDir, fallbackName),
    path.join(rootDir, "data", fallbackName),
  ].filter(Boolean);
  for (const filePath of paths) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return fallbackValue;
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

function localDateHourToDate(dateText, hour) {
  const [year, month, day] = String(dateText).split("-").map(Number);
  return zonedLocalToDate({ year, month, day, hour, minute: 0, second: 0, millisecond: 0 });
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

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, parts.second || 0, parts.millisecond || 0));
  return {
    ...parts,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function zonedLocalToDate(parts) {
  const targetUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second || 0,
    parts.millisecond || 0
  );
  const guess = new Date(targetUtc);
  const guessParts = localParts(guess);
  const guessAsUtc = Date.UTC(
    guessParts.year,
    guessParts.month - 1,
    guessParts.day,
    guessParts.hour,
    guessParts.minute,
    guessParts.second || 0,
    guessParts.millisecond || 0
  );
  return new Date(targetUtc - (guessAsUtc - guess.getTime()));
}

function productFollowupSequence(product) {
  const entries = Object.entries(product.followups || {});
  const firstFollowup = entries.find(([key]) => key === "first_day_followup")?.[1] || {};
  return entries
    .map(([key, followup], index) => ({
      key,
      followup,
      firstFollowup,
      index,
      dayOffset: followupDayOffset(key, followup, index),
      sendHour: Number.isFinite(followup?.send_hour) ? followup.send_hour : 20,
    }))
    .sort((a, b) => a.dayOffset - b.dayOffset || a.index - b.index);
}

function followupDayOffset(key, followup, index) {
  if (Number.isFinite(followup?.day_offset)) return followup.day_offset;
  if (key === "first_day_followup") return 0;
  const dayMatch = String(key).match(/^day_(\d+)_followup$/);
  if (dayMatch) return Number(dayMatch[1]);
  return index;
}

function firstFollowupDueAt(firstSeenAt, options = {}) {
  const firstSeen = new Date(firstSeenAt);
  const firstSeenLocal = localParts(firstSeen);
  const sendHour = Number.isFinite(options.sendHour) ? options.sendHour : 20;
  const cutoffHour = Number.isFinite(options.cutoffHour) ? options.cutoffHour : 19;
  const cutoffEnabled = options.cutoffEnabled !== false;
  const skipSameDay = cutoffEnabled && firstSeenLocal.hour >= cutoffHour;
  const dueLocal = addLocalDays({ ...firstSeenLocal, hour: sendHour, minute: 0, second: 0, millisecond: 0 }, skipSameDay ? 1 : 0);
  let due = zonedLocalToDate(dueLocal);
  if (due <= firstSeen) {
    due = zonedLocalToDate(addLocalDays(dueLocal, 1));
  }
  return due;
}

function followupDueAt(firstSeenAt, item) {
  const firstDueAt = firstFollowupDueAt(firstSeenAt, {
    cutoffEnabled: item.firstFollowup?.first_chat_cutoff_enabled !== false,
    cutoffHour: item.firstFollowup?.first_chat_cutoff_hour,
    sendHour: Number.isFinite(item.firstFollowup?.send_hour) ? item.firstFollowup.send_hour : item.sendHour,
  });
  if (item.key === "first_day_followup") return firstDueAt;
  const firstSeenLocal = localParts(new Date(firstSeenAt));
  const dueLocal = addLocalDays({ ...firstSeenLocal, hour: item.sendHour, minute: 0, second: 0, millisecond: 0 }, item.dayOffset);
  let due = zonedLocalToDate(dueLocal);
  if (due <= firstDueAt) {
    due = zonedLocalToDate(addLocalDays({ ...localParts(firstDueAt), hour: item.sendHour, minute: 0, second: 0, millisecond: 0 }, 1));
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

function nextFollowupDueAfterPreviousSent(previousSentAt, item) {
  const previousLocal = localParts(previousSentAt);
  const nextLocal = addLocalDays({ ...previousLocal, hour: item.sendHour, minute: 0, second: 0, millisecond: 0 }, 1);
  let due = zonedLocalToDate(nextLocal);
  if (due <= previousSentAt) {
    due = zonedLocalToDate(addLocalDays(nextLocal, 1));
  }
  return due;
}

function effectiveFollowupDueAt(customer, item, sequence = []) {
  const scheduledDueAt = followupDueAt(customer.firstSeenAt, item);
  const previousSentAt = previousFollowupSentAt(customer, item, sequence);
  if (!previousSentAt) return scheduledDueAt;
  const previousGateAt = nextFollowupDueAfterPreviousSent(previousSentAt, item);
  return scheduledDueAt > previousGateAt ? scheduledDueAt : previousGateAt;
}

function currentFollowupStage(customer, sequence = [], now = new Date()) {
  return sequence.find((item) => {
    if (customer.followupsSent?.[item.key]) return false;
    const dueAt = effectiveFollowupDueAt(customer, item, sequence);
    if (!dueAt) return false;
    const nowLocal = localParts(now);
    const dueLocal = localParts(dueAt);
    return nowLocal.year === dueLocal.year && nowLocal.month === dueLocal.month && nowLocal.day === dueLocal.day;
  }) || null;
}

function isCurrentFollowupSendWindow(customer, item, sequence = [], now = new Date()) {
  const dueAt = effectiveFollowupDueAt(customer, item, sequence);
  if (!dueAt) return false;
  const nowLocal = localParts(now);
  const dueLocal = localParts(dueAt);
  return (
    now >= dueAt &&
    nowLocal.year === dueLocal.year &&
    nowLocal.month === dueLocal.month &&
    nowLocal.day === dueLocal.day
  );
}
