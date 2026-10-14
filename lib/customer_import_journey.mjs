import { customerHasActiveFreshAdJourney } from "./customer_state.mjs";

export const CUSTOMER_IMPORT_NEW_STAGE_KEY = "__new_customer__";
const timeZone = process.env.BUSINESS_TIME_ZONE || "Asia/Kuala_Lumpur";

export function customerImportStages() {
  return Array.from({ length: 11 }, (_, day) => ({
    key: day === 0 ? CUSTOMER_IMPORT_NEW_STAGE_KEY : `__customer_day_${day}__`,
    label: day === 0 ? "NEW" : `DAY ${day}`,
  }));
}

export function customerImportStageDay(key) {
  if (key === CUSTOMER_IMPORT_NEW_STAGE_KEY) return 0;
  const match = /^__customer_day_(\d+)__$/.exec(String(key || ""));
  const day = match ? Number(match[1]) : NaN;
  return Number.isInteger(day) && day >= 1 && day <= 10 ? day : null;
}

export function followupJourneyDay(item) {
  if (item.customSchedule && item.timingType === "delay_after_opening") {
    return Math.floor(Number(item.delayMinutes || Number(item.delayHours || 1) * 60) / 1440);
  }
  return Number(item.dayOffset || 0);
}

export function importedFollowupHistory(existing, sequence, stageKey, importedAt) {
  const day = customerImportStageDay(stageKey);
  if (day === null) throw new Error("Select a customer stage from NEW through DAY 10. Refresh the import page if necessary.");
  const sent = { ...existing?.followupsSent };
  for (const item of sequence) {
    if (followupJourneyDay(item) < day && !sent[item.key]) sent[item.key] = importedAt;
  }
  return sent;
}

export function createImportJourney(stageKey, productId, importedAt) {
  const startingDay = customerImportStageDay(stageKey);
  if (startingDay === null || !Number.isFinite(Date.parse(importedAt))) throw new Error("Invalid customer import journey.");
  return { version: 1, productId, startingDay, importedAt };
}

export function activeImportJourney(customer = {}) {
  const journey = customer.importJourney;
  if (customerHasActiveFreshAdJourney(customer) || !customer.importedCustomer || journey?.version !== 1) return null;
  if (journey.productId !== customer.productId || !Number.isInteger(journey.startingDay) || journey.startingDay < 0 || journey.startingDay > 10) return null;
  if (!Number.isFinite(Date.parse(journey.importedAt))) return null;
  if (Date.parse(customer.productJourneyResetAt || "") > Date.parse(journey.importedAt)) return null;
  return journey;
}

function localParts(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
}

function localDay(value) {
  const p = localParts(value);
  return Date.UTC(p.year, p.month - 1, p.day) / 86400000;
}

export function importedJourneyAgeDays(customer, now = new Date()) {
  const journey = activeImportJourney(customer);
  return journey ? journey.startingDay + Math.max(0, localDay(now) - localDay(journey.importedAt)) : null;
}

function localDateToUtc(parts) {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const p = localParts(guess);
    const difference = target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += difference;
    if (!difference) break;
  }
  return new Date(guess);
}

export function importedFollowupDueAt(customer, item) {
  const journey = activeImportJourney(customer);
  if (!journey) return null;
  const imported = new Date(journey.importedAt);
  const importedLocal = localParts(imported);
  // Fixed schedules follow business calendar dates. Delays retain elapsed-time precision.
  if (item.customSchedule && item.timingType === "delay_after_opening") {
    const delay = Number(item.delayMinutes || Number(item.delayHours || 1) * 60);
    const anchorDay = new Date(Date.UTC(importedLocal.year, importedLocal.month - 1, importedLocal.day - journey.startingDay));
    const anchor = localDateToUtc({ year: anchorDay.getUTCFullYear(), month: anchorDay.getUTCMonth() + 1, day: anchorDay.getUTCDate(), hour: importedLocal.hour, minute: importedLocal.minute });
    // A remaining elapsed-time message may be due immediately, but never before import.
    return new Date(Math.max(imported.getTime(), anchor.getTime() + importedLocal.second * 1000 + imported.getUTCMilliseconds() + delay * 60000));
  }
  const date = new Date(Date.UTC(importedLocal.year, importedLocal.month - 1, importedLocal.day + Number(item.dayOffset || 0) - journey.startingDay));
  const due = localDateToUtc({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: Number.isFinite(item.sendHour) ? item.sendHour : 20, minute: item.sendMinute || 0 });
  // An already-passed slot on the selected day uses the existing paced dispatch queue.
  return due < imported ? imported : due;
}
