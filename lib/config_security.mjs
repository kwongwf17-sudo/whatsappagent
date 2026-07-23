const WEAK_SECRET_VALUES = new Set([
  "",
  "admin",
  "admin123",
  "password",
  "password123",
  "demo",
  "demo_verify_token",
  "demo_session_secret",
  "changeme",
  "change_me",
  "replace_me",
  "secret",
  "test",
]);

export function validateProductionConfig(config = {}, env = process.env) {
  if (config.demoMode) return [];

  const errors = [];
  const workerOnly = Boolean(config.skipHttpServer);
  if (!workerOnly) {
    validateSecret(errors, "ADMIN_PASSWORD", config.adminPassword, env.ADMIN_PASSWORD, { minLength: 12 });
    validateSecret(errors, "ADMIN_SESSION_SECRET", config.adminSessionSecret, env.ADMIN_SESSION_SECRET, { minLength: 32 });
    validateSecret(errors, "WHATSAPP_VERIFY_TOKEN", config.verifyToken, env.WHATSAPP_VERIFY_TOKEN, { minLength: 16 });
    validateSecret(errors, "WHATSAPP_APP_SECRET", config.appSecret, env.WHATSAPP_APP_SECRET, { minLength: 32 });
  }

  if (errors.length) {
    throw new Error(`Production configuration is insecure:\n${errors.map((item) => `- ${item}`).join("\n")}`);
  }

  return [];
}

function validateSecret(errors, name, configuredValue, rawEnvValue, options = {}) {
  const value = String(configuredValue || "").trim();
  const raw = String(rawEnvValue || "").trim();
  const minLength = Number(options.minLength || 1);

  if (!raw || !value) {
    errors.push(`${name} must be set when DEMO_MODE=false.`);
    return;
  }
  if (value.length < minLength) {
    errors.push(`${name} must be at least ${minLength} characters when DEMO_MODE=false.`);
  }
  if (isKnownWeakSecret(value)) {
    errors.push(`${name} must not use a demo, default, or weak value.`);
  }
}

function isKnownWeakSecret(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return WEAK_SECRET_VALUES.has(normalized) || /^(replace_|change_me|demo_|test_)/i.test(normalized);
}
