import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

export class AdminAccountStore {
  constructor(dataDir, options = {}) {
    this.path = path.join(dataDir, "admin_accounts.json");
    this.adapter = options.adapter || null;
    this.writeQueue = Promise.resolve();
  }

  async ensureInitialAccount({ id, name, password, role = "business_admin" }) {
    const db = await this.#read();
    const existing = db.accounts.find((account) => account.id === id);
    if (existing) {
      if (!existing.role) {
        existing.role = role;
        existing.updatedAt = new Date().toISOString();
        await this.#write(db);
      }
      return;
    }
    const now = new Date().toISOString();
    db.accounts.push({
      id,
      name,
      role,
      active: true,
      automationPaused: false,
      testMode: false,
      passwordHash: await hashPassword(password),
      createdAt: now,
      updatedAt: now,
    });
    await this.#write(db);
  }

  async listAccounts() {
    const db = await this.#read();
    return db.accounts.map(publicAccount);
  }

  async authenticate(id, password, requiredRole = "") {
    const db = await this.#read();
    const account = db.accounts.find((item) => item.id === id);
    const role = account?.role || "business_admin";
    if (
      !account ||
      !account.active ||
      (requiredRole && role !== requiredRole) ||
      !(await verifyPassword(password, account.passwordHash))
    ) {
      return null;
    }
    return publicAccount(account);
  }

  async isActive(id, role = "") {
    const db = await this.#read();
    const account = db.accounts.find((item) => item.id === id);
    return Boolean(account?.active && (!role || (account.role || "business_admin") === role));
  }

  async createAccount({ id, name, password, role = "business_admin" }) {
    validateAccountId(id);
    validatePassword(password);
    validateRole(role);
    const db = await this.#read();
    if (db.accounts.some((account) => account.id === id)) {
      throw new Error("Account ID already exists.");
    }
    const now = new Date().toISOString();
    const account = {
      id,
      name: String(name || id).trim() || id,
      role,
      active: true,
      automationPaused: false,
      testMode: false,
      passwordHash: await hashPassword(password),
      createdAt: now,
      updatedAt: now,
    };
    db.accounts.push(account);
    await this.#write(db);
    return publicAccount(account);
  }

  async resetPassword(id, password) {
    validatePassword(password);
    const db = await this.#read();
    const account = db.accounts.find((item) => item.id === id);
    if (!account) throw new Error("Account not found.");
    account.passwordHash = await hashPassword(password);
    account.updatedAt = new Date().toISOString();
    await this.#write(db);
    return publicAccount(account);
  }

  async setActive(id, active) {
    const db = await this.#read();
    const account = db.accounts.find((item) => item.id === id);
    if (!account) throw new Error("Account not found.");
    account.active = Boolean(active);
    account.updatedAt = new Date().toISOString();
    await this.#write(db);
    return publicAccount(account);
  }

  async getAccount(id) {
    const db = await this.#read();
    const account = db.accounts.find((item) => item.id === id);
    return account ? publicAccount(account) : null;
  }

  async setOperationalControl(id, { automationPaused, testMode }) {
    const db = await this.#read();
    const account = db.accounts.find((item) => item.id === id);
    if (!account) throw new Error("Account not found.");
    if ((account.role || "business_admin") !== "business_admin") {
      throw new Error("Automation controls apply to business admin accounts only.");
    }
    account.automationPaused = Boolean(automationPaused);
    account.testMode = Boolean(testMode);
    account.updatedAt = new Date().toISOString();
    await this.#write(db);
    return publicAccount(account);
  }

  async #read() {
    if (this.adapter) return this.adapter.readJson(this.path, { accounts: [] });
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { accounts: [] };
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

function publicAccount(account) {
  return {
    id: account.id,
    name: account.name,
    role: account.role || "business_admin",
    active: Boolean(account.active),
    automationPaused: Boolean(account.automationPaused),
    testMode: Boolean(account.testMode),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function validateAccountId(id) {
  if (!/^[a-z0-9][a-z0-9_-]{2,49}$/i.test(String(id || ""))) {
    throw new Error("Account ID must be 3-50 letters, numbers, hyphens, or underscores.");
  }
}

function validatePassword(password) {
  if (String(password || "").length < 10) {
    throw new Error("Password must be at least 10 characters.");
  }
}

function validateRole(role) {
  if (!["business_admin", "order_admin"].includes(String(role || ""))) {
    throw new Error("Role must be business admin or order admin.");
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scrypt(String(password), salt, 64);
  return `scrypt$${salt}$${Buffer.from(derived).toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
  const [scheme, salt, hash] = String(storedHash || "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const derived = Buffer.from(await scrypt(String(password), salt, expected.length));
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}
