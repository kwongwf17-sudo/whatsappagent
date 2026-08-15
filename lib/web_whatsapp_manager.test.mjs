import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { WebWhatsAppManager } from "./web_whatsapp_manager.mjs";

test("web manager outbound send does not start QR without saved session", async () => {
  const sessionRootDir = await mkdtemp(path.join(tmpdir(), "wa-web-manager-"));
  const manager = new WebWhatsAppManager({
    sessionRootDir,
    logger: { log() {}, warn() {}, error() {} },
  });

  await assert.rejects(
    () => manager.send("allen", "6731234567", { type: "text", body: "hello" }),
    /WhatsApp Web transport is not connected \(disabled\)/
  );

  const status = manager.getStatus("allen");
  assert.equal(status.status, "disabled");
  assert.equal(status.started, false);
  assert.equal(status.hasSocket, false);
  assert.equal(status.hasQrTimeoutTimer, false);
});
