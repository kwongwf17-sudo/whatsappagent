import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AdminAccountStore } from "./admin_accounts.mjs";

test("business admin passwords are hashed and access can be managed by super admin", async () => {
  const dataDir = await mkdtemp(path.resolve("whatsapp_agent/data/.admin-accounts-test-"));
  try {
    const store = new AdminAccountStore(dataDir);
    await store.ensureInitialAccount({ id: "demo", name: "Demo Store", password: "bootstrap-password" });

    assert.equal((await store.authenticate("demo", "bootstrap-password")).id, "demo");
    assert.equal((await store.authenticate("demo", "bootstrap-password")).role, "business_admin");
    await store.createAccount({
      id: "second-store",
      name: "Second Store",
      password: "temporary-password",
    });
    await store.createAccount({
      id: "orders-team",
      name: "Orders Team",
      password: "orders-password",
      role: "order_admin",
    });

    const raw = await readFile(path.join(dataDir, "admin_accounts.json"), "utf8");
    assert.doesNotMatch(raw, /bootstrap-password|temporary-password/);
    assert.equal((await store.listAccounts())[1].passwordHash, undefined);

    await store.resetPassword("second-store", "new-secure-password");
    assert.equal(await store.authenticate("second-store", "temporary-password"), null);
    assert.equal((await store.authenticate("second-store", "new-secure-password")).id, "second-store");

    await store.setActive("second-store", false);
    assert.equal(await store.authenticate("second-store", "new-secure-password"), null);
    const controlled = await store.setOperationalControl("demo", { automationPaused: true, testMode: true });
    assert.equal(controlled.automationPaused, true);
    assert.equal(controlled.testMode, true);
    assert.equal((await store.getAccount("demo")).automationPaused, true);
    await assert.rejects(
      store.setOperationalControl("orders-team", { automationPaused: true, testMode: false }),
      /business admin/
    );
    assert.equal(await store.authenticate("orders-team", "orders-password", "business_admin"), null);
    assert.equal((await store.authenticate("orders-team", "orders-password", "order_admin")).role, "order_admin");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
