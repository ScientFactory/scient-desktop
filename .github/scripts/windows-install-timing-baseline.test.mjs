import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import {
  RELEASE_WORKFLOW,
  TIMING_WORKFLOW,
  artifactMismatch,
  baselineInstaller,
  describeSource,
  findBaseline,
  installerVersion,
  waitForInstaller,
} from "./windows-install-timing-baseline.mjs";

const REPOSITORY = "ScientFactory/scient-desktop";
const releaseRun = (id, branch, overrides = {}) => ({
  id,
  path: RELEASE_WORKFLOW,
  event: "workflow_dispatch",
  head_branch: branch,
  head_sha: "a".repeat(40),
  status: "completed",
  conclusion: "success",
  created_at: `2026-11-${String(id % 100).padStart(2, "0")}T00:00:00Z`,
  ...overrides,
});
const median = { installMs: 30_000, firstLaunchMs: 9_000, secondLaunchMs: 7_000 };
const record = (installerRun, version, overrides = {}) => ({
  schemaVersion: 2,
  context: {
    ...describeSource({ run: installerRun, artifact: "desktop-win-x64", version }),
    ...overrides.context,
  },
  measurement: { failures: [], median, complete: true, ...overrides.measurement },
});

/** A repository whose timing artifacts span two pages, newest first within each. */
function fixture(entries) {
  const runs = new Map();
  const records = new Map();
  const artifacts = entries.map(({ timingRun, conclusion = "success", release, saved }, index) => {
    runs.set(String(timingRun), {
      id: timingRun,
      path: TIMING_WORKFLOW,
      status: "completed",
      conclusion,
    });
    if (release) runs.set(String(release.id), release);
    records.set(String(timingRun), saved);
    return {
      name: "windows-install-timing",
      expired: false,
      created_at: `2026-11-27T${String(23 - index).padStart(2, "0")}:00:00Z`,
      workflow_run: { id: timingRun },
    };
  });
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "timing-baseline-"));
  return {
    api(path, { paginate = false } = {}) {
      if (path.includes("/artifacts?")) {
        NodeAssert.ok(paginate, "the artifact list must be paginated");
        return [{ artifacts: artifacts.slice(3) }, { artifacts: artifacts.slice(0, 3) }];
      }
      const run = runs.get(path.split("/").at(-1));
      if (!run) throw new Error(`HTTP 404: ${path}`);
      return run;
    },
    download(id) {
      const file = NodePath.join(directory, `${id}.json`);
      NodeFS.writeFileSync(file, JSON.stringify(records.get(id)));
      return file;
    },
  };
}

const find = (repository, context, log = () => {}) =>
  findBaseline({
    ...repository,
    repository: REPOSITORY,
    context,
    deadline: Number.POSITIVE_INFINITY,
    log,
  });

NodeTest.test("a Stable timing takes the newest earlier successful Stable release's record", () => {
  const stable = (id, overrides) => releaseRun(id, "release/stable", overrides);
  const current = describeSource({
    run: stable(26, { status: "in_progress", conclusion: null }),
    artifact: "desktop-win-x64",
    version: "0.6.36",
    runId: "900",
  });
  const beta = releaseRun(25, "main");
  const unfinished = stable(24, { status: "in_progress", conclusion: null });
  const rehearsal = releaseRun(23, "release-rehearsal/x");
  const partial = stable(22);
  const accepted = stable(21);
  const reasons = [];
  const file = find(
    fixture([
      { timingRun: 900, release: null, saved: record(stable(26), "0.6.36") },
      { timingRun: 801, release: beta, saved: record(beta, "0.6.36-beta.1") },
      { timingRun: 802, release: unfinished, saved: record(unfinished, "0.6.35") },
      { timingRun: 803, release: rehearsal, saved: record(rehearsal, "0.0.12") },
      {
        timingRun: 804,
        release: partial,
        saved: record(partial, "0.6.35", {
          measurement: { median: { ...median, secondLaunchMs: null } },
        }),
      },
      { timingRun: 805, release: accepted, saved: record(accepted, "0.6.34") },
    ]),
    current,
    (line) => reasons.push(line),
  );
  NodeAssert.equal(JSON.parse(NodeFS.readFileSync(file, "utf8")).context.version, "0.6.34");
  NodeAssert.deepEqual(reasons.slice(1), [
    "run 801: skipped, beta channel, not stable",
    "run 802: skipped, its release run is in_progress",
    "run 803: skipped, a rehearsal",
    "run 804: skipped, it lacks a median",
    "run 805: 0.6.34, accepted",
  ]);
});

NodeTest.test("a record whose labels disagree with its release run is not trusted", () => {
  const beta = releaseRun(25, "main");
  const forged = record(beta, "0.6.35", { context: { channel: "stable" } });
  const manual = record(releaseRun(24, "release/stable"), "0.6.34", {
    context: { kind: "manual" },
  });
  const reasons = [];
  const file = find(
    fixture([
      { timingRun: 801, release: beta, saved: forged },
      { timingRun: 802, release: releaseRun(24, "release/stable"), saved: manual },
    ]),
    describeSource({ installerUrl: "https://example.test/Scient.exe", runId: "900" }),
    (line) => reasons.push(line),
  );
  NodeAssert.equal(file, null);
  NodeAssert.deepEqual(reasons.slice(1), [
    "run 801: skipped, its release run built beta, not stable",
    "run 802: skipped, not a release installer",
  ]);
});

NodeTest.test("a timing that did not finish every sample is never the baseline", () => {
  const stable = (id) => releaseRun(id, "release/stable");
  const reasons = [];
  const file = find(
    fixture([
      // Stopped after a good first sample: the record shows medians and no failures.
      {
        timingRun: 801,
        conclusion: "failure",
        release: stable(25),
        saved: record(stable(25), "0.6.35"),
      },
      {
        timingRun: 802,
        release: stable(24),
        saved: record(stable(24), "0.6.35", { measurement: { complete: false } }),
      },
      { timingRun: 803, release: stable(23), saved: record(stable(23), "0.6.34") },
    ]),
    describeSource({ installerUrl: "https://example.test/Scient.exe", runId: "900" }),
    (line) => reasons.push(line),
  );
  NodeAssert.equal(JSON.parse(NodeFS.readFileSync(file, "utf8")).context.version, "0.6.34");
  NodeAssert.deepEqual(reasons.slice(1), [
    "run 801: skipped, its timing run concluded failure",
    "run 802: skipped, its measurement did not record finishing every sample",
    "run 803: 0.6.34, accepted",
  ]);
});

NodeTest.test("an artifact ID counts only for the named artifact of the named run", () => {
  const artifact = { id: 5, name: "desktop-win-x64", workflow_run: { id: 26 } };
  NodeAssert.equal(artifactMismatch(artifact, "26", "desktop-win-x64"), null);
  NodeAssert.equal(
    artifactMismatch(artifact, "27", "desktop-win-x64"),
    "it belongs to run 26, not 27",
  );
  NodeAssert.equal(
    artifactMismatch({ ...artifact, name: "desktop-mac-x64" }, "26", "desktop-win-x64"),
    "it is desktop-mac-x64, not desktop-win-x64",
  );
});

NodeTest.test("a re-check fetches the exact upload the baseline timed, by its SHA-256", () => {
  const sha256 = "b".repeat(64);
  const timed = (artifactId) => ({
    context: describeSource({
      run: releaseRun(26, "main"),
      artifact: "desktop-win-x64",
      artifactId,
    }),
    measurement: { installer: { sha256 } },
  });
  NodeAssert.deepEqual(baselineInstaller(timed("15186606051")), {
    runId: "26",
    artifact: "desktop-win-x64",
    artifactId: "15186606051",
    sha256,
  });
  // A record from before artifact IDs were saved can only name the artifact.
  NodeAssert.equal(baselineInstaller(timed("")).artifactId, "");
  NodeAssert.equal(
    baselineInstaller({ ...timed("15186606051"), measurement: { installer: {} } }),
    "the baseline records no installer SHA-256",
  );
});

NodeTest.test("a Beta timing compares only with an earlier Beta", () => {
  const current = describeSource({
    run: releaseRun(26, "main"),
    artifact: "desktop-win-x64",
    version: "0.6.36-beta.2",
    runId: "900",
  });
  const file = find(
    fixture([
      {
        timingRun: 801,
        release: releaseRun(25, "release/stable"),
        saved: record(releaseRun(25, "release/stable"), "0.6.35"),
      },
      {
        timingRun: 802,
        release: releaseRun(24, "main"),
        saved: record(releaseRun(24, "main"), "0.6.36-beta.1"),
      },
    ]),
    current,
  );
  NodeAssert.equal(JSON.parse(NodeFS.readFileSync(file, "utf8")).context.version, "0.6.36-beta.1");
});

NodeTest.test("a failed lookup warns and falls back to the committed baseline", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "timing-baseline-cli-"));
  const bin = NodePath.join(directory, "bin");
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(
    NodePath.join(bin, "gh"),
    "#!/bin/sh\necho 'HTTP 502: Bad Gateway' >&2\nexit 1\n",
    {
      mode: 0o755,
    },
  );
  const context = NodePath.join(directory, "context.json");
  NodeFS.writeFileSync(
    context,
    JSON.stringify(describeSource({ installerUrl: "https://x.test/a.exe" })),
  );
  const output = NodePath.join(directory, "output");
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(import.meta.dirname, "windows-install-timing-baseline.mjs"),
      "find",
      "--context",
      context,
      "--committed",
      "committed.json",
      "--dir",
      directory,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${NodePath.delimiter}${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: REPOSITORY,
      },
    },
  );
  NodeAssert.equal(result.status, 0, result.stderr);
  NodeAssert.match(result.stdout, /::warning .*HTTP 502: Bad Gateway/u);
  NodeAssert.equal(NodeFS.readFileSync(output, "utf8"), "file=committed.json\ncommitted=true\n");
});

/**
 * A release attempt whose state moves one step per poll: `states[i]` is `{ run, job, artifacts }`
 * (the attempt's status/conclusion, the Package job's or none, and the run's listed uploads) or
 * an Error for a failed poll.
 */
function releaseAttempt(states) {
  let poll = -1;
  let clock = 0;
  const calls = [];
  const state = () => states[Math.min(poll, states.length - 1)];
  const api = (path, { paginate = false } = {}) => {
    calls.push(path);
    if (path.endsWith("/attempts/2")) {
      poll += 1;
      if (state() instanceof Error) throw state();
      return { id: 26, run_attempt: 2, ...state().run };
    }
    if (path.includes("/attempts/2/jobs?")) {
      NodeAssert.ok(paginate, "the job list must be paginated");
      const { job } = state();
      const other = { name: "Package macOS arm64", status: "completed", conclusion: "success" };
      return [{ jobs: job ? [other, { name: "Package Windows x64", ...job }] : [other] }];
    }
    if (path.includes("/artifacts?name=desktop-win-x64")) return { artifacts: state().artifacts };
    throw new Error(`HTTP 404: ${path}`);
  };
  return {
    calls,
    wait: (overrides = {}) =>
      waitForInstaller({
        api,
        repository: REPOSITORY,
        runId: "26",
        attempt: "2",
        now: () => clock,
        sleep: (ms) => {
          clock += ms;
        },
        deadline: 90 * 60_000,
        log: () => {},
        ...overrides,
      }),
  };
}
const running = { status: "in_progress", conclusion: null };
const started = "2026-11-27T10:00:00Z";

NodeTest.test("the timing waits for this attempt's packaged installer and takes its upload", () => {
  const done = { status: "completed", conclusion: "success", started_at: started };
  // The first attempt's upload of the same name stays listed for the run.
  const earlier = {
    id: 11,
    name: "desktop-win-x64",
    expired: false,
    created_at: "2026-11-27T09:30:00Z",
  };
  const current = {
    id: 12,
    name: "desktop-win-x64",
    expired: false,
    created_at: "2026-11-27T10:20:00Z",
  };
  const release = releaseAttempt([
    { run: running },
    { run: running, job: { status: "in_progress", conclusion: null, started_at: started } },
    // This attempt's upload is not listed yet: the earlier one must not stand in for it.
    { run: running, job: done, artifacts: [earlier] },
    { run: running, job: done, artifacts: [earlier, current] },
  ]);
  NodeAssert.deepEqual(release.wait(), { artifactId: "12" });
  NodeAssert.equal(release.calls.filter((path) => path.endsWith("/attempts/2")).length, 4);
});

NodeTest.test("a release that ends before packaging Windows is not timed", () => {
  // Cancelled during preflight: the package matrix was never created.
  const cancelled = releaseAttempt([
    { run: running },
    { run: { status: "completed", conclusion: "cancelled" } },
  ]);
  NodeAssert.deepEqual(cancelled.wait(), {
    skip: "the release ended (cancelled) before Package Windows x64 finished",
  });
  NodeAssert.ok(!cancelled.calls.some((path) => path.includes("/artifacts")));

  const failed = releaseAttempt([
    { run: running, job: { status: "completed", conclusion: "failure", started_at: started } },
  ]);
  NodeAssert.deepEqual(failed.wait(), { skip: "Package Windows x64 ended failure" });
});

NodeTest.test("the wait gives up at its deadline and on an API that keeps failing", () => {
  const slow = releaseAttempt([{ run: running, job: { status: "queued", conclusion: null } }]);
  NodeAssert.deepEqual(slow.wait({ deadline: 10 * 60_000 }), {
    skip: "Package Windows x64 had not finished in time",
  });

  // Failures in a row end the wait; one between successful polls does not.
  const flaky = releaseAttempt([
    new Error("HTTP 502"),
    { run: running },
    new Error("HTTP 502"),
    new Error("HTTP 502"),
    { run: { status: "completed", conclusion: "failure" } },
  ]);
  NodeAssert.deepEqual(flaky.wait({ maxFailures: 3 }), {
    skip: "the release ended (failure) before Package Windows x64 finished",
  });
  const down = releaseAttempt([new Error("HTTP 502")]);
  NodeAssert.throws(() => down.wait({ maxFailures: 3 }), /HTTP 502/u);
});

NodeTest.test("a release installer's version comes from its file name", () => {
  NodeAssert.equal(installerVersion("Scient-0.6.36-x64.exe"), "0.6.36");
  NodeAssert.equal(installerVersion("Scient-0.6.36-beta.2-x64.exe"), "0.6.36-beta.2");
  NodeAssert.equal(installerVersion("Scient-0.6.36-arm64.exe"), null);
  NodeAssert.equal(installerVersion(undefined), null);
});
