process.env.WHATSAPP_SKIP_HTTP = "true";

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const customerId = argValue("customer");
if (!customerId) {
  console.error("Usage: node scripts/rerun_customer_followup.mjs --customer=<whatsapp-id> [--account=<account-id>] [--key=<followup-key>] [--allow-sent]");
  process.exit(1);
}

const { sendCustomerFollowupNow } = await import("../server.mjs");

try {
  const result = await sendCustomerFollowupNow(customerId, {
    businessAccountId: argValue("account"),
    followupKey: argValue("key"),
    allowAlreadySent: process.argv.includes("--allow-sent"),
    respectOperationalControl: !process.argv.includes("--ignore-automation-block"),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.sent ? 0 : 2);
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}
