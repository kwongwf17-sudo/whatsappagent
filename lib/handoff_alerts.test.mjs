import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanHandoffAlertNumber,
  customerDisplayForAlert,
  formatHandoffAlert,
  handoffAlertPatch,
  handoffAlertSettings,
  shouldSendHandoffAlert,
} from "./handoff_alerts.mjs";

test("handoff alert settings accept normal WhatsApp numbers", () => {
  assert.equal(cleanHandoffAlertNumber("+673 123-4567"), "6731234567");
  assert.equal(cleanHandoffAlertNumber("abc"), "");
  assert.deepEqual(
    handoffAlertSettings({
      handoffAlertEnabled: true,
      handoffAlertNumber: "+673 123-4567",
      handoffAlertCooldownMinutes: "7",
    }),
    { enabled: true, number: "6731234567", cooldownMinutes: 7 }
  );
});

test("handoff alert display prefers customer phone and keeps lid as id", () => {
  assert.deepEqual(
    customerDisplayForAlert(
      { phone: "+673 7342742" },
      "20053605003509@lid"
    ),
    { customer: "6737342742", customerId: "20053605003509@lid" }
  );
  assert.deepEqual(
    customerDisplayForAlert({}, "6737342742@s.whatsapp.net"),
    { customer: "6737342742", customerId: "6737342742@s.whatsapp.net" }
  );
});

test("handoff alert sends only for active human handoff and respects cooldown", () => {
  const settings = {
    handoffAlertEnabled: true,
    handoffAlertNumber: "6737342742",
    handoffAlertCooldownMinutes: 10,
  };
  const now = new Date("2026-09-22T04:00:00.000Z");
  assert.equal(shouldSendHandoffAlert({ handoffStatus: "human_required", handoffReason: "Audio failed" }, settings, now), true);
  assert.equal(shouldSendHandoffAlert({ handoffStatus: "", handoffReason: "Audio failed" }, settings, now), false);
  assert.equal(shouldSendHandoffAlert({ handoffStatus: "human_required", handoffReason: "Audio failed" }, { ...settings, handoffAlertEnabled: false }, now), false);

  const patched = {
    handoffStatus: "human_required",
    handoffReason: "Audio failed",
    ...handoffAlertPatch({ handoffReason: "Audio failed" }, now),
  };
  assert.equal(shouldSendHandoffAlert(patched, settings, new Date("2026-09-22T04:05:00.000Z")), false);
  assert.equal(shouldSendHandoffAlert(patched, settings, new Date("2026-09-22T04:11:00.000Z")), true);
  assert.equal(shouldSendHandoffAlert({ ...patched, handoffReason: "Order lookup" }, settings, new Date("2026-09-22T04:05:00.000Z")), true);
});

test("handoff alert body includes admin-safe handoff context", () => {
  const body = formatHandoffAlert({
    accountId: "SHAWN",
    customer: { phone: "6737342742", handoffReason: "Customer sent audio; media understanding failed." },
    customerId: "20053605003509@lid",
    productName: "PY1-PUSSY",
    lastCustomerMessage: "[Customer sent a voice message]",
    now: new Date("2026-09-22T04:00:00.000Z"),
  });
  assert.match(body, /AI handoff needed/);
  assert.match(body, /Account: SHAWN/);
  assert.match(body, /Customer: 6737342742/);
  assert.match(body, /Customer ID: 20053605003509@lid/);
  assert.match(body, /Product: PY1-PUSSY/);
  assert.match(body, /Reason: Customer sent audio; media understanding failed\./);
  assert.match(body, /Last customer message: \[Customer sent a voice message\]/);
});
