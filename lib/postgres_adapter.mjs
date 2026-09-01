import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_WRITE_LOG_BYTES = 1024 * 1024;

export class PostgresJsonAdapter {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.connectionString = options.connectionString || process.env.DATABASE_URL || "";
    this.tableName = options.tableName || "json_documents";
    this.followupQueueTableEnabled = parseBool(options.followupQueueTableEnabled ?? process.env.WHATSAPP_FOLLOWUP_QUEUE_TABLE_ENABLED);
    this.followupQueueTableName = options.followupQueueTableName || process.env.WHATSAPP_FOLLOWUP_QUEUE_TABLE || "followup_dispatch_queue_rows";
    this.writeLogBytes = Number(options.writeLogBytes || process.env.WHATSAPP_POSTGRES_WRITE_LOG_BYTES || DEFAULT_WRITE_LOG_BYTES)
      || DEFAULT_WRITE_LOG_BYTES;
    if (!this.connectionString) {
      throw new Error("DATABASE_URL or WHATSAPP_POSTGRES_URL is required when WHATSAPP_STORE=postgres.");
    }
    this.ready = this.#initialize();
  }

  async readJson(filePath, fallback) {
    await this.ready;
    const key = documentKey(filePath);
    const result = await this.pool.query(`SELECT value FROM ${this.tableName} WHERE key = $1`, [key]);
    if (result.rows[0]) return result.rows[0].value;

    const imported = await this.#importExistingJsonFile(filePath, fallback);
    await this.writeJson(filePath, imported);
    return structuredClone(imported);
  }

  async readJsonIfExists(filePath) {
    await this.ready;
    const key = documentKey(filePath);
    const result = await this.pool.query(`SELECT value FROM ${this.tableName} WHERE key = $1`, [key]);
    return result.rows[0] ? result.rows[0].value : null;
  }

  async writeJson(filePath, data) {
    await this.ready;
    const key = documentKey(filePath);
    const payload = JSON.stringify(data);
    this.#logLargeWrite(key, payload);
    await this.pool.query(
      `
        INSERT INTO ${this.tableName} (key, value, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      [key, payload]
    );
  }

  async close() {
    await this.ready;
    await this.pool.end();
  }

  async enqueueFollowupDispatches(items = [], queuedAt = new Date()) {
    await this.ready;
    if (!this.followupQueueTableEnabled || !items.length) return [];
    const saved = [];
    for (const item of items) {
      if (!item?.customerId || !item?.followupKey) continue;
      const dueAt = validIsoDate(item.dueAt || item.availableAt) || queuedAt.toISOString();
      const dispatchKey = [
        item.businessAccountId || "",
        item.customerId || "",
        item.followupKey || "",
      ].join(":");
      const id = `followup_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
      const result = await this.pool.query(
        `
          INSERT INTO ${this.followupQueueTableName} (
            id, dispatch_key, business_account_id, customer_id, product_id, label_display,
            followup_key, message, messages, status, attempts, queued_at, due_at,
            available_at, updated_at, last_error, payload
          )
          VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9::jsonb, 'queued', 0, $10::timestamptz, $11::timestamptz,
            $11::timestamptz, $10::timestamptz, '', '{}'::jsonb
          )
          ON CONFLICT (dispatch_key) DO UPDATE SET
            status = 'queued',
            due_at = excluded.due_at,
            available_at = excluded.available_at,
            updated_at = excluded.updated_at,
            last_error = '',
            message = excluded.message,
            messages = excluded.messages
          WHERE ${this.followupQueueTableName}.status IN ('held_template', 'cancelled')
          RETURNING *
        `,
        [
          id,
          dispatchKey,
          String(item.businessAccountId || ""),
          String(item.customerId),
          String(item.productId || ""),
          String(item.labelDisplay || ""),
          String(item.followupKey),
          String(item.message || ""),
          JSON.stringify(Array.isArray(item.messages) ? item.messages : []),
          queuedAt.toISOString(),
          dueAt,
        ]
      );
      const row = result.rows[0];
      if (row) saved.push(followupRowFromSql(row));
    }
    return saved;
  }

  async claimFollowupDispatchBatches(accountLimits = [], now = new Date()) {
    await this.ready;
    if (!this.followupQueueTableEnabled) return [];
    const staleBefore = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    await this.pool.query(
      `
        UPDATE ${this.followupQueueTableName}
        SET status = 'retry_pending',
            available_at = $1::timestamptz,
            updated_at = $1::timestamptz,
            last_error = 'Dispatch worker stopped before completion; retrying.'
        WHERE status = 'processing'
          AND updated_at <= $2::timestamptz
      `,
      [now.toISOString(), staleBefore]
    );
    const claimed = [];
    for (const entry of accountLimits) {
      const limit = Math.max(1, Number(entry?.limit) || 1);
      const accountId = String(entry?.businessAccountId || "");
      const result = await this.pool.query(
        `
          WITH picked AS (
            SELECT id
            FROM ${this.followupQueueTableName}
            WHERE status IN ('queued', 'retry_pending')
              AND business_account_id = $1
              AND COALESCE(available_at, queued_at) <= $2::timestamptz
            ORDER BY COALESCE(available_at, due_at, queued_at), queued_at
            LIMIT $3
            FOR UPDATE SKIP LOCKED
          )
          UPDATE ${this.followupQueueTableName} q
          SET status = 'processing',
              attempts = attempts + 1,
              updated_at = $2::timestamptz
          FROM picked
          WHERE q.id = picked.id
          RETURNING q.*
        `,
        [accountId, now.toISOString(), limit]
      );
      claimed.push(...result.rows.map(followupRowFromSql));
    }
    return claimed;
  }

  async updateFollowupDispatch(id, patch = {}) {
    const [item] = await this.updateFollowupDispatches([{ id, patch }]);
    if (!item) throw new Error("Follow-up queue item not found.");
    return item;
  }

  async updateFollowupDispatches(updates = []) {
    await this.ready;
    if (!this.followupQueueTableEnabled || !updates.length) return [];
    const saved = [];
    for (const { id, patch } of updates) {
      const existingResult = await this.pool.query(`SELECT * FROM ${this.followupQueueTableName} WHERE id = $1`, [id]);
      const existing = existingResult.rows[0];
      if (!existing) continue;
      const existingItem = followupRowFromSql(existing);
      const changed = Object.entries(patch || {}).some(([key, value]) =>
        JSON.stringify(existingItem[key]) !== JSON.stringify(value)
      );
      if (!changed) {
        saved.push(existingItem);
        continue;
      }
      const next = { ...existingItem, ...structuredClone(patch), updatedAt: new Date().toISOString() };
      const result = await this.pool.query(
        `
          UPDATE ${this.followupQueueTableName}
          SET product_id = $2,
              label_display = $3,
              message = $4,
              messages = $5::jsonb,
              status = $6,
              attempts = $7,
              due_at = $8::timestamptz,
              available_at = $9::timestamptz,
              updated_at = $10::timestamptz,
              sent_at = $11::timestamptz,
              last_error = $12,
              payload = $13::jsonb
          WHERE id = $1
          RETURNING *
        `,
        [
          id,
          next.productId || "",
          next.labelDisplay || "",
          next.message || "",
          JSON.stringify(Array.isArray(next.messages) ? next.messages : []),
          next.status || "queued",
          Math.max(0, Number(next.attempts) || 0),
          nullableIso(next.dueAt),
          nullableIso(next.availableAt),
          nullableIso(next.updatedAt) || new Date().toISOString(),
          nullableIso(next.sentAt),
          next.lastError || "",
          JSON.stringify(extraFollowupPayload(next)),
        ]
      );
      saved.push(followupRowFromSql(result.rows[0]));
    }
    return saved;
  }

  async listFollowupDispatches(businessAccountId = "") {
    await this.ready;
    if (!this.followupQueueTableEnabled) return [];
    const params = [];
    let where = "";
    if (businessAccountId) {
      params.push(String(businessAccountId));
      where = "WHERE business_account_id = $1";
    }
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.followupQueueTableName}
        ${where}
        ORDER BY updated_at DESC, queued_at DESC
      `,
      params
    );
    return result.rows.map(followupRowFromSql);
  }

  async importFollowupDispatches(items = [], { overwrite = false } = {}) {
    await this.ready;
    if (!this.followupQueueTableEnabled || !items.length) return 0;
    if (overwrite) await this.pool.query(`TRUNCATE ${this.followupQueueTableName}`);
    let count = 0;
    for (const item of items) {
      if (!item?.id || !item?.customerId || !item?.followupKey) continue;
      const dispatchKey = item.dispatchKey || [item.businessAccountId || "", item.customerId || "", item.followupKey || ""].join(":");
      const result = await this.pool.query(
        `
          INSERT INTO ${this.followupQueueTableName} (
            id, dispatch_key, business_account_id, customer_id, product_id, label_display,
            followup_key, message, messages, status, attempts, queued_at, due_at,
            available_at, updated_at, sent_at, last_error, payload
          )
          VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9::jsonb, $10, $11, $12::timestamptz, $13::timestamptz,
            $14::timestamptz, $15::timestamptz, $16::timestamptz, $17, $18::jsonb
          )
          ON CONFLICT (dispatch_key) DO NOTHING
        `,
        [
          String(item.id),
          String(dispatchKey),
          String(item.businessAccountId || ""),
          String(item.customerId || ""),
          String(item.productId || ""),
          String(item.labelDisplay || ""),
          String(item.followupKey || ""),
          String(item.message || ""),
          JSON.stringify(Array.isArray(item.messages) ? item.messages : []),
          String(item.status || "queued"),
          Math.max(0, Number(item.attempts) || 0),
          nullableIso(item.queuedAt) || new Date().toISOString(),
          nullableIso(item.dueAt),
          nullableIso(item.availableAt) || nullableIso(item.dueAt) || nullableIso(item.queuedAt) || new Date().toISOString(),
          nullableIso(item.updatedAt) || new Date().toISOString(),
          nullableIso(item.sentAt),
          String(item.lastError || ""),
          JSON.stringify(extraFollowupPayload(item)),
        ]
      );
      count += result.rowCount || 0;
    }
    return count;
  }

  async pruneFollowupDispatches(retentionMs = 0) {
    await this.ready;
    if (!this.followupQueueTableEnabled) return 0;
    if (!retentionMs) {
      const result = await this.pool.query(
        `DELETE FROM ${this.followupQueueTableName} WHERE status IN ('sent', 'cancelled', 'held_template')`
      );
      return result.rowCount || 0;
    }
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    const result = await this.pool.query(
      `
        DELETE FROM ${this.followupQueueTableName}
        WHERE status IN ('sent', 'cancelled', 'held_template')
          AND COALESCE(updated_at, available_at, queued_at) < $1::timestamptz
      `,
      [cutoff]
    );
    return result.rowCount || 0;
  }

  async #initialize() {
    const tableNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    if (!tableNamePattern.test(this.tableName)) {
      throw new Error("WHATSAPP_POSTGRES_TABLE must be a simple SQL identifier.");
    }
    if (!tableNamePattern.test(this.followupQueueTableName)) {
      throw new Error("WHATSAPP_FOLLOWUP_QUEUE_TABLE must be a simple SQL identifier.");
    }
    await mkdir(this.dataDir, { recursive: true });
    const { Pool } = await import("pg");
    this.pool = new Pool({ connectionString: this.connectionString });
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    if (this.followupQueueTableEnabled) {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS ${this.followupQueueTableName} (
          id TEXT PRIMARY KEY,
          dispatch_key TEXT NOT NULL UNIQUE,
          business_account_id TEXT NOT NULL DEFAULT '',
          customer_id TEXT NOT NULL,
          product_id TEXT NOT NULL DEFAULT '',
          label_display TEXT NOT NULL DEFAULT '',
          followup_key TEXT NOT NULL,
          message TEXT NOT NULL DEFAULT '',
          messages JSONB NOT NULL DEFAULT '[]'::jsonb,
          status TEXT NOT NULL DEFAULT 'queued',
          attempts INTEGER NOT NULL DEFAULT 0,
          queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          due_at TIMESTAMPTZ,
          available_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          sent_at TIMESTAMPTZ,
          last_error TEXT NOT NULL DEFAULT '',
          payload JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `);
      await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.followupQueueTableName}_claim_idx ON ${this.followupQueueTableName} (business_account_id, status, available_at, queued_at)`);
      await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.followupQueueTableName}_customer_idx ON ${this.followupQueueTableName} (business_account_id, customer_id)`);
      await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.followupQueueTableName}_updated_idx ON ${this.followupQueueTableName} (updated_at)`);
    }
  }

  async #importExistingJsonFile(filePath, fallback) {
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw.replace(/\u0000+$/g, ""));
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(fallback);
      throw error;
    }
  }

  #logLargeWrite(key, payload) {
    const bytes = Buffer.byteLength(payload || "", "utf8");
    if (bytes < this.writeLogBytes) return;
    console.warn(`[postgres-json] large write key=${key} size=${formatBytes(bytes)}`);
  }
}

function documentKey(filePath) {
  return path.basename(filePath, ".json");
}

function parseBool(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function validIsoDate(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function nullableIso(value) {
  return validIsoDate(value) || null;
}

function isoFromSql(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function followupRowFromSql(row = {}) {
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : {};
  return {
    ...structuredClone(payload),
    id: row.id || "",
    dispatchKey: row.dispatch_key || "",
    businessAccountId: row.business_account_id || "",
    customerId: row.customer_id || "",
    productId: row.product_id || "",
    labelDisplay: row.label_display || "",
    followupKey: row.followup_key || "",
    message: row.message || "",
    messages: Array.isArray(row.messages) ? structuredClone(row.messages) : [],
    status: row.status || "queued",
    attempts: Number(row.attempts || 0),
    queuedAt: isoFromSql(row.queued_at),
    dueAt: isoFromSql(row.due_at),
    availableAt: isoFromSql(row.available_at),
    updatedAt: isoFromSql(row.updated_at),
    sentAt: isoFromSql(row.sent_at),
    lastError: row.last_error || "",
  };
}

function extraFollowupPayload(item = {}) {
  const reserved = new Set([
    "id",
    "dispatchKey",
    "businessAccountId",
    "customerId",
    "productId",
    "labelDisplay",
    "followupKey",
    "message",
    "messages",
    "status",
    "attempts",
    "queuedAt",
    "dueAt",
    "availableAt",
    "updatedAt",
    "sentAt",
    "lastError",
  ]);
  return Object.fromEntries(Object.entries(item).filter(([key]) => !reserved.has(key)));
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} bytes`;
}
