import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class SqliteJsonAdapter {
  constructor(dataDir, filename = "agent.sqlite") {
    this.dataDir = dataDir;
    this.databasePath = path.join(dataDir, filename);
    this.ready = this.#initialize();
  }

  async readJson(filePath, fallback) {
    await this.ready;
    const key = documentKey(filePath);
    const row = this.selectDocument.get(key);
    if (row) return JSON.parse(row.value);

    const imported = await this.#importExistingJsonFile(filePath, fallback);
    await this.writeJson(filePath, imported);
    return structuredClone(imported);
  }

  async writeJson(filePath, data) {
    await this.ready;
    this.upsertDocument.run(documentKey(filePath), JSON.stringify(data), new Date().toISOString());
  }

  async close() {
    await this.ready;
    this.db.close();
  }

  async #initialize() {
    await mkdir(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS json_documents (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.selectDocument = this.db.prepare("SELECT value FROM json_documents WHERE key = ?");
    this.upsertDocument = this.db.prepare(`
      INSERT INTO json_documents (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
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
