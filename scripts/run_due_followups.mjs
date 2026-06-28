function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

try {
  const baseUrl = argValue("url", `http://127.0.0.1:${process.env.PORT || 3000}`);
  const response = await fetch(`${baseUrl.replace(/\/+$/g, "")}/internal/followups/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      now: argValue("now"),
      respectOperationalControl: !process.argv.includes("--ignore-automation-block"),
    }),
  });
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!contentType.includes("application/json")) {
    throw new Error(`Expected JSON from ${response.url}, got HTTP ${response.status} ${contentType}: ${text.slice(0, 300)}`);
  }
  const result = JSON.parse(text);
  console.log(JSON.stringify(result, null, 2));
  process.exit(response.ok ? 0 : 1);
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}
