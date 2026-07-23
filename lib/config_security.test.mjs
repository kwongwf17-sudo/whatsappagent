import assert from "node:assert/strict";
import test from "node:test";
import { validateProductionConfig } from "./config_security.mjs";

test("production config reports insecure defaults without blocking startup by default", () => {
  const warnings = validateProductionConfig({
    demoMode: false,
    adminPassword: "admin123",
    adminSessionSecret: "demo_session_secret",
    verifyToken: "demo_verify_token",
    appSecret: "",
  }, {});

  assert.equal(warnings.some((item) => item.includes("ADMIN_PASSWORD")), true);
  assert.equal(warnings.some((item) => item.includes("ADMIN_SESSION_SECRET")), true);
  assert.equal(warnings.some((item) => item.includes("WHATSAPP_VERIFY_TOKEN")), true);
  assert.equal(warnings.some((item) => item.includes("WHATSAPP_APP_SECRET")), true);
});

test("strict production config rejects insecure defaults and missing env values", () => {
  assert.throws(
    () => validateProductionConfig({
      demoMode: false,
      adminPassword: "admin123",
      adminSessionSecret: "demo_session_secret",
      verifyToken: "demo_verify_token",
      appSecret: "",
    }, { STRICT_PRODUCTION_CONFIG: "true" }),
    /ADMIN_PASSWORD[\s\S]*ADMIN_SESSION_SECRET[\s\S]*WHATSAPP_VERIFY_TOKEN[\s\S]*WHATSAPP_APP_SECRET/
  );
});

test("production config accepts explicit strong secrets", () => {
  const env = {
    ADMIN_PASSWORD: "very-strong-admin-password",
    ADMIN_SESSION_SECRET: "a".repeat(40),
    WHATSAPP_VERIFY_TOKEN: "verify-token-live-123",
    WHATSAPP_APP_SECRET: "b".repeat(40),
  };

  assert.deepEqual(validateProductionConfig({
    demoMode: false,
    adminPassword: env.ADMIN_PASSWORD,
    adminSessionSecret: env.ADMIN_SESSION_SECRET,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    appSecret: env.WHATSAPP_APP_SECRET,
  }, env), []);
});

test("production follow-up worker does not require HTTP admin or webhook secrets", () => {
  assert.deepEqual(validateProductionConfig({
    demoMode: false,
    skipHttpServer: true,
    adminPassword: "",
    adminSessionSecret: "",
    verifyToken: "",
    appSecret: "",
  }, {}), []);
});

test("demo config may use local defaults", () => {
  assert.deepEqual(validateProductionConfig({
    demoMode: true,
    adminPassword: "admin123",
    adminSessionSecret: "demo_session_secret",
    verifyToken: "demo_verify_token",
    appSecret: "",
  }, {}), []);
});
