import path from "node:path";

function normalizePhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function messageText(message = {}) {
  const content = message.message || {};
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
  return jid.endsWith("@s.whatsapp.net");
}

function toCustomerId(jid = "") {
  return normalizePhone(jid.split("@")[0]);
}

function toJid(to) {
  const phone = normalizePhone(to);
  if (!phone) throw new Error(`Invalid WhatsApp Web recipient: ${to}`);
  return `${phone}@s.whatsapp.net`;
}

export class WebWhatsAppTransport {
  constructor({ sessionDir, logger = console } = {}) {
    this.sessionDir = sessionDir;
    this.logger = logger;
    this.sock = null;
    this.status = "disabled";
    this.qr = "";
    this.lastConnectedAt = "";
    this.lastDisconnectedAt = "";
    this.lastError = "";
    this.pairingCode = "";
    this.pairingCodeRequestedAt = "";
    this.started = false;
    this.onMessage = null;
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
    };
  }

  async start({ onMessage }) {
    if (this.started) return;
    this.started = true;
    this.onMessage = onMessage;
    this.status = "starting";
    await this.connect();
  }

  async connect() {
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
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
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
      if (!item?.key || item.key.fromMe) continue;
      const remoteJid = item.key.remoteJid || "";
      if (!isCustomerJid(remoteJid)) continue;
      const text = messageText(item);
      if (!text) continue;
      await this.onMessage({
        id: item.key.id || `web_${Date.now()}`,
        from: toCustomerId(remoteJid),
        text,
        source: {
          transport: "web",
          remoteJid,
          pushName: item.pushName || "",
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
      const url = message.url?.startsWith("http")
        ? message.url
        : `file://${path.resolve(message.url || "")}`;
      const result = await this.sock.sendMessage(jid, {
        image: { url },
        caption: message.caption || "",
      });
      return result?.key?.id || "";
    }
    const body = message.type === "template"
      ? message.body || message.name || ""
      : message.body || message.caption || "";
    const result = await this.sock.sendMessage(jid, { text: body });
    return result?.key?.id || "";
  }
}
