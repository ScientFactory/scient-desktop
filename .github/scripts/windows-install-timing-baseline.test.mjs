import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import {
  RELEASE_WORKFLOW,
  TIMING_WORKFLOW,
  describeSource,
  findBaseline,
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
  measurement: { failures: [], median, ...overrides.measurement },
});

/** A repository whose timing artifacts span two pages, newest first within each. */
function fixture(entries) {
  const runs = new Map();
  const records = new Map();
  const artifacts = entries.map(({ timingRun, release, saved }, index) => {
    runs.set(String(timingRun), {
      id: timingRun,
      path: TIMING_WORKFLOW,
      status: "completed",
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
