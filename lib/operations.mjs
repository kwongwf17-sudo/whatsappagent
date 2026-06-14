import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_LOG_ROWS = 300;
const MAX_FOLLOWUP_QUEUE_ROWS = 20000;
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
    });
  }

  async updateDashboardProfile({ name, accentColor }) {
    const existing = await this.getState();
    const profile = {
      name: String(name || "AI Agent Monitor").trim().slice(0, 80) || "AI Agent Monitor",
      accentColor: /^#[0-9a-fA-F]{6}$/.test(String(accentColor || "")) ? String(accentColor) : "#0071e3",
    };
    const state = {
      ...existing,
      dashboardProfile: profile,
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

  async listErrors() {
    const db = await this.#readJson(this.errorsPath, { errors: [] });
    return [...db.errors].reverse();
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

  async listFailedMessages() {
    const db = await this.#readJson(this.failedMessagesPath, { messages: [] });
    return [...db.messages].reverse();
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

  async listNoReplyReviews() {
    const db = await this.#readJson(this.noReplyReviewsPath, { reviews: [] });
    return [...db.reviews].reverse();
  }

  async enqueueFollowups(items = [], queuedAt = new Date()) {
    if (!items.length) return [];
    return this.#mutateFollowupQueue((db) => {
      const known = new Map(db.items.map((item) => [item.dispatchKey, item]));
      const saved = [];
      for (const item of items) {
        const dispatchKey = [
          item.businessAccountId || "",
          item.customerId || "",
          item.followupKey || "",
        ].join(":");
        if (!item.customerId || !item.followupKey) continue;
        const existing = known.get(dispatchKey);
        if (existing) {
          if (existing.status === "held_template") {
            existing.status = "queued";
            existing.availableAt = queuedAt.toISOString();
            existing.updatedAt = queuedAt.toISOString();
            existing.lastError = "";
            existing.message = String(item.message || existing.message || "");
            saved.push(structuredClone(existing));
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
          status: "queued",
          attempts: 0,
          queuedAt: queuedAt.toISOString(),
          availableAt: queuedAt.toISOString(),
          updatedAt: queuedAt.toISOString(),
          lastError: "",
        };
        db.items.push(entry);
        known.set(dispatchKey, entry);
        saved.push(entry);
      }
      return saved;
    });
  }

  async claimFollowupBatch(limit = 1, now = new Date()) {
    const safeLimit = Math.max(1, Number(limit) || 1);
    const staleBefore = now.getTime() - 5 * 60 * 1000;
    return this.#mutateFollowupQueue((db) => {
      for (const item of db.items) {
        if (item.status === "processing" && new Date(item.updatedAt || 0).getTime() <= staleBefore) {
          item.status = "retry_pending";
          item.availableAt = now.toISOString();
          item.lastError = "Dispatch worker stopped before completion; retrying.";
        }
      }
      const batch = db.items
        .filter((item) => {
          if (!["queued", "retry_pending"].includes(item.status)) return false;
          return new Date(item.availableAt || item.queuedAt || 0).getTime() <= now.getTime();
        })
        .sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)))
        .slice(0, safeLimit);
      for (const item of batch) {
        item.status = "processing";
        item.attempts = Number(item.attempts || 0) + 1;
        item.updatedAt = now.toISOString();
      }
      return structuredClone(batch);
    });
  }

  async updateFollowupDispatch(id, patch = {}) {
    return this.#mutateFollowupQueue((db) => {
      const item = db.items.find((entry) => entry.id === id);
      if (!item) throw new Error("Follow-up queue item not found.");
      Object.assign(item, structuredClone(patch), { updatedAt: new Date().toISOString() });
      return structuredClone(item);
    });
  }

  async listFollowupQueue() {
    const db = await this.#readJson(this.followupQueuePath, { items: [] });
    return [...db.items].reverse();
  }

  async #mutateFollowupQueue(mutator) {
    let result;
    const mutate = async () => {
      const db = await this.#readJson(this.followupQueuePath, { items: [] });
      result = mutator(db);
      if (db.items.length > MAX_FOLLOWUP_QUEUE_ROWS) {
        const active = db.items.filter((item) => !TERMINAL_FOLLOWUP_STATUSES.has(item.status));
        const completed = db.items.filter((item) => TERMINAL_FOLLOWUP_STATUSES.has(item.status));
        const completedSlots = Math.max(0, MAX_FOLLOWUP_QUEUE_ROWS - active.length);
        db.items = completedSlots ? [...active, ...completed.slice(-completedSlots)] : active;
      }
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
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(fallback);
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
}
