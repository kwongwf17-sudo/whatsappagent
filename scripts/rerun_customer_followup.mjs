function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const customerId = argValue("customer");
if (!customerId) {
  console.error("Usage: node scripts/rerun_customer_followup.mjs --customer=<whatsapp-id> [--account=<account-id>] [--key=<followup-key>] [--allow-sent] [--url=<server-url>] [--direct]");
  process.exit(1);
}

try {
  const direct = process.argv.includes("--direct");
  let result;
  if (direct) {
    process.env.WHATSAPP_SKIP_HTTP = "true";
    const { sendCustomerFollowupNow } = await import("../server.mjs");
    result = await sendCustomerFollowupNow(customerId, {
      businessAccountId: argValue("account"),
      followupKey: argValue("key"),
      allowAlreadySent: process.argv.includes("--allow-sent"),
      respectOperationalControl: !process.argv.includes("--ignore-automation-block"),
    });
  } else {
    const baseUrl = argValue("url", `http://127.0.0.1:${process.env.PORT || 3000}`);
    const response = await fetch(`${baseUrl.replace(/\/+$/g, "")}/admin/followups/customer/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerId,
        account: argValue("account"),
        key: argValue("key"),
        allowAlreadySent: process.argv.includes("--allow-sent"),
        respectOperationalControl: !process.argv.includes("--ignore-automation-block"),
      }),
    });
    result = await response.json();
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.sent ? 0 : 2);
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}
