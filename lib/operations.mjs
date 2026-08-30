import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_LOG_ROWS = 300;
const MAX_FOLLOWUP_QUEUE_ROWS = 20000;
const DEFAULT_COMPLETED_FOLLOWUP_RETENTION_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const TERMINAL_FOLLOWUP_STATUSES = new Set(["sent", "cancelled", "held_template"]);

export class OperationsStore {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.adapter = options.adapter || null;
    this.statePath = path.join(dataDir, "system_state.json");
    this.errorsPath = path.join(dataDir, "error_log.json");
    this.failedMessagesPath = path.join(dataDir, "failed_messages.json");
    this.noReplyReviewsPath = path.join(dataDir, "no_reply_reviews.json");
    this.followupQueuePath = path.join(dataDir, "followup_dispatch_queue.json");
    this.completedFollowupRetentionMs = retentionMs(
      options.completedFollowupRetentionDays,
      DEFAULT_COMPLETED_FOLLOWUP_RETENTION_DAYS
    );
    this.writeQueue = Promise.resolve();
    this.followupQueueMutation = Promise.resolve();
  }

  async ensureState({ version }) {
    const existing = await this.#readJson(this.statePath, null);
    if (existing) {
      let changed = false;
      if (!existing.noReplyMonitorStartedAt) {
        existing.noReplyMonitorStartedAt = new Date().toISOString();
        changed = true;
      }
      if (!existing.dashboardProfile) {
        existing.dashboardProfile = {
          name: "AI Agent Monitor",
          accentColor: "#0071e3",
        };
        changed = true;
      }
      if (!existing.dashboardProfiles || typeof existing.dashboardProfiles !== "object" || Array.isArray(existing.dashboardProfiles)) {
        existing.dashboardProfiles = {};
        changed = true;
      }
      if (changed) {
        await this.#writeJson(this.statePath, existing);
      }
      return existing;
    }
    const state = {
      version: String(version || "0.1.0-demo"),
      lastUpdatedAt: new Date().toISOString(),
      releaseNotes: "Initial operational record",
      noReplyMonitorStartedAt: new Date().toISOString(),
      dashboardProfile: {
        name: "AI Agent Monitor",
        accentColor: "#0071e3",
      },
      dashboardProfiles: {},
    };
    await this.#writeJson(this.statePath, state);
    return state;
  }

  async getState() {
    return this.#readJson(this.statePath, {
      version: "",
      lastUpdatedAt: "",
      releaseNotes: "",
      noReplyMonitorStartedAt: "",
      dashboardProfile: {
        name: "AI Agent Monitor",
        accentColor: "#0071e3",
      },
      dashboardProfiles: {},
    });
  }

  async getDashboardProfile(accountId = "") {
    const existing = await this.getState();
    const accountKey = String(accountId || "").trim();
    const profiles = existing.dashboardProfiles && typeof existing.dashboardProfiles === "object" && !Array.isArray(existing.dashboardProfiles)
      ? existing.dashboardProfiles
      : {};
    return normalizeDashboardProfile(accountKey ? profiles[accountKey] : existing.dashboardProfile);
  }

  async updateDashboardProfile({ accountId = "", name, accentColor }) {
    const existing = await this.getState();
    const accountKey = String(accountId || "").trim();
    const profile = {
      name: String(name || "AI Agent Monitor").trim().slice(0, 80) || "AI Agent Monitor",
      accentColor: /^#[0-9a-fA-F]{6}$/.test(String(accentColor || "")) ? String(accentColor) : "#0071e3",
    };
    const dashboardProfiles = existing.dashboardProfiles && typeof existing.dashboardProfiles === "object" && !Array.isArray(existing.dashboardProfiles)
      ? { ...existing.dashboardProfiles }
      : {};
    if (accountKey) dashboardProfiles[accountKey] = profile;
    const state = {
      ...existing,
      ...(accountKey ? { dashboardProfiles } : { dashboardProfile: profile }),
      lastUpdatedAt: new Date().toISOString(),
    };
    await this.#writeJson(this.statePath, state);
    return profile;
  }

  async recordRelease({ version, notes }) {
    if (!String(version || "").trim()) throw new Error("Version is required.");
    const existing = await this.getState();
    const state = {
      ...existing,
      version: String(version).trim(),
      lastUpdatedAt: new Date().toISOString(),
      releaseNotes: String(notes || "").trim(),
    };
    await this.#writeJson(this.statePath, state);
    return state;
  }

  async recordError({ scope, message, accountId = "", details = "" }) {
    const db = await this.#readJson(this.errorsPath, { errors: [] });
    const saved = {
      id: `err_${Date.now()}_${db.errors.length + 1}`,
      createdAt: new Date().toISOString(),
      scope: String(scope || "runtime"),
      accountId: String(accountId || ""),
      message: String(message || "Unknown error"),
      details: String(details || ""),
    };
    db.errors.push(saved);
    db.errors = db.errors.slice(-MAX_LOG_ROWS);
    await this.#writeJson(this.errorsPath, db);
    return saved;
  }

  async listErrors(accountId = "") {
    const db = await this.#readJson(this.errorsPath, { errors: [] });
    return db.errors.filter((error) => belongsToBusiness(error, accountId)).reverse();
  }

  async recordFailedMessage({ businessAccountId = "", to, messages = [], meta = {}, error = "" }) {
    const db = await this.#readJson(this.failedMessagesPath, { messages: [] });
    const saved = {
      id: `failed_${Date.now()}_${db.messages.length + 1}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      businessAccountId: String(businessAccountId || ""),
      to: String(to || ""),
      messages: structuredClone(messages),
      meta: structuredClone(meta),
      lastError: String(error || "Message send failed"),
      attempts: 0,
      status: "pending_retry",
    };
    db.messages.push(saved);
    db.messages = db.messages.slice(-MAX_LOG_ROWS);
    await this.#writeJson(this.failedMessagesPath, db);
    return saved;
  }

  async listFailedMessages(businessAccountId = "") {
    const db = await this.#readJson(this.failedMessagesPath, { messages: [] });
    return db.messages.filter((message) => belongsToBusiness(message, businessAccountId)).reverse();
  }

  async getFailedMessage(id) {
    const db = await this.#readJson(this.failedMessagesPath, { messages: [] });
    return db.messages.find((message) => message.id === id) || null;
  }

  async markRetry(id, { success, error = "" }) {
    const db = await this.#readJson(this.failedMessagesPath, { messages: [] });
    const message = db.messages.find((item) => item.id === id);
    if (!message) throw new Error("Failed message not found.");
    message.attempts = Number(message.attempts || 0) + 1;
    message.status = success ? "retried" : "retry_failed";
    message.updatedAt = new Date().toISOString();
    message.lastError = success ? "" : String(error || "Retry failed");
    await this.#writeJson(this.failedMessagesPath, db);
    return message;
  }

  async resolveNoReply({ businessAccountId = "", customerId, inboundMessageId, actor = "business_admin" }) {
    const db = await this.#readJson(this.noReplyReviewsPath, { reviews: [] });
    const saved = {
      id: `review_${Date.now()}_${db.reviews.length + 1}`,
      createdAt: new Date().toISOString(),
      businessAccountId: String(businessAccountId || ""),
      customerId: String(customerId || ""),
      inboundMessageId: String(inboundMessageId || ""),
      actor: String(actor || "business_admin"),
      status: "resolved",
    };
    db.reviews = db.reviews.filter(
      (item) => !(item.customerId === saved.customerId && item.inboundMessageId === saved.inboundMessageId)
    );
    db.reviews.push(saved);
    db.reviews = db.reviews.slice(-MAX_LOG_ROWS);
    await this.#writeJson(this.noReplyReviewsPath, db);
    return saved;
  }

  async listNoReplyReviews(businessAccountId = "") {
    const db = await this.#readJson(this.noReplyReviewsPath, { reviews: [] });
    return db.reviews.filter((review) => belongsToBusiness(review, businessAccountId)).reverse();
  }

  async enqueueFollowups(items = [], queuedAt = new Date()) {
    if (!items.length) return [];
    return this.#mutateFollowupQueue((db, control) => {
      const known = new Map(db.items.map((item) => [item.dispatchKey, item]));
      const saved = [];
      let changed = false;
      for (const item of items) {
        const dueAt = validIsoDate(item.dueAt || item.availableAt) || queuedAt.toISOString();
        const dispatchKey = [
          item.businessAccountId || "",
          item.customerId || "",
          item.followupKey || "",
        ].join(":");
        if (!item.customerId || !item.followupKey) continue;
        const existing = known.get(dispatchKey);
        if (existing) {
          if (existing.status === "held_template" || existing.status === "cancelled") {
            existing.status = "queued";
            existing.dueAt = dueAt;
            existing.availableAt = dueAt;
            existing.updatedAt = queuedAt.toISOString();
            existing.lastError = "";
            existing.message = String(item.message || existing.message || "");
            existing.messages = Array.isArray(item.messages) ? structuredClone(item.messages) : existing.messages;
            saved.push(structuredClone(existing));
            changed = true;
          }
          continue;
        }
        const entry = {
          id: `followup_${Date.now()}_${db.items.length + saved.length + 1}`,
          dispatchKey,
          businessAccountId: String(item.businessAccountId || ""),
          customerId: String(item.customerId),
          productId: String(item.productId || ""),
          labelDisplay: String(item.labelDisplay || ""),
          followupKey: String(item.followupKey),
          message: String(item.message || ""),
          messages: Array.isArray(item.messages) ? structuredClone(item.messages) : [],
          status: "queued",
          attempts: 0,
          queuedAt: queuedAt.toISOString(),
          dueAt,
          availableAt: dueAt,
          updatedAt: queuedAt.toISOString(),
          lastError: "",
        };
        db.items.push(entry);
        known.set(dispatchKey, entry);
        saved.push(entry);
        changed = true;
      }
      if (!changed) control.skipWrite();
      return saved;
    });
  }

  async claimFollowupBatch(limit = 1, now = new Date(), businessAccountId = "") {
    const safeLimit = Math.max(1, Number(limit) || 1);
    const staleBefore = now.getTime() - 5 * 60 * 1000;
    return this.#mutateFollowupQueue((db, control) => {
      let changed = false;
      for (const item of db.items) {
        if (item.status === "processing" && new Date(item.updatedAt || 0).getTime() <= staleBefore) {
          item.status = "retry_pending";
          item.availableAt = now.toISOString();
          item.lastError = "Dispatch worker stopped before completion; retrying.";
          changed = true;
        }
      }
      const batch = db.items
        .filter((item) => {
          if (!["queued", "retry_pending"].includes(item.status)) return false;
          if (!belongsToBusiness(item, businessAccountId)) return false;
          return new Date(item.availableAt || item.queuedAt || 0).getTime() <= now.getTime();
        })
        .sort((a, b) =>
          String(a.availableAt || a.dueAt || a.queuedAt).localeCompare(String(b.availableAt || b.dueAt || b.queuedAt)) ||
          String(a.queuedAt).localeCompare(String(b.queuedAt))
        )
        .slice(0, safeLimit);
      for (const item of batch) {
        item.status = "processing";
        item.attempts = Number(item.attempts || 0) + 1;
        item.updatedAt = now.toISOString();
        changed = true;
      }
      if (!changed) control.skipWrite();
      return structuredClone(batch);
    });
  }

  async updateFollowupDispatch(id, patch = {}) {
    return this.#mutateFollowupQueue((db, control) => {
      const item = db.items.find((entry) => entry.id === id);
      if (!item) throw new Error("Follow-up queue item not found.");
      const next = { ...structuredClone(patch), updatedAt: new Date().toISOString() };
      const changed = Object.entries(patch || {}).some(([key, value]) =>
        JSON.stringify(item[key]) !== JSON.stringify(value)
      );
      if (!changed) {
        control.skipWrite();
        return structuredClone(item);
      }
      Object.assign(item, next);
      return structuredClone(item);
    });
  }

  async updateFollowupDispatches(updates = []) {
    const normalized = (Array.isArray(updates) ? updates : [])
      .map((entry) => ({
        id: String(entry?.id || ""),
        patch: entry?.patch && typeof entry.patch === "object" ? structuredClone(entry.patch) : {},
      }))
      .filter((entry) => entry.id);
    if (!normalized.length) return [];
    return this.#mutateFollowupQueue((db, control) => {
      const saved = [];
      let changed = false;
      const updatedAt = new Date().toISOString();
      for (const { id, patch } of normalized) {
        const item = db.items.find((entry) => entry.id === id);
        if (!item) continue;
        const itemChanged = Object.entries(patch).some(([key, value]) =>
          JSON.stringify(item[key]) !== JSON.stringify(value)
        );
        if (!itemChanged) {
          saved.push(structuredClone(item));
          continue;
        }
        Object.assign(item, patch, { updatedAt });
        changed = true;
        saved.push(structuredClone(item));
      }
      if (!changed) control.skipWrite();
      return saved;
    });
  }

  async listFollowupQueue(businessAccountId = "") {
    const db = await this.#readJson(this.followupQueuePath, { items: [] });
    return db.items.filter((item) => belongsToBusiness(item, businessAccountId)).reverse();
  }

  async #mutateFollowupQueue(mutator) {
    let result;
    const mutate = async () => {
      const db = await this.#readJson(this.followupQueuePath, { items: [] });
      let shouldWrite = true;
      const control = {
        skipWrite() {
          shouldWrite = false;
        },
      };
      result = mutator(db, control);
      if (db.items.length > MAX_FOLLOWUP_QUEUE_ROWS) {
        const active = db.items.filter((item) => !TERMINAL_FOLLOWUP_STATUSES.has(item.status));
        const completed = db.items.filter((item) => TERMINAL_FOLLOWUP_STATUSES.has(item.status));
        const completedSlots = Math.max(0, MAX_FOLLOWUP_QUEUE_ROWS - active.length);
        db.items = completedSlots ? [...active, ...completed.slice(-completedSlots)] : active;
        shouldWrite = true;
      }
      if (this.#pruneCompletedFollowups(db)) shouldWrite = true;
      if (!shouldWrite) return;
      await this.#writeJson(this.followupQueuePath, db);
    };
    const pending = this.followupQueueMutation.then(mutate, mutate);
    this.followupQueueMutation = pending.catch(() => {});
    await pending;
    return result;
  }

  async #readJson(filePath, fallback) {
    if (this.adapter) return this.adapter.readJson(filePath, fallback);
    await mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await readFile(filePath, "utf8");
      const cleaned = raw.replace(/^\u0000+|\u0000+$/g, "");
      if (!cleaned.trim()) {
        return structuredClone(fallback);
      }
      return JSON.parse(cleaned);
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(fallback);
      if (filePath === this.followupQueuePath && error instanceof SyntaxError) {
        return structuredClone(fallback);
      }
      throw error;
    }
  }

  async #writeJson(filePath, data) {
    if (this.adapter) return this.adapter.writeJson(filePath, data);
    const write = async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(tempPath, filePath);
    };
    const pending = this.writeQueue.then(write, write);
    this.writeQueue = pending.catch(() => {});
    await pending;
  }

  #pruneCompletedFollowups(db) {
    const before = (db.items || []).length;
    if (!this.completedFollowupRetentionMs) {
      db.items = (db.items || []).filter((item) => !TERMINAL_FOLLOWUP_STATUSES.has(item.status));
      return db.items.length !== before;
    }
    const cutoff = Date.now() - this.completedFollowupRetentionMs;
    db.items = (db.items || []).filter((item) => {
      if (!TERMINAL_FOLLOWUP_STATUSES.has(item.status)) return true;
      const updatedAt = new Date(item.updatedAt || item.availableAt || item.queuedAt || 0).getTime();
      return !Number.isFinite(updatedAt) || updatedAt >= cutoff;
    });
    return db.items.length !== before;
  }
}

function validIsoDate(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function retentionMs(value, fallbackDays) {
  const days = Number(value ?? fallbackDays);
  if (!Number.isFinite(days) || days <= 0) return 0;
  return days * DAY_MS;
}

function belongsToBusiness(item, businessAccountId = "") {
  const itemAccountId = item?.businessAccountId || item?.accountId || "";
  return !businessAccountId || itemAccountId === businessAccountId;
}

function normalizeDashboardProfile(profile = {}) {
  const name = String(profile?.name || "AI Agent Monitor").trim().slice(0, 80) || "AI Agent Monitor";
  const accentColor = /^#[0-9a-fA-F]{6}$/.test(String(profile?.accentColor || ""))
    ? String(profile.accentColor)
    : "#0071e3";
  return { name, accentColor };
}
