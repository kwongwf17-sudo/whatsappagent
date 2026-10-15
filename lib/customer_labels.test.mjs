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
  assert.equal(computeCustomerLabel(restarted, new Date("2026-10-28T00:00:00Z")), "day_11_plus_customer");
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
  assert.equal(computeCustomerLabel({ ...restarted, freshAdJourney: { ...restarted.freshAdJourney, startedAt: "invalid" } }, new Date("2026-10-14T16:00:00Z")), "day_11_plus_customer");
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

test("every imported starting stage is preserved and advances by elapsed calendar days", () => {
  for (let startingDay = 0; startingDay <= 10; startingDay += 1) {
    const customer = {
      firstSeenAt: "2026-10-09T21:31:01Z", importedAt: "2026-10-09T21:31:01Z",
      importStageLabelDisplay: startingDay === 0 ? "NEW" : `DAY ${startingDay}`,
      orderIds: [], inboundCount: 0,
    };
    for (const elapsed of [0, 1, 5, 10]) {
      const expectedDay = startingDay + elapsed;
      const now = new Date(Date.UTC(2026, 9, 10 + elapsed, 1));
      assert.equal(computeCustomerLabel(customer, now), expectedDay === 0 ? "new_customer" : expectedDay > 10 ? "day_11_plus_customer" : `day_${expectedDay}_customer`, `import DAY ${startingDay}, elapsed ${elapsed}`);
    }
  }
});

test("import label age uses the import date, while deletion eligibility keeps its existing clock", () => {
  const imported = {
    firstSeenAt: "2026-10-08T01:00:00Z", importedAt: "2026-10-09T21:31:01Z",
    importStageLabelDisplay: "DAY 9", orderIds: [], inboundCount: 0,
  };
  assert.equal(computeCustomerLabel(imported, new Date("2026-10-10T02:00:00Z")), "day_9_customer");
  assert.equal(computeCustomerLabel(imported, new Date("2026-10-11T02:00:00Z")), "day_10_customer");
  assert.equal(computeCustomerLabel(imported, new Date("2026-10-18T02:00:00Z")), "day_11_plus_customer");
  assert.equal(computeCustomerLabel(imported, new Date("2026-10-19T02:00:00Z")), "delete_pending");
});

test("import offsets advance at Malaysia midnight and support legacy missing import dates", () => {
  const imported = { firstSeenAt: "2026-10-10T01:00:00Z", importedAt: "2026-10-10T01:00:00Z", importStageLabelDisplay: "DAY 5", orderIds: [] };
  assert.equal(computeCustomerLabel(imported, new Date("2026-10-10T15:59:59Z")), "day_5_customer");
  assert.equal(computeCustomerLabel(imported, new Date("2026-10-10T16:00:00Z")), "day_6_customer");
  assert.equal(computeCustomerLabel({ ...imported, importedAt: undefined }, new Date("2026-10-10T16:00:00Z")), "day_6_customer");
  assert.equal(computeCustomerLabel({ ...imported, importedAt: "invalid" }, new Date("2026-10-10T16:00:00Z")), "day_6_customer");
});

test("fresh journeys, opted-out customers and submitted orders take priority over import stages", () => {
  const importedRestart = { ...restarted, importedAt: "2026-10-01T01:00:00Z", importStageLabelDisplay: "DAY 9" };
  const now = new Date("2026-10-14T16:00:00Z");
  assert.equal(computeCustomerLabel(importedRestart, now), "day_2_customer");
  assert.equal(computeCustomerLabel({ ...importedRestart, optedOut: true }, now), "opted_out");
  assert.equal(computeCustomerLabel({ ...importedRestart, freshAdJourney: null }, now), "done_customer");
});

test("imported stage progression is read-only and does not change follow-up eligibility", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "import-labels-"));
  const customer = {
    id: "6733333333@s.whatsapp.net", businessAccountId: "JointCare", productId: "jointcare",
    firstSeenAt: "2026-10-10T01:00:00Z", importedAt: "2026-10-10T01:00:00Z",
    openingFlowSentAt: "2026-10-10T01:00:00Z", importStageLabelDisplay: "DAY 7",
    orderIds: [], inboundCount: 0, followupsSent: { first_day_followup: "2026-10-10T01:00:00Z" },
  };
  const file = path.join(dir, "customers.json");
  await writeFile(file, JSON.stringify({ customers: { customer } }));
  const store = new JsonStore(dir);
  const catalog = { products: [{ id: "jointcare", followups: { first_day_followup: { message: "first", day_offset: 0, send_hour: 20 }, day_1_followup: { message: "next", day_offset: 1, send_hour: 20 } } }] };
  const now = new Date("2026-10-11T12:01:00Z");
  const before = await readFile(file, "utf8");
  const dueBefore = await store.getDueFollowups(catalog, now);
  const listed = await store.listCustomers(now, "JointCare");
  assert.equal(listed[0].labelDisplay, "DAY 8");
  assert.deepEqual(await store.getDueFollowups(catalog, now), dueBefore);
  assert.equal(await readFile(file, "utf8"), before);
});
