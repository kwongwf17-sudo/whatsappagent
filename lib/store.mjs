import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_ORDER_STATUS_REPLIES, isAllowedOrderStatus } from "./order_tracking.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_FOLLOWUP_KEY = "first_day_followup";
const BUSINESS_TIME_ZONE = process.env.BUSINESS_TIME_ZONE || "Asia/Kuala_Lumpur";
const DEFAULT_OUTBOX_RETENTION_DAYS = 5;
const DEFAULT_PROCESSED_MESSAGE_RETENTION_DAYS = 5;
const DEFAULT_AUDIT_LOG_MAX_ROWS = 200;

export class JsonStore {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.adapter = options.adapter || null;
    this.customersPath = path.join(dataDir, "customers.json");
    this.deletedCustomersPath = path.join(dataDir, "deleted_customers.json");
    this.ordersPath = path.join(dataDir, "orders.json");
    this.orderStatusRepliesPath = path.join(dataDir, "order_status_replies.json");
    this.complaintsPath = path.join(dataDir, "complaint_cases.json");
    this.outboxPath = path.join(dataDir, "outbox.json");
    this.auditPath = path.join(dataDir, "audit_log.json");
    this.processedMessagesPath = path.join(dataDir, "processed_messages.json");
    this.pendingBuffersPath = path.join(dataDir, "pending_buffers.json");
    this.outboxRetentionMs = retentionMs(options.outboxRetentionDays, DEFAULT_OUTBOX_RETENTION_DAYS);
    this.processedMessageRetentionMs = retentionMs(options.processedMessageRetentionDays, DEFAULT_PROCESSED_MESSAGE_RETENTION_DAYS);
    this.auditLogMaxRows = Math.max(0, Number(options.auditLogMaxRows ?? DEFAULT_AUDIT_LOG_MAX_ROWS) || 0);
    this.writeQueue = Promise.resolve();
  }

  async getOrCreateCustomer(customerId, patch = {}) {
    return this.#withWriteQueue(async () => {
      const db = await this.#readJson(this.customersPath, { customers: {} });
      const now = new Date().toISOString();
      const businessAccountId = String(patch.businessAccountId || "");
      const located = findCustomerEntry(db.customers, customerId, businessAccountId);
      const storageKey = located?.key || customerStorageKey(customerId, businessAccountId);
      const existing = located?.customer;
      const customer =
        existing ||
        {
          id: customerId,
          firstSeenAt: now,
          lastMessageAt: now,
          lastInboundAt: now,
          inboundCount: 0,
          version: 0,
          label: "new_customer",
          source: {},
          productId: "",
          followupsSent: {},
          orderIds: [],
        };

      const shouldRecordInbound = Boolean(patch.recordInbound);
      const savedPatch = { ...patch };
      delete savedPatch.recordInbound;

      db.customers[storageKey] = {
        ...customer,
        ...savedPatch,
        id: customerId,
        version: Number(customer.version || 0) + 1,
        updatedAt: savedPatch.updatedAt || now,
        lastMessageAt: savedPatch.lastMessageAt || now,
        ...(shouldRecordInbound
          ? {
              lastInboundAt: savedPatch.lastInboundAt || savedPatch.lastMessageAt || now,
              inboundCount: Number(customer.inboundCount || 0) + 1,
            }
          : {}),
      };
      db.customers[storageKey].label = computeCustomerLabel(db.customers[storageKey]);
      await this.#writeJsonNow(this.customersPath, db);
      return db.customers[storageKey];
    });
  }

  async getCustomer(customerId, businessAccountId = "") {
    const db = await this.#readJson(this.customersPath, { customers: {} });
    return findCustomerEntry(db.customers, customerId, businessAccountId)?.customer || null;
  }

  async updateCustomer(customerId, updater, businessAccountId = "") {
    return this.#withWriteQueue(async () => {
      const db = await this.#readJson(this.customersPath, { customers: {} });
      const located = findCustomerEntry(db.customers, customerId, businessAccountId);
      const customer = located?.customer;
      if (!customer) throw new Error(`Customer not found: ${customerId}`);
      if (businessAccountId && customer.businessAccountId && customer.businessAccountId !== businessAccountId) {
        throw new Error("Customer is not available for this business account.");
      }
      const now = new Date().toISOString();
      db.customers[located.key] = {
        ...customer,
        ...updater(customer),
        version: Number(customer.version || 0) + 1,
        updatedAt: now,
        label: computeCustomerLabel(customer),
      };
      db.customers[located.key].label = computeCustomerLabel(db.customers[located.key]);
      await this.#writeJsonNow(this.customersPath, db);
      return db.customers[located.key];
    });
  }

  async listCustomers(now = new Date(), businessAccountId = "") {
    const db = await this.#readJson(this.customersPath, { customers: {} });
    return Object.values(db.customers)
      .filter((customer) => belongsToBusiness(customer, businessAccountId))
      .map((customer) => ({
        ...customer,
        label: computeCustomerLabel(customer, now),
        labelDisplay: customerLabelDisplay(computeCustomerLabel(customer, now)),
      }));
  }

  async listDeletedCustomers(businessAccountId = "") {
    const db = await this.#readJson(this.deletedCustomersPath, { customers: [] });
    return db.customers.filter((customer) => belongsToBusiness(customer, businessAccountId));
  }

  async exportCustomerData(customerId, businessAccountId = "") {
    const customersDb = await this.#readJson(this.customersPath, { customers: {} });
    const deletedDb = await this.#readJson(this.deletedCustomersPath, { customers: [] });
    const orders = await this.listOrders();
    const outbox = await this.listOutbox();
    const belongsToBusiness = (item) =>
      item && (!businessAccountId || item.businessAccountId === businessAccountId);
    const activeCustomer = findCustomerEntry(customersDb.customers, customerId, businessAccountId)?.customer || null;
    const deletedCustomer = deletedDb.customers.find(
      (customer) => customer.id === customerId && belongsToBusiness(customer)
    ) || null;
    return {
      customerId,
      customer: activeCustomer || deletedCustomer,
      status: activeCustomer ? "active" : deletedCustomer ? "deleted" : "not_found",
      orders: orders.filter(
        (order) => order.customerId === customerId && (!businessAccountId || order.businessAccountId === businessAccountId)
      ),
      messages: outbox.filter(
        (message) =>
          (message.to === customerId || message.from === customerId) &&
          (!businessAccountId || message.businessAccountId === businessAccountId)
      ),
    };
  }

  async deleteCustomer(customerId, reason = "Manual admin deletion", now = new Date(), businessAccountId = "") {
    const customersDb = await this.#readJson(this.customersPath, { customers: {} });
    const deletedDb = await this.#readJson(this.deletedCustomersPath, { customers: [] });
    const located = findCustomerEntry(customersDb.customers, customerId, businessAccountId);
    const customer = located?.customer;
    if (!customer) return null;
    if (businessAccountId && customer.businessAccountId !== businessAccountId) return null;

    const deletedCustomer = {
      ...customer,
      label: "manual_delete",
      labelDisplay: "DELETE",
      deletedAt: now.toISOString(),
      deleteReason: reason,
    };
    deletedDb.customers.push(deletedCustomer);
    delete customersDb.customers[located.key];
    const ordersDb = await this.#readJson(this.ordersPath, { orders: [] });
    ordersDb.orders = ordersDb.orders.filter((order) =>
      !(order.customerId === customerId && (!businessAccountId || order.businessAccountId === businessAccountId))
    );
    await this.#writeJson(this.customersPath, customersDb);
    await this.#writeJson(this.deletedCustomersPath, deletedDb);
    await this.#writeJson(this.ordersPath, ordersDb);
    return deletedCustomer;
  }

  async addOrder(order) {
    const db = await this.#readJson(this.ordersPath, { orders: [] });
    const now = new Date().toISOString();
    const saved = {
      id: `ord_${Date.now()}`,
      createdAt: now,
      updatedAt: now,
      ...order,
      status: order.status || "pending_admin_order",
    };
    saved.statusHistory = Array.isArray(order.statusHistory) && order.statusHistory.length
      ? order.statusHistory
      : [{ status: saved.status, at: saved.createdAt, actor: "customer" }];
    db.orders.push(saved);
    await this.#writeJson(this.ordersPath, db);

    await this.updateCustomer(saved.customerId, (customer) => ({
      orderIds: [...(customer.orderIds || []), saved.id],
    }), saved.businessAccountId);
    return saved;
  }

  async listOrders(businessAccountId = "") {
    const db = await this.#readJson(this.ordersPath, { orders: [] });
    return db.orders.filter((order) => belongsToBusiness(order, businessAccountId));
  }

  async findLatestOrderForCustomer(customerId, businessAccountId) {
    const orders = await this.listOrders();
    return orders
      .filter((order) => order.customerId === customerId && order.businessAccountId === businessAccountId)
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))[0] || null;
  }

  async updateOrderStatus(orderId, status, actorId) {
    if (!isAllowedOrderStatus(status)) {
      throw new Error("Unknown order status.");
    }
    const db = await this.#readJson(this.ordersPath, { orders: [] });
    const order = db.orders.find((item) => item.id === orderId);
    if (!order) throw new Error("Order not found.");
    if (order.status === status) {
      return order;
    }
    const now = new Date().toISOString();
    order.statusHistory = Array.isArray(order.statusHistory) && order.statusHistory.length
      ? order.statusHistory
      : [{ status: order.status || "pending_admin_order", at: order.createdAt || now, actor: "system" }];
    order.status = status;
    order.updatedAt = now;
    order.statusUpdatedAt = now;
    order.orderAdminId = actorId;
    order.statusHistory.push({ status, at: now, actor: actorId });
    if (status === "acknowledged_by_order_admin") order.acknowledgedAt = now;
    if (status === "ordered_from_supplier") order.orderedAt = now;
    if (status === "reached_warehouse") order.reachedWarehouseAt = now;
    if (status === "preparing_for_delivery") order.preparingDeliveryAt = now;
    if (status === "delivering") order.deliveringAt = now;
    if (status === "delivered") {
      order.deliveredAt = now;
      order.completedAt = now;
    }
    await this.#writeJson(this.ordersPath, db);
    return order;
  }

  async updateOrdersForStockArrival(productId, businessAccountId = "", actorId = "business_admin") {
    const db = await this.#readJson(this.ordersPath, { orders: [] });
    const now = new Date().toISOString();
    const changed = [];
    db.orders = db.orders.map((order) => {
      if (
        order.productId !== productId ||
        (businessAccountId && order.businessAccountId !== businessAccountId) ||
        ["reached_warehouse", "preparing_for_delivery", "delivering", "delivered"].includes(order.status)
      ) {
        return order;
      }
      const updated = {
        ...order,
        status: "reached_warehouse",
        updatedAt: now,
        statusUpdatedAt: now,
        reachedWarehouseAt: now,
        statusHistory: [
          ...(Array.isArray(order.statusHistory) && order.statusHistory.length
            ? order.statusHistory
            : [{ status: order.status || "pending_admin_order", at: order.createdAt || now, actor: "system" }]),
          { status: "reached_warehouse", at: now, actor: actorId },
        ],
      };
      changed.push(updated);
      return updated;
    });
    await this.#writeJson(this.ordersPath, db);
    return changed;
  }

  async getOrderStatusReplies(businessAccountId, defaults = DEFAULT_ORDER_STATUS_REPLIES) {
    const db = await this.#readJson(this.orderStatusRepliesPath, { accounts: {} });
    return { ...defaults, ...(db.accounts[businessAccountId] || {}) };
  }

  async saveOrderStatusReplies(businessAccountId, replies = {}) {
    const db = await this.#readJson(this.orderStatusRepliesPath, { accounts: {} });
    const current = await this.getOrderStatusReplies(businessAccountId);
    const saved = {};
    for (const status of Object.keys(DEFAULT_ORDER_STATUS_REPLIES)) {
      const value = String(replies[status] ?? current[status] ?? "").trim();
      if (!value) throw new Error("Every order status reply must contain message text.");
      saved[status] = value;
    }
    db.accounts[businessAccountId] = saved;
    await this.#writeJson(this.orderStatusRepliesPath, db);
    return saved;
  }

  async addComplaintCase(complaint) {
    const db = await this.#readJson(this.complaintsPath, { cases: [] });
    const now = new Date().toISOString();
    const saved = {
      id: `complaint_${Date.now()}_${db.cases.length + 1}`,
      businessAccountId: String(complaint.businessAccountId || ""),
      customerId: String(complaint.customerId || ""),
      productId: String(complaint.productId || ""),
      category: String(complaint.category || "complaint"),
      reason: String(complaint.reason || ""),
      customerMessage: String(complaint.customerMessage || ""),
      inboundMessageId: String(complaint.inboundMessageId || ""),
      status: "new",
      createdAt: now,
      updatedAt: now,
    };
    db.cases.push(saved);
    await this.#writeJson(this.complaintsPath, db);
    return saved;
  }

  async listComplaintCases(businessAccountId = "") {
    const db = await this.#readJson(this.complaintsPath, { cases: [] });
    return db.cases.filter((item) => !businessAccountId || item.businessAccountId === businessAccountId);
  }

  async resolveComplaintCase(caseId, businessAccountId, actorId) {
    const db = await this.#readJson(this.complaintsPath, { cases: [] });
    const complaint = db.cases.find(
      (item) => item.id === caseId && item.businessAccountId === businessAccountId
    );
    if (!complaint) throw new Error("Complaint case not found.");
    if (complaint.status === "resolved") return complaint;
    complaint.status = "resolved";
    complaint.resolvedAt = new Date().toISOString();
    complaint.updatedAt = complaint.resolvedAt;
    complaint.resolvedBy = String(actorId || "");
    await this.#writeJson(this.complaintsPath, db);
    return complaint;
  }

  async appendOutbox(message) {
    const db = await this.#readJson(this.outboxPath, { messages: [] });
    db.messages.push({
      id: `msg_${Date.now()}_${db.messages.length + 1}`,
      createdAt: new Date().toISOString(),
      ...message,
    });
    this.#pruneOutbox(db);
    await this.#writeJson(this.outboxPath, db);
  }

  async claimProcessedMessage(messageId, businessAccountId = "", metadata = {}) {
    const id = String(messageId || "").trim();
    if (!id) return { claimed: true, record: null };
    return this.#withWriteQueue(async () => {
      const db = await this.#readJson(this.processedMessagesPath, { messages: {} });
      const key = processedMessageKey(id, businessAccountId);
      const existing = db.messages[key];
      if (existing) return { claimed: false, record: existing };
      const now = new Date().toISOString();
      const record = {
        businessAccountId: String(businessAccountId || ""),
        messageId: id,
        receivedAt: now,
        processingStatus: "processing",
        completedAt: "",
        errorCode: "",
        ...metadata,
      };
      db.messages[key] = record;
      this.#pruneProcessedMessages(db);
      await this.#writeJsonNow(this.processedMessagesPath, db);
      return { claimed: true, record };
    });
  }

  async completeProcessedMessage(messageId, businessAccountId = "", patch = {}) {
    return this.#updateProcessedMessage(messageId, businessAccountId, {
      processingStatus: "completed",
      completedAt: new Date().toISOString(),
      errorCode: "",
      ...patch,
    });
  }

  async failProcessedMessage(messageId, businessAccountId = "", errorCode = "PROCESSING_FAILED", patch = {}) {
    return this.#updateProcessedMessage(messageId, businessAccountId, {
      processingStatus: "failed",
      errorCode,
      ...patch,
    });
  }

  async getProcessedMessage(messageId, businessAccountId = "") {
    const id = String(messageId || "").trim();
    if (!id) return null;
    const db = await this.#readJson(this.processedMessagesPath, { messages: {} });
    return db.messages[processedMessageKey(id, businessAccountId)] || null;
  }

  async savePendingBuffer(key, buffer = {}) {
    const id = String(key || "").trim();
    if (!id) throw new Error("Pending buffer key is required.");
    return this.#withWriteQueue(async () => {
      const db = await this.#readJson(this.pendingBuffersPath, { buffers: {} });
      const existing = db.buffers[id] || {};
      const now = new Date().toISOString();
      const record = {
        ...existing,
        ...buffer,
        key: id,
        businessAccountId: String(buffer.businessAccountId ?? existing.businessAccountId ?? ""),
        customerId: String(buffer.customerId ?? existing.customerId ?? ""),
        createdAt: existing.createdAt || buffer.createdAt || now,
        updatedAt: now,
      };
      db.buffers[id] = record;
      await this.#writeJsonNow(this.pendingBuffersPath, db);
      return record;
    });
  }

  async updatePendingBuffer(key, updater) {
    const id = String(key || "").trim();
    if (!id) throw new Error("Pending buffer key is required.");
    if (typeof updater !== "function") throw new Error("Pending buffer updater is required.");
    return this.#withWriteQueue(async () => {
      const db = await this.#readJson(this.pendingBuffersPath, { buffers: {} });
      const existing = db.buffers[id] || null;
      const next = updater(existing);
      if (!next) {
        delete db.buffers[id];
        await this.#writeJsonNow(this.pendingBuffersPath, db);
        return null;
      }
      const now = new Date().toISOString();
      const record = {
        ...(existing || {}),
        ...next,
        key: id,
        businessAccountId: String(next.businessAccountId ?? existing?.businessAccountId ?? ""),
        customerId: String(next.customerId ?? existing?.customerId ?? ""),
        createdAt: existing?.createdAt || next.createdAt || now,
        updatedAt: now,
      };
      db.buffers[id] = record;
      await this.#writeJsonNow(this.pendingBuffersPath, db);
      return record;
    });
  }

  async getPendingBuffer(key) {
    const id = String(key || "").trim();
    if (!id) return null;
    const db = await this.#readJson(this.pendingBuffersPath, { buffers: {} });
    return db.buffers[id] || null;
  }

  async listPendingBuffers(businessAccountId = "") {
    const db = await this.#readJson(this.pendingBuffersPath, { buffers: {} });
    return Object.values(db.buffers)
      .filter((buffer) => !businessAccountId || buffer.businessAccountId === businessAccountId)
      .sort((left, right) => String(left.dueAt || "").localeCompare(String(right.dueAt || "")));
  }

  async deletePendingBuffer(key) {
    const id = String(key || "").trim();
    if (!id) return false;
    return this.#withWriteQueue(async () => {
      const db = await this.#readJson(this.pendingBuffersPath, { buffers: {} });
      const existed = Boolean(db.buffers[id]);
      delete db.buffers[id];
      if (existed) await this.#writeJsonNow(this.pendingBuffersPath, db);
      return existed;
    });
  }

  async hasOutboxMessageId(messageId, businessAccountId = "") {
    const id = String(messageId || "").trim();
    if (!id) return false;
    const db = await this.#readJson(this.outboxPath, { messages: [] });
    return db.messages.some((message) => message.id === id && belongsToBusiness(message, businessAccountId));
  }

  async appendOutboxMany(messages) {
    if (!messages.length) return [];
    const db = await this.#readJson(this.outboxPath, { messages: [] });
    const now = Date.now();
    const saved = messages.map((message, index) => ({
      id: `msg_${now}_${db.messages.length + index + 1}`,
      createdAt: new Date().toISOString(),
      ...message,
    }));
    db.messages.push(...saved);
    this.#pruneOutbox(db);
    await this.#writeJson(this.outboxPath, db);
    return saved;
  }

  async listOutbox(businessAccountId = "") {
    const db = await this.#readJson(this.outboxPath, { messages: [] });
    return db.messages.filter((message) => belongsToBusiness(message, businessAccountId));
  }

  async deleteConversationMessages(customerId, businessAccountId = "") {
    const id = String(customerId || "").trim();
    if (!id) throw new Error("Customer ID is required.");
    const db = await this.#readJson(this.outboxPath, { messages: [] });
    const before = db.messages.length;
    db.messages = db.messages.filter(
      (message) =>
        !(belongsToBusiness(message, businessAccountId) && (message.to === id || message.from === id))
    );
    const deleted = before - db.messages.length;
    if (deleted > 0) await this.#writeJson(this.outboxPath, db);
    return { customerId: id, deleted };
  }

  async appendAuditLog(event) {
    const db = await this.#readJson(this.auditPath, { events: [] });
    const saved = {
      id: `audit_${Date.now()}_${db.events.length + 1}`,
      createdAt: new Date().toISOString(),
      actor: "demo_admin",
      ...event,
    };
    db.events.push(saved);
    this.#pruneAuditLog(db);
    await this.#writeJson(this.auditPath, db);
    return saved;
  }

  async listAuditLog() {
    const db = await this.#readJson(this.auditPath, { events: [] });
    return db.events;
  }

  async resetDemoData() {
    await this.#writeJson(this.customersPath, { customers: {} });
    await this.#writeJson(this.deletedCustomersPath, { customers: [] });
    await this.#writeJson(this.ordersPath, { orders: [] });
    await this.#writeJson(this.outboxPath, { messages: [] });
    await this.#writeJson(this.auditPath, {
      events: [
        {
          id: `audit_${Date.now()}_1`,
          createdAt: new Date().toISOString(),
          actor: "demo_admin",
          action: "reset_demo_data",
          result: "completed",
        },
      ],
    });
  }

  async getDueFollowups(catalog, now = new Date()) {
    const customers = await this.listCustomers(now);
    return customers.flatMap((customer) => {
      const product = catalog.products.find((item) => item.id === customer.productId);
      if (!product || (customer.orderIds || []).length > 0) return [];
      if (customer.optedOut || customer.followupBlocked) return [];

      const followups = productFollowupSequence(product);
      const item = currentFollowupStage(customer, followups, now);
      if (!item || hasFollowupSent(customer, item)) return [];
      if (!isCurrentFollowupSendWindow(customer, item, followups, now)) return [];
      return [{ customer, product, followup: item.followup, followupKey: item.key }];
    });
  }

  async deleteStaleUnresponsiveCustomers(now = new Date()) {
    const db = await this.#readJson(this.customersPath, { customers: {} });
    const deletedDb = await this.#readJson(this.deletedCustomersPath, { customers: [] });
    const deleted = [];

    for (const [customerId, customer] of Object.entries(db.customers)) {
      const ageDays = customerAgeDays(customer, now);
      const hasNoReplyAfterFirstChat = Number(customer.inboundCount || 0) <= 1;
      const hasNoOrder = (customer.orderIds || []).length === 0;
      if (ageDays >= 11 && hasNoReplyAfterFirstChat && hasNoOrder) {
        const deletedCustomer = {
          ...customer,
          label: "delete_pending",
          labelDisplay: "DELETE",
          deletedAt: now.toISOString(),
          deleteReason: "No customer reply by DAY 11",
        };
        deleted.push(deletedCustomer);
        deletedDb.customers.push(deletedCustomer);
        delete db.customers[customerId];
      }
    }

    if (deleted.length) {
      await this.#writeJson(this.customersPath, db);
      await this.#writeJson(this.deletedCustomersPath, deletedDb);
    }

    return deleted;
  }

  async markFollowupSent(customerId, followupKey, sentAt = new Date(), businessAccountId = "", metadata = null) {
    const sentAtIso = sentAt.toISOString();
    const value = metadata && typeof metadata === "object"
      ? {
          sentAt: sentAtIso,
          ...metadata,
        }
      : sentAtIso;
    return this.updateCustomer(customerId, (customer) => ({
      followupsSent: {
        ...(customer.followupsSent || {}),
        [followupKey]: value,
      },
    }), businessAccountId);
  }

  async #readJson(filePath, fallback) {
    if (this.adapter) return this.adapter.readJson(filePath, fallback);
    await mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw.replace(/\u0000+$/g, ""));
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(fallback);
      throw error;
    }
  }

  async #writeJson(filePath, data) {
    if (this.adapter) return this.adapter.writeJson(filePath, data);
    return this.#withWriteQueue(() => this.#writeJsonNow(filePath, data));
  }

  async #writeJsonNow(filePath, data) {
    if (this.adapter) return this.adapter.writeJson(filePath, data);
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tempPath, filePath);
  }

  async #withWriteQueue(operation) {
    const pending = this.writeQueue.then(operation, operation);
    this.writeQueue = pending.catch(() => {});
    return pending;
  }

  async #updateProcessedMessage(messageId, businessAccountId, patch) {
    const id = String(messageId || "").trim();
    if (!id) return null;
    return this.#withWriteQueue(async () => {
      const db = await this.#readJson(this.processedMessagesPath, { messages: {} });
      const key = processedMessageKey(id, businessAccountId);
      const existing = db.messages[key] || {
        businessAccountId: String(businessAccountId || ""),
        messageId: id,
        receivedAt: new Date().toISOString(),
      };
      db.messages[key] = { ...existing, ...patch };
      this.#pruneProcessedMessages(db);
      await this.#writeJsonNow(this.processedMessagesPath, db);
      return db.messages[key];
    });
  }

  #pruneOutbox(db) {
    if (!this.outboxRetentionMs) return;
    const cutoff = Date.now() - this.outboxRetentionMs;
    db.messages = (db.messages || []).filter((message) => {
      const createdAt = new Date(message.createdAt || 0).getTime();
      return !Number.isFinite(createdAt) || createdAt >= cutoff;
    });
  }

  #pruneProcessedMessages(db) {
    if (!this.processedMessageRetentionMs) return;
    const cutoff = Date.now() - this.processedMessageRetentionMs;
    for (const [key, message] of Object.entries(db.messages || {})) {
      const createdAt = new Date(message.completedAt || message.receivedAt || 0).getTime();
      if (Number.isFinite(createdAt) && createdAt < cutoff) delete db.messages[key];
    }
  }

  #pruneAuditLog(db) {
    if (!this.auditLogMaxRows) {
      db.events = [];
      return;
    }
    db.events = (db.events || []).slice(-this.auditLogMaxRows);
  }
}

function retentionMs(value, fallbackDays) {
  const days = Number(value ?? fallbackDays);
  if (!Number.isFinite(days) || days <= 0) return 0;
  return days * DAY_MS;
}

function customerStorageKey(customerId, businessAccountId = "") {
  return businessAccountId ? `${businessAccountId}::${customerId}` : customerId;
}

function processedMessageKey(messageId, businessAccountId = "") {
  return `${businessAccountId || ""}::${messageId}`;
}

function findCustomerEntry(customers, customerId, businessAccountId = "") {
  if (businessAccountId) {
    const scopedKey = customerStorageKey(customerId, businessAccountId);
    if (customers[scopedKey]) return { key: scopedKey, customer: customers[scopedKey] };
    if (customers[customerId]?.businessAccountId === businessAccountId) {
      return { key: customerId, customer: customers[customerId] };
    }
    return null;
  }
  if (customers[customerId]) return { key: customerId, customer: customers[customerId] };
  const matches = Object.entries(customers).filter(([, customer]) => customer.id === customerId);
  if (matches.length === 1) return { key: matches[0][0], customer: matches[0][1] };
  return null;
}

function belongsToBusiness(item, businessAccountId = "") {
  return !businessAccountId || item?.businessAccountId === businessAccountId;
}

export function computeCustomerLabel(customer, now = new Date()) {
  if (customer.optedOut) return "opted_out";
  if ((customer.orderIds || []).length > 0) return "done_customer";
  const ageDays = customerAgeDays(customer, now);
  if (ageDays >= 11 && Number(customer.inboundCount || 0) <= 1 && (customer.orderIds || []).length === 0) {
    return "delete_pending";
  }
  if (ageDays <= 0) return "new_customer";
  return `day_${Math.min(ageDays, 10)}_customer`;
}

export function customerLabelDisplay(label) {
  if (label === "new_customer") return "NEW";
  if (label === "done_customer") return "DONE";
  if (label === "opted_out") return "OPTED OUT";
  if (label === "delete_pending") return "DELETE";
  const dayMatch = String(label).match(/^day_(\d+)_customer$/);
  if (dayMatch) return `DAY ${dayMatch[1]}`;
  return label;
}

function firstFollowupDueAt(firstSeenAt, options = {}) {
  const firstSeen = new Date(firstSeenAt);
  const cutoffEnabled = options.cutoffEnabled !== false;
  const cutoffHour = Number.isFinite(options.cutoffHour) ? options.cutoffHour : 19;
  const sendHour = Number.isFinite(options.sendHour) ? options.sendHour : 20;
  const sendMinute = Number.isFinite(options.sendMinute) ? options.sendMinute : 0;
  const firstSeenLocal = zonedDateParts(firstSeen);
  const dueLocal = { ...firstSeenLocal, hour: sendHour, minute: sendMinute, second: 0, millisecond: 0 };
  if (cutoffEnabled && firstSeenLocal.hour >= cutoffHour) {
    return zonedLocalToDate(addLocalDays(dueLocal, 1));
  }
  return zonedLocalToDate(dueLocal);
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour || 0, parts.minute || 0, parts.second || 0, parts.millisecond || 0));
  return {
    ...parts,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function zonedDateParts(date, timeZone = BUSINESS_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return {
    year: value.year,
    month: value.month,
    day: value.day,
    hour: value.hour,
    minute: value.minute,
    second: value.second,
    millisecond: date.getMilliseconds(),
  };
}

function zonedLocalToDate(parts, timeZone = BUSINESS_TIME_ZONE) {
  const targetUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0, parts.millisecond || 0);
  const guess = new Date(targetUtc);
  const guessParts = zonedDateParts(guess, timeZone);
  const guessAsUtc = Date.UTC(
    guessParts.year,
    guessParts.month - 1,
    guessParts.day,
    guessParts.hour || 0,
    guessParts.minute || 0,
    guessParts.second || 0,
    guessParts.millisecond || 0
  );
  return new Date(targetUtc - (guessAsUtc - guess.getTime()));
}

function productFollowupSequence(product) {
  const customRows = Array.isArray(product?.followup_schedule) ? product.followup_schedule : [];
  if (customRows.length) {
    const firstFollowup = customRows[0] || {};
    return customRows
      .map((row, index) => normalizeFollowupScheduleRow(row, index, firstFollowup))
      .filter((item) => item.enabled !== false)
      .sort((a, b) => a.dayOffset - b.dayOffset || a.sortTime - b.sortTime || a.index - b.index);
  }
  const entries = Object.entries(product.followups || {});
  const firstFollowup = entries.find(([key]) => key === FIRST_FOLLOWUP_KEY)?.[1] || {};
  return entries
    .map(([key, followup], index) => ({
      key,
      followup,
      firstFollowup,
      index,
      dayOffset: followupDayOffset(key, followup, index),
      sendHour: Number.isFinite(followup?.send_hour) ? followup.send_hour : 20,
    }))
    .sort((a, b) => a.dayOffset - b.dayOffset || a.index - b.index);
}

function normalizeFollowupScheduleRow(row = {}, index = 0, firstFollowup = {}) {
  const timingType = String(row.timingType || row.timing_type || "").trim() === "delay_after_opening"
    ? "delay_after_opening"
    : "fixed_time";
  const dayOffset = clampNumber(row.dayOffset ?? row.day_offset, 0, 365, 0);
  const sendParts = parseFollowupSendTime(row.sendTime ?? row.send_time, row.sendHour ?? row.send_hour, row.sendMinute ?? row.send_minute, 20, 0);
  const sendHour = sendParts.hour;
  const sendMinute = sendParts.minute;
  const fallbackDelayMinutes = Math.max(1, sendHour) * 60;
  const delayMinutes = parseFollowupDelayMinutes(row.delayDuration ?? row.delay_duration, row.delayMinutes ?? row.delay_minutes, row.delayHours ?? row.delay_hours, fallbackDelayMinutes);
  const delayHours = Math.max(1, Math.ceil(delayMinutes / 60));
  return {
    key: String(row.key || `custom_followup_${index + 1}`).trim() || `custom_followup_${index + 1}`,
    legacyKeys: normalizeFollowupLegacyKeys(row),
    followup: row,
    firstFollowup,
    index,
    enabled: row.enabled !== false,
    customSchedule: true,
    timingType,
    dayOffset,
    sendHour,
    sendMinute,
    sendTime: formatFollowupSendTime(sendHour, sendMinute),
    delayHours,
    delayMinutes,
    delayDuration: formatFollowupDuration(delayMinutes),
    sortTime: timingType === "delay_after_opening" ? delayMinutes : sendHour * 60 + sendMinute,
    firstChatCutoffEnabled: row.firstChatCutoffEnabled ?? row.first_chat_cutoff_enabled,
    firstChatCutoffHour: row.firstChatCutoffHour ?? row.first_chat_cutoff_hour,
  };
}

function normalizeFollowupLegacyKeys(row = {}) {
  return Array.isArray(row.legacy_keys)
    ? row.legacy_keys.map((key) => String(key || "").trim()).filter(Boolean)
    : [];
}

function followupSentKeys(item = {}) {
  return [item.key, ...(Array.isArray(item.legacyKeys) ? item.legacyKeys : [])]
    .map((key) => String(key || "").trim())
    .filter(Boolean);
}

function followupSentAt(customer = {}, item = {}) {
  const sent = customer.followupsSent && typeof customer.followupsSent === "object"
    ? customer.followupsSent
    : {};
  for (const key of followupSentKeys(item)) {
    const value = sent[key];
    if (!value) continue;
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && value.sentAt) return value.sentAt;
  }
  return "";
}

function hasFollowupSent(customer = {}, item = {}) {
  return Boolean(followupSentAt(customer, item));
}

function followupDayOffset(key, followup, index) {
  if (Number.isFinite(followup?.day_offset)) return followup.day_offset;
  if (key === FIRST_FOLLOWUP_KEY) return 0;
  const dayMatch = String(key).match(/^day_(\d+)_followup$/);
  if (dayMatch) return Number(dayMatch[1]);
  return index;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function parseFollowupSendTime(sendTime, sendHour, sendMinute, fallbackHour = 20, fallbackMinute = 0) {
  const timeMatch = String(sendTime || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    return {
      hour: clampNumber(timeMatch[1], 0, 23, fallbackHour),
      minute: clampNumber(timeMatch[2], 0, 59, fallbackMinute),
    };
  }
  return {
    hour: clampNumber(sendHour, 0, 23, fallbackHour),
    minute: clampNumber(sendMinute, 0, 59, fallbackMinute),
  };
}

function formatFollowupSendTime(sendHour, sendMinute = 0) {
  return `${String(clampNumber(sendHour, 0, 23, 20)).padStart(2, "0")}:${String(clampNumber(sendMinute, 0, 59, 0)).padStart(2, "0")}`;
}

function parseFollowupDelayMinutes(delayDuration, delayMinutes, delayHours, fallbackMinutes = 60) {
  const durationMatch = String(delayDuration || "").trim().match(/^(\d{1,3}):(\d{2})$/);
  if (durationMatch) {
    const hours = clampNumber(durationMatch[1], 0, 720, 0);
    const minutes = clampNumber(durationMatch[2], 0, 59, 0);
    return Math.max(1, Math.min(720 * 60, hours * 60 + minutes));
  }
  const minutesValue = Number(delayMinutes);
  if (Number.isFinite(minutesValue)) return Math.max(1, Math.min(720 * 60, Math.trunc(minutesValue)));
  return clampNumber(delayHours, 1, 720, Math.max(1, Math.ceil(fallbackMinutes / 60))) * 60;
}

function formatFollowupDuration(totalMinutes = 60) {
  const minutes = Math.max(1, Math.min(720 * 60, Math.trunc(Number(totalMinutes) || 60)));
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function followupDueAt(firstSeenAt, item) {
  if (item.customSchedule && item.timingType === "delay_after_opening") {
    return new Date(new Date(firstSeenAt).getTime() + Math.max(1, Number(item.delayMinutes || Math.max(1, Number(item.delayHours || 1)) * 60)) * 60 * 1000);
  }
  if (item.customSchedule) {
    const firstSeenLocal = zonedDateParts(new Date(firstSeenAt));
    let dueLocal = addLocalDays({ ...firstSeenLocal, hour: item.sendHour, minute: item.sendMinute || 0, second: 0, millisecond: 0 }, item.dayOffset);
    if (
      item.index === 0 &&
      item.dayOffset === 0 &&
      item.firstChatCutoffEnabled !== false &&
      Number.isFinite(Number(item.firstChatCutoffHour)) &&
      firstSeenLocal.hour >= Number(item.firstChatCutoffHour)
    ) {
      dueLocal = addLocalDays(dueLocal, 1);
    }
    return zonedLocalToDate(dueLocal);
  }
  const firstDueAt = firstFollowupDueAt(firstSeenAt, {
    cutoffEnabled: item.firstFollowup?.first_chat_cutoff_enabled !== false,
    cutoffHour: item.firstFollowup?.first_chat_cutoff_hour,
    sendHour: Number.isFinite(item.firstFollowup?.send_hour) ? item.firstFollowup.send_hour : item.sendHour,
    sendMinute: Number.isFinite(item.firstFollowup?.send_minute) ? item.firstFollowup.send_minute : item.sendMinute,
  });
  if (item.key === FIRST_FOLLOWUP_KEY) return firstDueAt;

  const firstSeenLocal = zonedDateParts(new Date(firstSeenAt));
  const dueLocal = addLocalDays({ ...firstSeenLocal, hour: item.sendHour, minute: item.sendMinute || 0, second: 0, millisecond: 0 }, item.dayOffset);
  let due = zonedLocalToDate(dueLocal);
  if (due <= firstDueAt) {
    due = zonedLocalToDate(addLocalDays({ ...zonedDateParts(firstDueAt), hour: item.sendHour, minute: item.sendMinute || 0, second: 0, millisecond: 0 }, 1));
  }
  return due;
}

function previousFollowupSentAt(customer, item, sequence = []) {
  const itemIndex = sequence.findIndex((entry) => entry.key === item.key);
  if (itemIndex <= 0) return null;
  for (let index = itemIndex - 1; index >= 0; index -= 1) {
    const sentAt = followupSentAt(customer, sequence[index]);
    if (!sentAt) continue;
    const date = new Date(sentAt);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function nextFollowupDueAfterPreviousSent(previousSentAt, item) {
  const previousLocal = zonedDateParts(previousSentAt);
  const nextLocal = addLocalDays(
    { ...previousLocal, hour: item.sendHour, minute: item.sendMinute || 0, second: 0, millisecond: 0 },
    1
  );
  let due = zonedLocalToDate(nextLocal);
  if (due <= previousSentAt) {
    due = zonedLocalToDate(addLocalDays(nextLocal, 1));
  }
  return due;
}

function effectiveFollowupDueAt(customer, item, sequence = []) {
  const scheduledDueAt = followupDueAt(customer.firstSeenAt, item);
  const previousSentAt = previousFollowupSentAt(customer, item, sequence);
  if (!previousSentAt) return scheduledDueAt;
  if (item.customSchedule && scheduledDueAt > previousSentAt) return scheduledDueAt;
  const previousGateAt = nextFollowupDueAfterPreviousSent(previousSentAt, item);
  return scheduledDueAt > previousGateAt ? scheduledDueAt : previousGateAt;
}

function currentFollowupStage(customer, sequence = [], now = new Date()) {
  return sequence.find((item) => {
    if (hasFollowupSent(customer, item)) return false;
    const dueAt = effectiveFollowupDueAt(customer, item, sequence);
    if (!dueAt) return false;
    const nowLocal = zonedDateParts(now);
    const dueLocal = zonedDateParts(dueAt);
    return nowLocal.year === dueLocal.year && nowLocal.month === dueLocal.month && nowLocal.day === dueLocal.day;
  }) || null;
}

function isCurrentFollowupSendWindow(customer, item, sequence = [], now = new Date()) {
  const dueAt = effectiveFollowupDueAt(customer, item, sequence);
  if (!dueAt) return false;
  const nowLocal = zonedDateParts(now);
  const dueLocal = zonedDateParts(dueAt);
  return (
    now >= dueAt &&
    nowLocal.year === dueLocal.year &&
    nowLocal.month === dueLocal.month &&
    nowLocal.day === dueLocal.day
  );
}

function localCalendarDayDiff(start, end) {
  const startDay = zonedDateParts(start);
  const endDay = zonedDateParts(end);
  const startUtc = Date.UTC(startDay.year, startDay.month - 1, startDay.day);
  const endUtc = Date.UTC(endDay.year, endDay.month - 1, endDay.day);
  return Math.floor((endUtc - startUtc) / DAY_MS);
}

function customerAgeDays(customer, now = new Date()) {
  return localCalendarDayDiff(new Date(customer.firstSeenAt || now), now);
}

function isWithinCustomerServiceWindow(customer, at = new Date()) {
  const lastInbound = new Date(customer.lastInboundAt || customer.firstSeenAt || 0);
  if (Number.isNaN(lastInbound.getTime())) return false;
  return at.getTime() - lastInbound.getTime() <= DAY_MS;
}
