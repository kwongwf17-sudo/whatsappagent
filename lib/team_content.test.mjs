import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { TeamContentStore } from "./team_content.mjs";

test("team content is seeded once and isolated by account", async () => {
  const dataDir = await mkdtemp(path.resolve("data/.team-content-test-"));
  try {
    const defaults = {
      catalog: {
        default_product_id: "starter",
        products: [{ id: "starter", name: "Starter Product", options: [] }],
      },
      faqLibrary: { approved_faqs: [{ id: "faq_default", approved_reply: "Default FAQ" }] },
      salesReplyLibrary: { sales_replies: [{ id: "sales_default", approved_reply: "Default sales reply" }] },
      followupSettings: {
        orderFormFollowups: {
          hour1: { enabled: true, message: "Default order reminder" },
        },
      },
    };
    const store = new TeamContentStore(dataDir);

    const teamA = await store.getContent("team_a", defaults);
    teamA.catalog.products[0].name = "Team A Product";
    teamA.faqLibrary.approved_faqs[0].approved_reply = "Team A FAQ";
    await store.saveContent("team_a", teamA);

    const teamB = await store.getContent("team_b", defaults);
    assert.equal(teamB.catalog.products[0].name, "Starter Product");
    assert.equal(teamB.faqLibrary.approved_faqs[0].approved_reply, "Default FAQ");

    const teamAAgain = await store.getContent("team_a", defaults);
    assert.equal(teamAAgain.catalog.products[0].name, "Team A Product");
    assert.equal(teamAAgain.salesReplyLibrary.sales_replies[0].approved_reply, "Default sales reply");
    assert.equal(teamAAgain.followupSettings.orderFormFollowups.hour1.enabled, true);
    assert.equal(teamAAgain.followupSettings.orderFormFollowups.hour1.message, "Default order reminder");

    const raw = JSON.parse(await readFile(path.join(dataDir, "team_content.json"), "utf8"));
    assert.deepEqual(Object.keys(raw.accounts).sort(), ["team_a", "team_b"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("team content uses per-account documents when the adapter supports optional reads", async () => {
  const dataDir = await mkdtemp(path.resolve("data/.team-content-adapter-test-"));
  try {
    const defaults = {
      catalog: {
        default_product_id: "starter",
        products: [{ id: "starter", name: "Starter Product", options: [] }],
      },
      faqLibrary: { approved_faqs: [] },
      salesReplyLibrary: { sales_replies: [] },
      followupSettings: {},
    };
    const adapter = new MemoryJsonAdapter();
    const store = new TeamContentStore(dataDir, { adapter });

    const teamA = await store.getContent("team_a", defaults);
    teamA.catalog.products[0].name = "Team A Product";
    await store.saveContent("team_a", teamA);
    await store.getContent("team_b", defaults);

    assert.deepEqual([...adapter.documents.keys()].sort(), ["team_content_team_a", "team_content_team_b"]);
    assert.equal(adapter.documents.get("team_content_team_a").catalog.products[0].name, "Team A Product");
    assert.equal(adapter.documents.get("team_content_team_b").catalog.products[0].name, "Starter Product");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("team content lazily migrates legacy adapter document by account", async () => {
  const dataDir = await mkdtemp(path.resolve("data/.team-content-migrate-test-"));
  try {
    const defaults = {
      catalog: { default_product_id: "", products: [] },
      faqLibrary: { approved_faqs: [] },
      salesReplyLibrary: { sales_replies: [] },
      followupSettings: {},
    };
    const adapter = new MemoryJsonAdapter();
    adapter.documents.set("team_content", {
      accounts: {
        team_a: {
          catalog: { default_product_id: "old", products: [{ id: "old", name: "Migrated Product" }] },
          faqLibrary: { approved_faqs: [] },
          salesReplyLibrary: { sales_replies: [] },
          followupSettings: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const store = new TeamContentStore(dataDir, { adapter });

    const teamA = await store.getContent("team_a", defaults);

    assert.equal(teamA.catalog.products[0].name, "Migrated Product");
    assert.equal(adapter.documents.get("team_content_team_a").catalog.products[0].name, "Migrated Product");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

class MemoryJsonAdapter {
  documents = new Map();

  async readJson(filePath, fallback) {
    const key = path.basename(filePath, ".json");
    if (!this.documents.has(key)) {
      this.documents.set(key, structuredClone(fallback));
    }
    return structuredClone(this.documents.get(key));
  }

  async readJsonIfExists(filePath) {
    const key = path.basename(filePath, ".json");
    return this.documents.has(key) ? structuredClone(this.documents.get(key)) : null;
  }

  async writeJson(filePath, data) {
    const key = path.basename(filePath, ".json");
    this.documents.set(key, structuredClone(data));
  }
}
