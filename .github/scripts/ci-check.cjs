// SCIENT-FORK:START — one required gate covers upstream lanes and Scient qualification.
const GATED = {
  rust: ["rust"],
  release_smoke: ["release_smoke"],
  mobile_native_static_analysis: ["mobile_native"],
  compute_native: ["compute_changed"],
  windows_packaging: ["windows_changed"],
  remote_server_packaging: ["windows_changed"],
  linux_packaging: ["linux_changed"],
};
const REPORTERS = ["test_web_reused", "test_server_reused"];
const ALWAYS = ["changes", "lint", "build", "test", "test_web", "test_server"];
const JOBS = ["release_notes", "queue_ci", ...ALWAYS, ...Object.keys(GATED), ...REPORTERS];

function jobFailures(needs, { eventName, qualifyingPr = false, receipt = false }) {
  const expected = receipt ? JOBS : [...JOBS, "qualification"];
  const reused =
    eventName === "merge_group" &&
    needs.queue_ci?.result === "success" &&
    needs.queue_ci.outputs?.reused === "true";
  const gates =
    eventName !== "push" && needs.changes?.result === "success"
      ? (needs.changes.outputs ?? {})
      : {};
  const errors = Object.keys(needs)
    .filter((job) => !expected.includes(job))
    .map((job) => `Unknown CI job: ${job}`);
  if (
    reused &&
    ["web", "server"].some(
      (suite) => !["true", "false"].includes(needs.queue_ci.outputs[`${suite}_reports`]),
    )
  )
    errors.push("Reused report coverage is missing");
  for (const job of expected) {
    const result = needs[job]?.result;
    const reporting = REPORTERS.includes(job);
    const qualify = eventName === "merge_group" || (eventName === "pull_request" && qualifyingPr);
    let skip = false;
    if (job === "queue_ci") skip = eventName !== "merge_group";
    else if (job === "qualification") skip = !qualify;
    else if (reporting) skip = !reused;
    else if (job !== "release_notes") {
      skip = reused || (GATED[job]?.every((key) => gates[key] === "false") ?? false);
    }
    // Active reporters and receipts must finish; every actual failure/cancellation blocks.
    if (result === "success" || (result === "skipped" && skip)) continue;
    errors.push(`${job}: ${result ?? "missing"}${result === "skipped" ? " without a reason" : ""}`);
  }
  return errors;
}

module.exports = { GATED, JOBS, jobFailures };
if (require.main === module) {
  const needs = JSON.parse(process.env.RESULTS);
  for (const [job, { result }] of Object.entries(needs)) console.log(`${job}: ${result}`);
  const failures = jobFailures(needs, {
    eventName: process.env.GITHUB_EVENT_NAME,
    qualifyingPr: process.env.QUALIFYING_PR === "true",
  });
  for (const failure of failures) console.error(failure);
  if (failures.length) process.exitCode = 1;
}
// SCIENT-FORK:END
