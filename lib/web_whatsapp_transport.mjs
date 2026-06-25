import fs from "node:fs/promises";
import path from "node:path";

function normalizePhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function unwrapMessageContent(content = {}) {
  let current = content;
  for (let index = 0; index < 8 && current; index += 1) {
    if (current.conversation || current.extendedTextMessage || current.imageMessage || current.videoMessage) {
      return current;
    }
    if (current.deviceSentMessage?.message) {
      current = current.deviceSentMessage.message;
      continue;
    }
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }
    if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
      continue;
    }
    if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
      continue;
    }
    if (current.viewOnceMessageV2Extension?.message) {
      current = current.viewOnceMessageV2Extension.message;
      continue;
    }
    if (current.editedMessage?.message) {
      current = current.editedMessage.message;
      continue;
    }
    if (current.protocolMessage?.editedMessage?.message) {
      current = current.protocolMessage.editedMessage.message;
      continue;
    }
    break;
  }
  return current || {};
}

function messageKinds(content = {}) {
  return Object.keys(content || {}).filter(Boolean).join(", ");
}

function messageText(message = {}) {
  const content = unwrapMessageContent(message.message || {});
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    ""
  ).trim();
}

function isCustomerJid(jid = "") {
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
}

function toCustomerId(jid = "") {
  if (jid.endsWith("@lid")) return jid;
  return normalizePhone(jid.split("@")[0]);
}

function toJid(to) {
  if (String(to || "").includes("@")) return String(to);
  const phone = normalizePhone(to);
  if (!phone) throw new Error(`Invalid WhatsApp Web recipient: ${to}`);
  return `${phone}@s.whatsapp.net`;
}

export class WebWhatsAppTransport {
  constructor({ sessionDir, logger = console, processFromMeMessages = false } = {}) {
    this.sessionDir = sessionDir;
    this.logger = logger;
    this.processFromMeMessages = Boolean(processFromMeMessages);
    this.sock = null;
    this.status = "disabled";
    this.qr = "";
    this.lastConnectedAt = "";
    this.lastDisconnectedAt = "";
    this.lastError = "";
    this.pairingCode = "";
    this.pairingCodeRequestedAt = "";
    this.diagnostics = {
      receivedEvents: 0,
      receivedMessages: 0,
      processedMessages: 0,
      ignoredFromMe: 0,
      ignoredNonCustomer: 0,
      ignoredEmptyText: 0,
      lastAt: "",
      lastRemoteJid: "",
      lastCustomerId: "",
      lastTextPreview: "",
      lastMessageKinds: "",
      lastEventType: "",
      lastIgnoreReason: "",
    };
    this.started = false;
    this.onMessage = null;
    this.manualDisconnect = false;
    this.sentMessageIds = new Set();
  }

  getStatus() {
    return {
      transport: "web",
      status: this.status,
      qr: this.qr,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastError: this.lastError,
      pairingCode: this.pairingCode,
      pairingCodeRequestedAt: this.pairingCodeRequestedAt,
      diagnostics: { ...this.diagnostics },
    };
  }

  async start({ onMessage }) {
    if (this.started) return;
    this.started = true;
    this.onMessage = onMessage;
    this.manualDisconnect = false;
    this.status = "starting";
    await this.connect();
  }

  async connect() {
    if (this.manualDisconnect) return;
    try {
      const baileys = await import("@whiskeysockets/baileys");
      const makeWASocket = baileys.default;
      const {
        Browsers,
        DisconnectReason,
        fetchLatestBaileysVersion,
        useMultiFileAuthState,
      } = baileys;
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
      const { version } = await fetchLatestBaileysVersion();
      const browser = Browsers?.ubuntu
        ? Browsers.ubuntu("Chrome")
        : ["Ubuntu", "Chrome", "22.04.4"];
      this.sock = makeWASocket({
        auth: state,
        browser,
        printQRInTerminal: false,
        version,
      });

      this.sock.ev.on("creds.update", saveCreds);
      this.sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          this.qr = qr;
          this.status = "qr_required";
          this.logger.log("WhatsApp Web QR ready. Open /admin/whatsapp-web to scan.");
        }
        if (connection === "open") {
          this.status = "connected";
          this.qr = "";
          this.pairingCode = "";
          this.lastConnectedAt = new Date().toISOString();
          this.lastError = "";
          this.logger.log("WhatsApp Web transport connected.");
        }
        if (connection === "close") {
          this.status = "disconnected";
          this.lastDisconnectedAt = new Date().toISOString();
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = !this.manualDisconnect && statusCode !== DisconnectReason.loggedOut;
          this.lastError = lastDisconnect?.error?.message || `Disconnected (${statusCode || "unknown"})`;
          this.logger.warn(`WhatsApp Web transport disconnected: ${this.lastError}`);
          if (shouldReconnect) {
            setTimeout(() => {
              void this.connect();
            }, 5000);
          }
        }
      });

      this.sock.ev.on("messages.upsert", (event) => {
        this.diagnostics.receivedEvents += 1;
        this.diagnostics.receivedMessages += event.messages?.length || 0;
        this.diagnostics.lastAt = new Date().toISOString();
        this.diagnostics.lastEventType = event.type || "";
        this.logger.log(`WhatsApp Web inbound event: ${event.type || "unknown"} (${event.messages?.length || 0} message(s))`);
        void this.handleMessages(event).catch((error) => {
          this.lastError = error.message;
          this.logger.error("WhatsApp Web inbound handling failed:", error);
        });
      });
    } catch (error) {
      this.status = "error";
      this.lastError = error.message;
      this.logger.error("WhatsApp Web transport failed to start:", error);
      if (error.code === "ERR_MODULE_NOT_FOUND") {
        this.logger.error("Install dependencies first: npm install");
      }
    }
  }

  async disconnect({ reconnect = false } = {}) {
    this.manualDisconnect = true;
    this.started = false;
    this.qr = "";
    this.pairingCode = "";
    try {
      if (this.sock?.logout) {
        await this.sock.logout();
      }
    } catch (error) {
      this.logger.warn(`WhatsApp Web logout warning: ${error.message}`);
    }
    try {
      this.sock?.end?.();
    } catch {
      // Baileys versions differ; logout above is the important part.
    }
    this.sock = null;
    await fs.rm(this.sessionDir, { recursive: true, force: true });
    this.status = "disconnected";
    this.lastDisconnectedAt = new Date().toISOString();
    this.lastError = "Disconnected by admin";
    if (reconnect) {
      this.manualDisconnect = false;
      this.started = true;
      this.status = "starting";
      this.lastError = "";
      await this.connect();
    }
  }

  async requestPairingCode(phoneNumber) {
    const phone = normalizePhone(phoneNumber);
    if (!phone) throw new Error("Phone number is required.");
    if (this.status === "connected") throw new Error("WhatsApp Web is already connected.");
    if (!this.sock || ["disconnected", "error"].includes(this.status)) {
      this.status = "starting";
      await this.connect();
    }
    if (!this.sock) {
      throw new Error("WhatsApp Web socket is not ready yet. Wait a few seconds, then try again.");
    }
    if (!this.sock.requestPairingCode) {
      throw new Error("This WhatsApp Web library version does not support pairing codes.");
    }
    const code = await this.sock.requestPairingCode(phone);
    this.pairingCode = String(code || "");
    this.pairingCodeRequestedAt = new Date().toISOString();
    this.status = "pairing_code_ready";
    return this.pairingCode;
  }

  async handleMessages(event = {}) {
    if (!this.onMessage) return;
    for (const item of event.messages || []) {
      if (!item?.key) {
        this.diagnostics.lastIgnoreReason = "missing_key";
        continue;
      }
      if (item.key.fromMe && this.sentMessageIds.has(item.key.id)) {
        this.diagnostics.ignoredFromMe += 1;
        this.diagnostics.lastIgnoreReason = "from_me_bot_echo";
        continue;
      }
      if (item.key.fromMe && !this.processFromMeMessages) {
        this.diagnostics.ignoredFromMe += 1;
        this.diagnostics.lastIgnoreReason = "from_me";
        continue;
      }
      const remoteJid = item.key.remoteJid || "";
      this.diagnostics.lastRemoteJid = remoteJid;
      this.diagnostics.lastMessageKinds = messageKinds(unwrapMessageContent(item.message || {}));
      if (!isCustomerJid(remoteJid)) {
        this.diagnostics.ignoredNonCustomer += 1;
        this.diagnostics.lastIgnoreReason = "non_customer_jid";
        continue;
      }
      const text = messageText(item);
      if (!text) {
        this.diagnostics.ignoredEmptyText += 1;
        this.diagnostics.lastIgnoreReason = "empty_text";
        continue;
      }
      this.diagnostics.lastCustomerId = toCustomerId(remoteJid);
      this.diagnostics.lastTextPreview = text.slice(0, 120);
      this.diagnostics.lastIgnoreReason = "";
      this.diagnostics.processedMessages += 1;
      await this.onMessage({
        id: item.key.id || `web_${Date.now()}`,
        from: toCustomerId(remoteJid),
        text,
        source: {
          transport: "web",
          remoteJid,
          pushName: item.pushName || "",
          fromMe: Boolean(item.key.fromMe),
        },
      });
    }
  }

  async send(to, message = {}) {
    if (!this.sock || this.status !== "connected") {
      throw new Error(`WhatsApp Web transport is not connected (${this.status})`);
    }
    const jid = toJid(to);
    if (message.type === "image") {
      const source = String(message.url || "");
      const absolutePath = path.resolve(source);
      const image =
        /^https?:\/\//i.test(source)
          ? { url: source }
          : await fs.readFile(absolutePath);
      const result = await this.sock.sendMessage(jid, { image, caption: message.caption || "" });
      return this.rememberSentMessageId(result?.key?.id);
    }
    const body = message.type === "template"
      ? message.body || message.name || ""
      : message.body || message.caption || "";
    const result = await this.sock.sendMessage(jid, { text: body });
    return this.rememberSentMessageId(result?.key?.id);
  }

  rememberSentMessageId(messageId) {
    const id = String(messageId || "");
    if (!id) return "";
    this.sentMessageIds.add(id);
    if (this.sentMessageIds.size > 5000) {
      const first = this.sentMessageIds.values().next().value;
      this.sentMessageIds.delete(first);
    }
    return id;
  }
}
