import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export class PostgresJsonAdapter {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.connectionString = options.connectionString || process.env.DATABASE_URL || "";
    this.tableName = options.tableName || "json_documents";
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

  async writeJson(filePath, data) {
    await this.ready;
    await this.pool.query(
      `
        INSERT INTO ${this.tableName} (key, value, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      [documentKey(filePath), JSON.stringify(data)]
    );
  }

  async close() {
    await this.ready;
    await this.pool.end();
  }

  async #initialize() {
    const tableNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    if (!tableNamePattern.test(this.tableName)) {
      throw new Error("WHATSAPP_POSTGRES_TABLE must be a simple SQL identifier.");
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
}

function documentKey(filePath) {
  return path.basename(filePath, ".json");
}
