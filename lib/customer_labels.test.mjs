import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonStore, computeCustomerLabel } from "./store.mjs";

const restarted = {
  id: "123@lid", businessAccountId: "SHAWN02", firstSeenAt: "2026-09-01T00:00:00Z",
  inboundCount: 1, orderIds: ["old_order"],
  freshAdJourney: { active: true, productId: "ss70", startedAt: "2026-10-13T14:34:18Z" },
  followupsSent: { first_day_followup: "2026-10-13T17:34:46Z" },
};

test("restarted journey ages by Malaysia calendar date and ignores old orders", () => {
  assert.equal(computeCustomerLabel(restarted, new Date("2026-10-13T15:59:59Z")), "new_customer");
  assert.equal(computeCustomerLabel(restarted, new Date("2026-10-13T16:00:00Z")), "day_1_customer");
  assert.equal(computeCustomerLabel(restarted, new Date("2026-10-14T16:00:00Z")), "day_2_customer");
  assert.equal(computeCustomerLabel(restarted, new Date("2026-10-28T00:00:00Z")), "day_10_customer");
});

test("opt-out takes priority over both active journeys and orders", () => {
  assert.equal(computeCustomerLabel({ ...restarted, optedOut: true }, new Date("2026-10-14T16:00:00Z")), "opted_out");
});

test("completed order uses DONE after the existing submission handler closes the journey", () => {
  const submitted = { ...restarted, orderIds: ["old_order", "new_order"], freshAdJourney: null, status: "order_submitted" };
  assert.equal(computeCustomerLabel(submitted, new Date("2026-10-14T16:00:00Z")), "done_customer");
});

test("first-seen and sent follow-up count do not replace the restarted journey date", () => {
  assert.equal(computeCustomerLabel({ ...restarted, followupsSent: { day_1: "x", day_2: "x", day_3: "x" } }, new Date("2026-10-13T15:00:00Z")), "new_customer");
  assert.equal(computeCustomerLabel({ ...restarted, freshAdJourney: { ...restarted.freshAdJourney, startedAt: "invalid" } }, new Date("2026-10-14T16:00:00Z")), "day_10_customer");
});

test("JSON customer list progresses imported and restarted labels without writing state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "customer-labels-"));
  const imported = { id: "6731111111@s.whatsapp.net", businessAccountId: "JointCare", firstSeenAt: "2026-10-09T21:31:01Z", inboundCount: 0, orderIds: [], label: "new_customer", importStageLabelDisplay: "NEW", followupsSent: { day_3_followup: "2026-10-14T12:00:00Z" } };
  const db = { customers: { imported, restarted, optedOut: { ...imported, id: "6732222222@s.whatsapp.net", optedOut: true } } };
  const file = path.join(dir, "customers.json");
  await writeFile(file, JSON.stringify(db));
  const before = await readFile(file, "utf8");
  const store = new JsonStore(dir);
  const rows = await store.listCustomers(new Date("2026-10-14T16:00:00Z"));
  assert.equal(rows.find(c => c.id === imported.id).labelDisplay, "DAY 5");
  assert.equal(rows.find(c => c.id === restarted.id).labelDisplay, "DAY 2");
  assert.equal(rows.find(c => c.optedOut).labelDisplay, "OPTED OUT");
  assert.equal(rows.find(c => c.id === imported.id).importStageLabelDisplay, "NEW");
  assert.deepEqual(rows.find(c => c.id === restarted.id).freshAdJourney, restarted.freshAdJourney);
  assert.deepEqual(rows.find(c => c.id === restarted.id).followupsSent, restarted.followupsSent);
  assert.equal(await readFile(file, "utf8"), before);
});

test("table-backed list uses the same date-aware label and preserves account scope", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "customer-labels-"));
  const original = structuredClone(restarted);
  const adapter = {
    customersTableEnabled: true,
    getCustomerRow: async () => original,
    upsertCustomerRow: async () => { throw new Error("Label reads must not write customer data"); },
    deleteCustomerRow: async () => { throw new Error("Label reads must not delete customer data"); },
    listCustomerRows: async () => [original, { ...original, id: "other", businessAccountId: "Other" }],
  };
  const store = new JsonStore(dir, { adapter });
  const rows = await store.listCustomers(new Date("2026-10-14T16:00:00Z"), "SHAWN02");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].labelDisplay, "DAY 2");
  assert.deepEqual(original, restarted);
});
