const assert = require("node:assert/strict");
const test = require("node:test");
const { GATED, JOBS, jobFailures } = require("./ci-check.cjs");

function normal(eventName = "pull_request", qualifyingPr = true) {
  const needs = Object.fromEntries(
    [...JOBS, "qualification"].map((job) => [job, { result: "success", outputs: {} }]),
  );
  if (eventName !== "merge_group") needs.queue_ci.result = "skipped";
  if (eventName === "push" || !qualifyingPr) needs.qualification.result = "skipped";
  for (const job of ["test_web_reused", "test_server_reused"]) needs[job].result = "skipped";
  return { needs, options: { eventName, qualifyingPr } };
}
const failures = (f) => jobFailures(f.needs, f.options);

test("all events require successful applicable jobs and permit only expected housekeeping skips", () => {
  for (const event of ["pull_request", "merge_group", "push"]) {
    const f = normal(event);
    assert.deepEqual(failures(f), []);
    for (const job of Object.keys(f.needs)) {
      const original = f.needs[job].result;
      for (const result of ["failure", "cancelled", "unknown"]) {
        f.needs[job].result = result;
        assert.ok(
          failures(f).some((error) => error.includes(job)),
          `${event}: ${job}: ${result}`,
        );
      }
      f.needs[job].result = original;
    }
  }
  assert.deepEqual(failures(normal("pull_request", false)), []);
});

test("every conditional lane needs explicit false outputs from a successful Changes job", () => {
  for (const [job, keys] of Object.entries(GATED)) {
    const f = normal();
    f.needs[job].result = "skipped";
    assert.ok(failures(f).some((error) => error.includes(job)));
    for (const key of keys) f.needs.changes.outputs[key] = "false";
    assert.deepEqual(failures(f), []);
    for (const key of keys) {
      f.needs.changes.outputs[key] = "true";
      assert.ok(failures(f).some((error) => error.includes(job)));
      f.needs.changes.outputs[key] = "false";
    }
    f.needs.changes.result = "failure";
    assert.ok(failures(f).some((error) => error.includes(`${job}: skipped`)));
  }
});

test("focused qualification and queue reuse require their successful source and reporters", () => {
  for (const mode of ["focused", "reused"]) {
    const f = normal(mode === "focused" ? "pull_request" : "merge_group");
    for (const job of ["changes", "lint", ...Object.keys(GATED)]) f.needs[job].result = "skipped";
    if (mode === "focused") {
      f.needs.release_notes.outputs.qualified = "true";
      f.needs.qualification.result = "skipped";
    } else {
      f.needs.queue_ci.outputs = { reused: "true", web_reports: "true", server_reports: "false" };
    }
    for (const job of ["test_web_reused", "test_server_reused"]) f.needs[job].result = "success";
    assert.deepEqual(failures(f), []);
    f.needs.test_web_reused.result = "skipped";
    assert.ok(failures(f).some((error) => error.includes("test_web_reused")));
    f.needs.test_web_reused.result = "success";
    const source = mode === "focused" ? "release_notes" : "queue_ci";
    f.needs[source].result = "failure";
    assert.ok(failures(f).some((error) => error.includes("lint: skipped")));
  }
});

test("main cannot use focused/reused shortcuts; unknown and missing jobs fail closed", () => {
  const f = normal("push");
  f.needs.release_notes.outputs.qualified = "true";
  f.needs.queue_ci.outputs.reused = "true";
  f.needs.lint.result = "skipped";
  assert.ok(failures(f).some((error) => error.includes("lint")));
  f.needs.test_server.result = "skipped";
  f.needs.changes.outputs.test_server = "false";
  assert.ok(failures(f).some((error) => error.includes("test_server")));
  f.needs.new_lane = { result: "success" };
  assert.ok(failures(f).includes("Unknown CI job: new_lane"));
  delete f.needs.build;
  assert.ok(failures(f).includes("build: missing"));
});

test("the gate CLI requires the main PR receipt using the workflow's environment flag", () => {
  const { spawnSync } = require("node:child_process");
  const path = require("node:path");
  const f = normal();
  f.needs.qualification.result = "skipped";
  for (const qualifying of ["true", "false"]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, "ci-check.cjs")], {
      env: {
        ...process.env,
        RESULTS: JSON.stringify(f.needs),
        GITHUB_EVENT_NAME: "pull_request",
        QUALIFYING_PR: qualifying,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, qualifying === "true" ? 1 : 0, result.stderr);
  }
});

test("CI refuses missing native analyzers instead of accepting SwiftLint's optional local skip", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const source = fs.readFileSync(path.join(__dirname, "../workflows/ci.yml"), "utf8");
  const block = source.match(
    /- name: Verify mobile native static analysis tools\n        run: \|\n((?: {10}.*\n)+)/,
  )?.[1];
  assert.ok(block, "CI must preserve the mandatory analyzer preflight");
  const script = block
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ci-analyzer-tools-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tools = ["swiftlint", "ktlint", "detekt"];
  for (const missing of [null, ...tools]) {
    for (const tool of tools) {
      const file = path.join(directory, tool);
      fs.rmSync(file, { force: true });
      if (tool !== missing) fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    }
    const restrictPath =
      'if command -v cygpath >/dev/null; then PATH="$(cygpath -u "$1")"; else PATH="$1"; fi\n';
    const result = spawnSync("bash", ["-c", restrictPath + script, "ci-analyzers", directory], {
      encoding: "utf8",
    });
    assert.equal(result.status, missing === null ? 0 : 1, result.stderr);
  }
});
