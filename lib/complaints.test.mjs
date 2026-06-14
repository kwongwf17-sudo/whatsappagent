import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_COMPLAINT_ACKNOWLEDGEMENT, detectObviousComplaint } from "./complaints.mjs";
import { JsonStore } from "./store.mjs";

test("clear complaint wording is categorized for immediate handoff", () => {
  assert.equal(detectObviousComplaint("Barang ani rosak, inda berfungsi").category, "damaged_wrong_item");
  assert.equal(detectObviousComplaint("Saya mau refund").category, "refund_return");
  assert.equal(detectObviousComplaint("Kalau inda selesai saya report").category, "legal_report_threat");
  assert.equal(detectObviousComplaint("Saya kecewa banar dengan service ani").category, "complaint");
  assert.equal(detectObviousComplaint("Delivery ada caj tak?"), null);
});

test("complaint cases and acknowledgement text remain business scoped", async () => {
  const dataDir = await mkdtemp(path.resolve("whatsapp_agent/data/.complaint-test-"));
  try {
    const store = new JsonStore(dataDir);
    const caseA = await store.addComplaintCase({
      businessAccountId: "store-a",
      customerId: "6730001",
      productId: "product-a",
      category: "complaint",
      customerMessage: "Saya kecewa",
    });
    await store.addComplaintCase({
      businessAccountId: "store-b",
      customerId: "6730001",
      productId: "product-b",
      category: "refund_return",
      customerMessage: "Refund",
    });
    await store.saveComplaintSettings("store-a", { acknowledgement: "Store A will help shortly." });

    assert.equal((await store.listComplaintCases("store-a")).length, 1);
    assert.equal((await store.listComplaintCases("store-b")).length, 1);
    assert.equal((await store.getComplaintSettings("store-a")).acknowledgement, "Store A will help shortly.");
    assert.equal((await store.getComplaintSettings("store-b")).acknowledgement, DEFAULT_COMPLAINT_ACKNOWLEDGEMENT);

    const resolved = await store.resolveComplaintCase(caseA.id, "store-a", "admin-a");
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolvedBy, "admin-a");
    await assert.rejects(
      store.resolveComplaintCase(caseA.id, "store-b", "admin-b"),
      /Complaint case not found/
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
