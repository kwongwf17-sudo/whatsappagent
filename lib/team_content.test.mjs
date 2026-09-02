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

test("team content compacts transient extraction batch results on save and load", async () => {
  const dataDir = await mkdtemp(path.resolve("data/.team-content-compact-test-"));
  try {
    const defaults = {
      catalog: { default_product_id: "", products: [] },
      faqLibrary: { approved_faqs: [] },
      salesReplyLibrary: { sales_replies: [] },
      followupSettings: {},
    };
    const adapter = new MemoryJsonAdapter();
    const store = new TeamContentStore(dataDir, { adapter });
    const bulkyContent = {
      catalog: {
        default_product_id: "book",
        products: [
          {
            id: "book",
            name: "Book",
            persisted_images: {
              salesPhoto: {
                mediaKey: "media_asset_team_a_book_salesPhoto",
                dataUrl: "data:image/png;base64,abc",
                durableUrl: "/persisted-assets/team_a/book/salesPhoto.png",
              },
              legacyOnly: {
                dataUrl: "data:image/png;base64,keep-legacy",
                durableUrl: "/persisted-assets/team_a/book/legacyOnly.png",
              },
            },
            extracted_knowledge: {
              approvedImages: [{ id: "approved_1", summary: "Keep this knowledge" }],
              lastExtraction: {
                status: "completed",
                imagesProcessed: 2,
                imagesCompleted: 2,
                results: [
                  { slot: "image1", url: "/persisted-assets/team/book/image1.jpg", extracted_text: "large raw detail" },
                ],
              },
            },
          },
        ],
      },
      faqLibrary: { approved_faqs: [] },
      salesReplyLibrary: { sales_replies: [] },
      followupSettings: {},
    };

    await store.saveContent("team_a", bulkyContent);
    const saved = adapter.documents.get("team_content_team_a");
    assert.equal(saved.catalog.products[0].extracted_knowledge.lastExtraction.status, "completed");
    assert.equal(saved.catalog.products[0].extracted_knowledge.lastExtraction.results, undefined);
    assert.equal(saved.catalog.products[0].extracted_knowledge.approvedImages[0].summary, "Keep this knowledge");
    assert.equal(saved.catalog.products[0].persisted_images.salesPhoto.dataUrl, undefined);
    assert.equal(saved.catalog.products[0].persisted_images.legacyOnly.dataUrl, "data:image/png;base64,keep-legacy");

    adapter.documents.set("team_content_team_b", structuredClone(bulkyContent));
    const loaded = await store.getContent("team_b", defaults);
    assert.equal(loaded.catalog.products[0].extracted_knowledge.lastExtraction.results, undefined);
    assert.equal(adapter.documents.get("team_content_team_b").catalog.products[0].extracted_knowledge.lastExtraction.results, undefined);
    assert.equal(adapter.documents.get("team_content_team_b").catalog.products[0].persisted_images.salesPhoto.dataUrl, undefined);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("team content can use account and per-product table storage", async () => {
  const dataDir = await mkdtemp(path.resolve("data/.team-content-table-test-"));
  try {
    const defaults = {
      catalog: { default_product_id: "starter", products: [{ id: "starter", name: "Starter Product" }] },
      faqLibrary: { approved_faqs: [] },
      salesReplyLibrary: { sales_replies: [] },
      followupSettings: {},
    };
    const adapter = new MemoryTeamContentTableAdapter();
    const store = new TeamContentStore(dataDir, { adapter });

    const teamA = await store.getContent("ALLEN", defaults);
    teamA.catalog.products.push({ id: "second", name: "Second Product", sku: "EX2" });
    await store.saveContent("ALLEN", teamA);
    await store.getContent("allen", defaults);

    assert.equal(adapter.accounts.has("ALLEN"), true);
    assert.equal(adapter.products.get("ALLEN").length, 2);
    assert.equal(adapter.products.get("allen").length, 1);
    assert.equal(adapter.documents.has("team_content_ALLEN"), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

class MemoryTeamContentTableAdapter {
  teamContentTableEnabled = true;
  accounts = new Map();
  products = new Map();
  documents = new Map();

  async getTeamContentRecord(accountId, defaults = null) {
    if (!this.accounts.has(accountId)) return null;
    return {
      ...structuredClone(this.accounts.get(accountId)),
      catalog: {
        ...(defaults?.catalog || {}),
        default_product_id: this.accounts.get(accountId).catalog?.default_product_id || "",
        products: structuredClone(this.products.get(accountId) || []),
      },
    };
  }

  async saveTeamContentRecord(accountId, content = {}) {
    const saved = structuredClone(content);
    const products = Array.isArray(saved.catalog?.products) ? saved.catalog.products : [];
    this.accounts.set(accountId, {
      ...saved,
      catalog: { ...(saved.catalog || {}), products: [] },
      updatedAt: new Date().toISOString(),
    });
    this.products.set(accountId, structuredClone(products));
    return structuredClone({ ...saved, catalog: { ...(saved.catalog || {}), products } });
  }

  async readJsonIfExists(filePath) {
    const key = path.basename(filePath, ".json");
    return this.documents.has(key) ? structuredClone(this.documents.get(key)) : null;
  }
}

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
