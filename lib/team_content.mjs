import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class TeamContentStore {
  constructor(dataDir, options = {}) {
    this.path = path.join(dataDir, "team_content.json");
    this.adapter = options.adapter || null;
    this.writeQueue = Promise.resolve();
  }

  async getContent(accountId, defaults) {
    const db = await this.#read();
    const key = String(accountId || "default");
    if (!db.accounts[key]) {
      db.accounts[key] = cloneContent(defaults);
      db.accounts[key].createdAt = new Date().toISOString();
      db.accounts[key].updatedAt = db.accounts[key].createdAt;
      await this.#write(db);
    }
    return structuredClone(db.accounts[key]);
  }

  async saveContent(accountId, content) {
    const db = await this.#read();
    const key = String(accountId || "default");
    db.accounts[key] = {
      ...cloneContent(content),
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
}

function cloneContent(content = {}) {
  return {
    catalog: structuredClone(content.catalog || { default_product_id: "", products: [] }),
    faqLibrary: structuredClone(content.faqLibrary || { approved_faqs: [] }),
    salesReplyLibrary: structuredClone(content.salesReplyLibrary || { sales_replies: [] }),
  };
}
