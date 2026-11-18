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
const REPORTERS = ["test_web_reused", "test_server_reused", "stable_contexts_reused"];
const ALWAYS = [
  "changes",
  "lint",
  "build",
  "test",
  "test_web",
  "test_server",
  "test_web_performance",
  "test_server_performance",
];
const JOBS = ["queue_ci", ...ALWAYS, "overleaf_windows", ...Object.keys(GATED), ...REPORTERS];
// Evidence and upkeep only: these run beside the gate and never block a merge. Without
// shard_weights every shard uses the checked-in weights, and the shards themselves are gated.
const ADVISORY = ["overleaf_macos", "shard_weights", "main_caches"];

function jobFailures(needs, { eventName, qualifyingPr = false, receipt = false }) {
  const expected = receipt ? JOBS : [...JOBS, "qualification"];
  const probes = eventName === "merge_group" || eventName === "push";
  const reused =
    probes && needs.queue_ci?.result === "success" && needs.queue_ci.outputs?.reused === "true";
  // Main and nightly runs qualify every lane; only PR and queue gates may narrow them.
  const gates =
    (eventName === "pull_request" || eventName === "merge_group") &&
    needs.changes?.result === "success"
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
  const windowsReused = reused && needs.queue_ci.outputs.overleaf_windows === "true";
  for (const job of expected) {
    const result = needs[job]?.result;
    const reporting = REPORTERS.includes(job);
    const qualify = eventName === "merge_group" || (eventName === "pull_request" && qualifyingPr);
    let skip = false;
    if (job === "queue_ci") skip = !probes;
    else if (job === "qualification") skip = !qualify;
    else if (reporting) skip = !reused;
    else if (job === "overleaf_windows") skip = windowsReused;
    else skip = reused || (GATED[job]?.every((key) => gates[key] === "false") ?? false);
    // Active reporters and receipts must finish; every actual failure/cancellation blocks.
    if (result === "success" || (result === "skipped" && skip)) continue;
    errors.push(`${job}: ${result ?? "missing"}${result === "skipped" ? " without a reason" : ""}`);
  }
  return errors;
}

// Test lanes whose failures ci-quarantine.cjs may still accept, failed test by failed test.
// Setup, lint, build and static analysis always block. The receipt fails
// whenever another need does, so it is a candidate only beside them.
const QUARANTINABLE = [
  "test",
  "test_web",
  "test_server",
  "test_web_performance",
  "test_server_performance",
  "overleaf_windows",
  "compute_native",
  "windows_packaging",
  "remote_server_packaging",
  "linux_packaging",
  "qualification",
];

/** True when every failure is a plain test-lane `failure` that the quarantine may explain. */
function quarantineCandidate(needs, failures) {
  if (failures.length === 0) return false;
  const failed = failures.map((failure) => /^([a-z_]+): failure$/.exec(failure)?.[1]);
  return (
    failed.every((job) => job && QUARANTINABLE.includes(job) && needs[job]?.result === "failure") &&
    failed.some((job) => job !== "qualification")
  );
}

module.exports = { ADVISORY, GATED, JOBS, QUARANTINABLE, jobFailures, quarantineCandidate };
if (require.main === module) {
  const needs = JSON.parse(process.env.RESULTS);
  for (const [job, { result }] of Object.entries(needs)) console.log(`${job}: ${result}`);
  const failures = jobFailures(needs, {
    eventName: process.env.GITHUB_EVENT_NAME,
    qualifyingPr: process.env.QUALIFYING_PR === "true",
  });
  for (const failure of failures) console.error(failure);
  if (quarantineCandidate(needs, failures)) {
    // The next step reads each failed job and passes only if every failure is quarantined.
    console.log("Only test lanes failed; checking them against the flake quarantine.");
    require("node:fs").appendFileSync(process.env.GITHUB_OUTPUT, "quarantine=candidate\n");
  } else if (failures.length) process.exitCode = 1;
}
// SCIENT-FORK:END
