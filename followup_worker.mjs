process.env.WHATSAPP_SKIP_HTTP = "true";

const { config, requestFollowupRun } = await import("./server.mjs");

const intervalMs = Math.max(config.followupIntervalMinutes, 1) * 60 * 1000;

console.log(`Follow-up worker started. Interval: ${Math.round(intervalMs / 1000)}s`);

async function runOnce() {
  try {
    const result = await requestFollowupRun();
    console.log(
      JSON.stringify({
        checkedAt: result.checkedAt,
        sent: result.sent,
        queued: result.queued,
        queueFailed: result.queueFailed,
        queueCancelled: result.queueCancelled,
        heldForApprovedTemplate: result.heldForApprovedTemplate + result.queueHeldForApprovedTemplate,
        deleted: result.deleted,
        blockedReason: result.blockedReason || "",
        pausedUntil: result.pausedUntil || "",
      })
    );
  } catch (error) {
    console.error("followup_worker_run:", error);
  }
}

await runOnce();
setInterval(runOnce, intervalMs);
