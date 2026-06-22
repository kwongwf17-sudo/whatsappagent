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

    const raw = JSON.parse(await readFile(path.join(dataDir, "team_content.json"), "utf8"));
    assert.deepEqual(Object.keys(raw.accounts).sort(), ["team_a", "team_b"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
