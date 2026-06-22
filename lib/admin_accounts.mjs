import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

export class AdminAccountStore {
  constructor(dataDir, options = {}) {
    this.path = path.join(dataDir, "admin_accounts.json");
    this.adapter = options.adapter || null;
    this.encryptionSecret = String(options.encryptionSecret || process.env.ADMIN_SESSION_SECRET || "local_team_settings_secret");
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
      settings: {},
      passwordHash: await hashPassword(password),
      createdAt: now,
      updatedAt: now,
    });
    await this.#write(db);
  }

  async listAccounts() {
    const db = await this.#read();
    return db.accounts.map((account) => publicAccount(account, this.encryptionSecret));
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
    return publicAccount(account, this.encryptionSecret);
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
      settings: {},
      passwordHash: await hashPassword(password),
      createdAt: now,
      updatedAt: now,
    };
    db.accounts.push(account);
    await this.#write(db);
    return publicAccount(account, this.encryptionSecret);
  }

  async resetPassword(id, password) {
    validatePassword(password);
    const db = await this.#read();
    const account = db.accounts.find((item) => item.id === id);
    if (!account) throw new Error("Account not found.");
    account.passwordHash = await hashPassword(password);
    account.updatedAt = new Date().toISOString();
    await this.#write(db);
    return publicAccount(account, this.encryptionSecret);
  }

  async setActive(id, active) {
    const db = await this.#read();
    const account = db.accounts.find((item) => item.id === id);
    if (!account) throw new Error("Account not found.");
    account.active = Boolean(active);
    account.updatedAt = new Date().toISOString();
    await this.#write(db);
    return publicAccount(account, this.encryptionSecret);
  }

  async getAccount(id) {
    const db = await this.#read();
    const account = db.accounts.find((item) => item.id === id);
    return account ? publicAccount(account, this.encryptionSecret) : null;
  }

  async getTeamSettings(id) {
    const db = await this.#read();
    const account = db.accounts.find((item) => item.id === id);
    return account ? privateTeamSettings(account.settings || {}, this.encryptionSecret) : {};
  }

  async findBusinessAccountByPhoneNumberId(phoneNumberId) {
    const id = String(phoneNumberId || "").trim();
    if (!id) return null;
    const db = await this.#read();
    const account = db.accounts.find(
      (item) =>
        (item.role || "business_admin") === "business_admin" &&
        item.active &&
        String(item.settings?.whatsappPhoneNumberId || "") === id
    );
    return account ? publicAccount(account, this.encryptionSecret) : null;
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
    return publicAccount(account, this.encryptionSecret);
  }

  async updateTeamSettings(id, settings = {}) {
    const db = await this.#read();
    const account = db.accounts.find((item) => item.id === id);
    if (!account) throw new Error("Account not found.");
    if ((account.role || "business_admin") !== "business_admin") {
      throw new Error("Team settings apply to business admin accounts only.");
    }
    account.settings = {
      ...(account.settings || {}),
      ...sanitizeTeamSettings(settings, this.encryptionSecret),
    };
    account.updatedAt = new Date().toISOString();
    await this.#write(db);
    return publicAccount(account, this.encryptionSecret);
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

function publicAccount(account, encryptionSecret = "") {
  return {
    id: account.id,
    name: account.name,
    role: account.role || "business_admin",
    active: Boolean(account.active),
    automationPaused: Boolean(account.automationPaused),
    testMode: Boolean(account.testMode),
    settings: publicTeamSettings(account.settings || {}, encryptionSecret),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function sanitizeTeamSettings(settings = {}, encryptionSecret = "") {
  const safe = {};
  if ("publicBaseUrl" in settings) safe.publicBaseUrl = cleanUrl(settings.publicBaseUrl);
  if ("assetsBaseUrl" in settings) safe.assetsBaseUrl = cleanUrl(settings.assetsBaseUrl);
  if ("whatsappPhoneNumberId" in settings) safe.whatsappPhoneNumberId = cleanText(settings.whatsappPhoneNumberId, 80);
  if ("whatsappAccessToken" in settings) {
    const token = cleanText(settings.whatsappAccessToken, 1000);
    safe.whatsappAccessToken = token ? encryptSecret(token, encryptionSecret) : "";
  }
  if ("openaiVectorStoreId" in settings) safe.openaiVectorStoreId = cleanText(settings.openaiVectorStoreId, 120);
  if ("followupSendsPerMinute" in settings) {
    safe.followupSendsPerMinute = clampInteger(settings.followupSendsPerMinute, 1, 100);
  }
  if ("followupIntervalMinutes" in settings) {
    safe.followupIntervalMinutes = clampInteger(settings.followupIntervalMinutes, 1, 1440);
  }
  return safe;
}

function publicTeamSettings(settings = {}, encryptionSecret = "") {
  const privateSettings = privateTeamSettings(settings, encryptionSecret);
  return {
    publicBaseUrl: String(privateSettings.publicBaseUrl || ""),
    assetsBaseUrl: String(privateSettings.assetsBaseUrl || ""),
    whatsappPhoneNumberId: maskSecret(privateSettings.whatsappPhoneNumberId || ""),
    whatsappAccessToken: maskSecret(privateSettings.whatsappAccessToken || ""),
    openaiVectorStoreId: String(privateSettings.openaiVectorStoreId || ""),
    followupSendsPerMinute: Number(privateSettings.followupSendsPerMinute || 0) || "",
    followupIntervalMinutes: Number(privateSettings.followupIntervalMinutes || 0) || "",
  };
}

function privateTeamSettings(settings = {}, encryptionSecret = "") {
  return {
    ...settings,
    whatsappAccessToken: decryptSecret(settings.whatsappAccessToken || "", encryptionSecret),
  };
}

function cleanUrl(value) {
  const text = cleanText(value, 300);
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!["https:", "http:"].includes(url.protocol)) return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function clampInteger(value, min, max) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return min;
  return Math.min(Math.max(number, min), max);
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 6) return "******";
  return `${text.slice(0, 3)}...${text.slice(-3)}`;
}

function encryptionKey(secret) {
  return crypto.createHash("sha256").update(String(secret || "local_team_settings_secret")).digest();
}

function encryptSecret(value, secret) {
  const text = String(value || "");
  if (!text || text.startsWith("enc:v1:")) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decryptSecret(value, secret) {
  const text = String(value || "");
  if (!text.startsWith("enc:v1:")) return text;
  try {
    const [, , ivRaw, tagRaw, encryptedRaw] = text.split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return "";
  }
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
