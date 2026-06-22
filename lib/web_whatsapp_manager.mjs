import { existsSync } from "node:fs";
import path from "node:path";
import { WebWhatsAppTransport } from "./web_whatsapp_transport.mjs";

export class WebWhatsAppManager {
  constructor({ sessionRootDir, logger = console } = {}) {
    this.sessionRootDir = sessionRootDir;
    this.logger = logger;
    this.transports = new Map();
    this.onMessage = null;
  }

  async start({ onMessage, accounts = [] } = {}) {
    this.onMessage = onMessage || null;
    for (const account of accounts) {
      if ((account.role || "business_admin") !== "business_admin" || account.active === false) continue;
      await this.ensureTransport(account.id, { autoStart: hasSavedSession(this.sessionRootDir, account.id) });
    }
  }

  async ensureTransport(accountId, { autoStart = false } = {}) {
    const key = normalizeAccountId(accountId);
    let transport = this.transports.get(key);
    if (!transport) {
      transport = new WebWhatsAppTransport({
        sessionDir: path.join(this.sessionRootDir, key),
        logger: prefixedLogger(this.logger, key),
      });
      this.transports.set(key, transport);
    }
    if (autoStart && !transport.started) {
      await transport.start({
        onMessage: async (message) => {
          if (!this.onMessage) return;
          await this.onMessage({
            ...message,
            businessAccountId: key,
            live: true,
          });
        },
      });
    }
    return transport;
  }

  async startAccount(accountId) {
    return this.ensureTransport(accountId, { autoStart: true });
  }

  async send(accountId, to, message) {
    const transport = await this.ensureTransport(accountId, { autoStart: true });
    return transport.send(to, message);
  }

  async requestPairingCode(accountId, phoneNumber) {
    const transport = await this.ensureTransport(accountId, { autoStart: true });
    return transport.requestPairingCode(phoneNumber);
  }

  async disconnect(accountId, options = {}) {
    const transport = await this.ensureTransport(accountId, { autoStart: false });
    return transport.disconnect(options);
  }

  getStatus(accountId) {
    const transport = this.transports.get(normalizeAccountId(accountId));
    if (!transport) {
      return {
        transport: "web",
        accountId: normalizeAccountId(accountId),
        status: "not_initialized",
        qr: "",
        lastConnectedAt: "",
        lastDisconnectedAt: "",
        lastError: "",
        pairingCode: "",
        pairingCodeRequestedAt: "",
        diagnostics: {},
      };
    }
    return {
      accountId: normalizeAccountId(accountId),
      ...transport.getStatus(),
    };
  }

  listStatuses(accountIds = []) {
    return accountIds.map((accountId) => this.getStatus(accountId));
  }
}

function normalizeAccountId(accountId) {
  const value = String(accountId || "").trim();
  if (!value) throw new Error("Account ID is required.");
  return value;
}

function prefixedLogger(logger, accountId) {
  const prefix = `[web:${accountId}]`;
  return {
    log: (...args) => logger.log(prefix, ...args),
    warn: (...args) => logger.warn(prefix, ...args),
    error: (...args) => logger.error(prefix, ...args),
  };
}

function hasSavedSession(sessionRootDir, accountId) {
  return existsSync(path.join(sessionRootDir, normalizeAccountId(accountId)));
}
