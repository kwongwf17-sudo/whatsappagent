import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_ORDER_STATUS_REPLIES, isAllowedOrderStatus } from "./order_tracking.mjs";
import { DEFAULT_COMPLAINT_ACKNOWLEDGEMENT } from "./complaints.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_FOLLOWUP_KEY = "first_day_followup";

export class JsonStore {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.adapter = options.adapter || null;
    this.customersPath = path.join(dataDir, "customers.json");
    this.deletedCustomersPath = path.join(dataDir, "deleted_customers.json");
    this.ordersPath = path.join(dataDir, "orders.json");
    this.orderStatusRepliesPath = path.join(dataDir, "order_status_replies.json");
    this.complaintsPath = path.join(dataDir, "complaint_cases.json");
    this.complaintSettingsPath = path.join(dataDir, "complaint_settings.json");
    this.outboxPath = path.join(dataDir, "outbox.json");
    this.auditPath = path.join(dataDir, "audit_log.json");
    this.writeQueue = Promise.resolve();
  }

  async getOrCreateCustomer(customerId, patch = {}) {
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
      lastMessageAt: savedPatch.lastMessageAt || now,
      ...(shouldRecordInbound
        ? {
            lastInboundAt: savedPatch.lastInboundAt || savedPatch.lastMessageAt || now,
            inboundCount: Number(customer.inboundCount || 0) + 1,
          }
        : {}),
    };
    db.customers[storageKey].label = computeCustomerLabel(db.customers[storageKey]);
    await this.#writeJson(this.customersPath, db);
    return db.customers[storageKey];
  }

  async updateCustomer(customerId, updater, businessAccountId = "") {
    const db = await this.#readJson(this.customersPath, { customers: {} });
    const located = findCustomerEntry(db.customers, customerId, businessAccountId);
    const customer = located?.customer;
    if (!customer) throw new Error(`Customer not found: ${customerId}`);
    if (businessAccountId && customer.businessAccountId && customer.businessAccountId !== businessAccountId) {
      throw new Error("Customer is not available for this business account.");
    }
    db.customers[located.key] = {
      ...customer,
      ...updater(customer),
      label: computeCustomerLabel(customer),
    };
    db.customers[located.key].label = computeCustomerLabel(db.customers[located.key]);
    await this.#writeJson(this.customersPath, db);
    return db.customers[located.key];
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
    await this.#writeJson(this.customersPath, customersDb);
    await this.#writeJson(this.deletedCustomersPath, deletedDb);
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

  async getComplaintSettings(businessAccountId) {
    const db = await this.#readJson(this.complaintSettingsPath, { accounts: {} });
    return {
      acknowledgement: String(
        db.accounts[businessAccountId]?.acknowledgement || DEFAULT_COMPLAINT_ACKNOWLEDGEMENT
      ),
    };
  }

  async saveComplaintSettings(businessAccountId, settings = {}) {
    const acknowledgement = String(settings.acknowledgement || "").trim();
    if (!acknowledgement) throw new Error("Complaint acknowledgement message is required.");
    const db = await this.#readJson(this.complaintSettingsPath, { accounts: {} });
    const saved = { acknowledgement };
    db.accounts[businessAccountId] = saved;
    await this.#writeJson(this.complaintSettingsPath, db);
    return saved;
  }

  async appendOutbox(message) {
    const db = await this.#readJson(this.outboxPath, { messages: [] });
    db.messages.push({
      id: `msg_${Date.now()}_${db.messages.length + 1}`,
      createdAt: new Date().toISOString(),
      ...message,
    });
    await this.#writeJson(this.outboxPath, db);
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
      const due = [];

      for (const item of followups) {
        const isSent = Boolean(customer.followupsSent?.[item.key]);
        if (isSent) continue;
        const dueAt = followupDueAt(customer.firstSeenAt, item);
        if (now >= dueAt) {
          due.push({ customer, product, followup: item.followup, followupKey: item.key });
        }
        break;
      }

      return due;
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

  async markFollowupSent(customerId, followupKey, sentAt = new Date(), businessAccountId = "") {
    return this.updateCustomer(customerId, (customer) => ({
      followupsSent: {
        ...(customer.followupsSent || {}),
        [followupKey]: sentAt.toISOString(),
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
    const write = async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`);
      await rename(tempPath, filePath);
    };
    const pending = this.writeQueue.then(write, write);
    this.writeQueue = pending.catch(() => {});
    await pending;
  }
}

function customerStorageKey(customerId, businessAccountId = "") {
  return businessAccountId ? `${businessAccountId}::${customerId}` : customerId;
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
  const ageDays = customerAgeDays(customer, now);
  if (ageDays >= 11 && Number(customer.inboundCount || 0) <= 1 && (customer.orderIds || []).length === 0) {
    return "delete_pending";
  }
  if (customer.followupsSent?.first_day_followup && ageDays <= 1) return "day_1_customer";
  if (ageDays <= 0) return "new_customer";
  return `day_${Math.min(ageDays, 10)}_customer`;
}

export function customerLabelDisplay(label) {
  if (label === "new_customer") return "NEW";
  if (label === "opted_out") return "OPTED OUT";
  if (label === "delete_pending") return "DELETE";
  const dayMatch = String(label).match(/^day_(\d+)_customer$/);
  if (dayMatch) return `DAY ${dayMatch[1]}`;
  return label;
}

function firstFollowupDueAt(firstSeenAt, options = {}) {
  const firstSeen = new Date(firstSeenAt);
  const due = new Date(firstSeen);
  const cutoffHour = Number.isFinite(options.cutoffHour) ? options.cutoffHour : 19;
  const sendHour = Number.isFinite(options.sendHour) ? options.sendHour : 20;
  if (firstSeen.getHours() < cutoffHour) {
    due.setHours(sendHour, 0, 0, 0);
    return due;
  }
  due.setDate(due.getDate() + 1);
  due.setHours(sendHour, 0, 0, 0);
  return due;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function productFollowupSequence(product) {
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

function followupDayOffset(key, followup, index) {
  if (Number.isFinite(followup?.day_offset)) return followup.day_offset;
  if (key === FIRST_FOLLOWUP_KEY) return 0;
  const dayMatch = String(key).match(/^day_(\d+)_followup$/);
  if (dayMatch) return Number(dayMatch[1]);
  return index;
}

function followupDueAt(firstSeenAt, item) {
  const firstDueAt = firstFollowupDueAt(firstSeenAt, {
    cutoffHour: item.firstFollowup?.first_chat_cutoff_hour,
    sendHour: Number.isFinite(item.firstFollowup?.send_hour) ? item.firstFollowup.send_hour : item.sendHour,
  });
  if (item.key === FIRST_FOLLOWUP_KEY) return firstDueAt;

  const firstSeen = new Date(firstSeenAt);
  const due = addDays(firstSeen, item.dayOffset);
  due.setHours(item.sendHour, 0, 0, 0);
  if (due <= firstDueAt) {
    due.setTime(firstDueAt.getTime());
    due.setDate(due.getDate() + 1);
    due.setHours(item.sendHour, 0, 0, 0);
  }
  return due;
}

function localCalendarDayDiff(start, end) {
  const startDay = new Date(start);
  startDay.setHours(0, 0, 0, 0);
  const endDay = new Date(end);
  endDay.setHours(0, 0, 0, 0);
  return Math.floor((endDay.getTime() - startDay.getTime()) / DAY_MS);
}

function customerAgeDays(customer, now = new Date()) {
  return localCalendarDayDiff(new Date(customer.firstSeenAt || now), now);
}

function isWithinCustomerServiceWindow(customer, at = new Date()) {
  const lastInbound = new Date(customer.lastInboundAt || customer.firstSeenAt || 0);
  if (Number.isNaN(lastInbound.getTime())) return false;
  return at.getTime() - lastInbound.getTime() <= DAY_MS;
}
