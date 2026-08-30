import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class TeamContentStore {
  constructor(dataDir, options = {}) {
    this.path = path.join(dataDir, "team_content.json");
    this.adapter = options.adapter || null;
    this.writeQueue = Promise.resolve();
  }

  async getContent(accountId, defaults) {
    if (this.adapter?.readJsonIfExists) {
      return this.#getAdapterContent(accountId, defaults);
    }
    const db = await this.#read();
    const key = String(accountId || "default");
    if (!db.accounts[key]) {
      db.accounts[key] = cloneContent(defaults);
      db.accounts[key].createdAt = new Date().toISOString();
      db.accounts[key].updatedAt = db.accounts[key].createdAt;
      await this.#write(db);
    }
    const content = cloneContent(db.accounts[key]);
    const compacted = compactTeamContent(content);
    if (compacted.changed) {
      db.accounts[key] = {
        ...content,
        updatedAt: new Date().toISOString(),
        createdAt: db.accounts[key]?.createdAt || new Date().toISOString(),
      };
      await this.#write(db);
    }
    return structuredClone(content);
  }

  async saveContent(accountId, content) {
    if (this.adapter?.readJsonIfExists) {
      return this.#saveAdapterContent(accountId, content);
    }
    const db = await this.#read();
    const key = String(accountId || "default");
    const compactedContent = cloneContent(content);
    compactTeamContent(compactedContent);
    db.accounts[key] = {
      ...compactedContent,
      updatedAt: new Date().toISOString(),
      createdAt: db.accounts[key]?.createdAt || new Date().toISOString(),
    };
    await this.#write(db);
    return structuredClone(db.accounts[key]);
  }

  async #read() {
    if (this.adapter) return this.adapter.readJson(this.path, { accounts: {} });
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { accounts: {} };
      throw error;
    }
  }

  async #write(data) {
    if (this.adapter) return this.adapter.writeJson(this.path, data);
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.path);
    });
    await this.writeQueue;
  }

  async #getAdapterContent(accountId, defaults) {
    const key = String(accountId || "default");
    const accountPath = this.#accountPath(key);
    const existing = await this.adapter.readJsonIfExists(accountPath);
    if (existing) {
      const content = cloneContent(existing);
      const compacted = compactTeamContent(content);
      if (compacted.changed) {
        await this.adapter.writeJson(accountPath, {
          ...content,
          updatedAt: new Date().toISOString(),
          createdAt: existing?.createdAt || new Date().toISOString(),
        });
      }
      return structuredClone(content);
    }

    const legacy = await this.adapter.readJsonIfExists(this.path);
    const migrated = legacy?.accounts?.[key];
    if (migrated) {
      const content = cloneContent(migrated);
      compactTeamContent(content);
      await this.adapter.writeJson(accountPath, {
        ...content,
        updatedAt: new Date().toISOString(),
        createdAt: migrated?.createdAt || new Date().toISOString(),
      });
      return structuredClone(content);
    }

    const seeded = cloneContent(defaults);
    seeded.createdAt = new Date().toISOString();
    seeded.updatedAt = seeded.createdAt;
    await this.adapter.writeJson(accountPath, seeded);
    return structuredClone(seeded);
  }

  async #saveAdapterContent(accountId, content) {
    const key = String(accountId || "default");
    const accountPath = this.#accountPath(key);
    const existing = await this.adapter.readJsonIfExists(accountPath);
    const now = new Date().toISOString();
    const compactedContent = cloneContent(content);
    compactTeamContent(compactedContent);
    const saved = {
      ...compactedContent,
      updatedAt: now,
      createdAt: existing?.createdAt || content?.createdAt || now,
    };
    await this.adapter.writeJson(accountPath, saved);
    return structuredClone(saved);
  }

  #accountPath(accountId) {
    return path.join(path.dirname(this.path), `${teamContentDocumentName(accountId)}.json`);
  }
}

function cloneContent(content = {}) {
  return {
    catalog: structuredClone(content.catalog || { default_product_id: "", products: [] }),
    faqLibrary: structuredClone(content.faqLibrary || { approved_faqs: [] }),
    salesReplyLibrary: structuredClone(content.salesReplyLibrary || { sales_replies: [] }),
    followupSettings: structuredClone(content.followupSettings || {}),
    ...(content.createdAt ? { createdAt: String(content.createdAt) } : {}),
    ...(content.updatedAt ? { updatedAt: String(content.updatedAt) } : {}),
  };
}

export function compactTeamContent(content = {}) {
  const result = { changed: false, removedExtractionResults: 0, removedInlineMediaDataUrls: 0 };
  for (const product of content?.catalog?.products || []) {
    const extraction = product?.extracted_knowledge?.lastExtraction;
    if (extraction && typeof extraction === "object" && Array.isArray(extraction.results)) {
      delete extraction.results;
      result.changed = true;
      result.removedExtractionResults += 1;
    }
    for (const image of Object.values(product?.persisted_images || {})) {
      if (!image?.mediaKey || typeof image.dataUrl !== "string") continue;
      delete image.dataUrl;
      result.changed = true;
      result.removedInlineMediaDataUrls += 1;
    }
  }
  return result;
}

function teamContentDocumentName(accountId) {
  const safe = String(accountId || "default")
    .replace(/[^a-z0-9_-]+/gi, "_")
    .replace(/^_+|_+$/g, "");
  return `team_content_${safe || "default"}`;
}
