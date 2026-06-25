import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import { WebWhatsAppTransport } from "./web_whatsapp_transport.mjs";

test("web transport sends local image files as bytes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wa-web-transport-"));
  const imagePath = path.join(dir, "sample.png");
  const bytes = Buffer.from([1, 2, 3, 4]);
  await writeFile(imagePath, bytes);

  const calls = [];
  const transport = new WebWhatsAppTransport({ sessionDir: dir });
  transport.status = "connected";
  transport.sock = {
    async sendMessage(jid, payload) {
      calls.push({ jid, payload });
      return { key: { id: "msg_local" } };
    },
  };

  const messageId = await transport.send("6731234567", {
    type: "image",
    url: imagePath,
    caption: "hello",
  });

  assert.equal(messageId, "msg_local");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].jid, "6731234567@s.whatsapp.net");
  assert.deepEqual(calls[0].payload.image.buffer, bytes);
  assert.equal(calls[0].payload.caption, "hello");
});

test("web transport keeps remote image URLs as URLs", async () => {
  const calls = [];
  const transport = new WebWhatsAppTransport({ sessionDir: tmpdir() });
  transport.status = "connected";
  transport.sock = {
    async sendMessage(jid, payload) {
      calls.push({ jid, payload });
      return { key: { id: "msg_remote" } };
    },
  };

  const messageId = await transport.send("6731234567", {
    type: "image",
    url: "https://example.com/image.png",
    caption: "",
  });

  assert.equal(messageId, "msg_remote");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.image.url, "https://example.com/image.png");
});
