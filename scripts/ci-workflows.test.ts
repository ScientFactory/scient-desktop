// @effect-diagnostics nodeBuiltinImport:off -- execute the workflow's own conditions against synthetic events.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "@effect/vitest";
import * as YAML from "yaml";
const require = NodeModule.createRequire(import.meta.url);
const { computeQualificationSuites } = require("../.github/scripts/compute-ci-gate.mjs") as {
  computeQualificationSuites: (paths: string[]) => { realKernel: boolean; managedPython: boolean };
};
const { needsLinuxPackaging, needsWindowsPackaging } =
  require("../.github/scripts/windows-packaging-ci-gate.mjs") as {
    needsLinuxPackaging: (paths: string[]) => boolean;
    needsWindowsPackaging: (paths: string[]) => boolean;
  };
const { decide, readWorkspace } = require("../.github/scripts/ci-changes.cjs") as {
  readWorkspace: () => unknown;
  decide: (
    files: string[] | null,
    packages: unknown,
    full: boolean,
  ) => {
    outputs: Record<string, string | boolean>;
  };
};
const { jobFailures } = require("../.github/scripts/ci-check.cjs") as {
  jobFailures: (
    needs: Record<string, JobResult>,
    options: { eventName: string; qualifyingPr: boolean },
  ) => string[];
};
type JobResult = { result: string; outputs: Record<string, string> };
type Job = {
  steps?: Array<{ name?: string; uses?: string; run?: string; env?: Record<string, string> }>;
  if?: string;
  needs?: string | string[];
  strategy?: { matrix: Record<string, unknown[]> };
  with?: Record<string, string>;
  name?: string;
  uses?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
};
const workflow = YAML.parse(
  NodeFS.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as { jobs: Record<string, Job> };

function simulate(
  files: string[],
  eventName = "pull_request",
  reused = false,
  focused = false,
  baseRef = "main",
) {
  const outputs = decide(files, readWorkspace(), eventName === "push").outputs;
  const compute = computeQualificationSuites(files);
  const gates = Object.fromEntries(
    Object.entries({
      ...outputs,
      compute_changed: eventName === "push" || compute.realKernel || compute.managedPython,
      real_kernel: eventName === "push" || compute.realKernel,
      managed_python: eventName === "push" || compute.managedPython,
      windows_changed: eventName === "push" || needsWindowsPackaging(files),
      linux_changed: eventName === "push" || needsLinuxPackaging(files),
    }).map(([key, value]) => [key, String(value)]),
  );
  const needs: Record<string, JobResult> = {};
  const github = {
    event_name: eventName,
    repository: "ScientFactory/scient-desktop",
    event: {
      pull_request: {
        base: { ref: baseRef },
        head: { repo: { full_name: "ScientFactory/scient-desktop" } },
      },
    },
  };
  const pending = new Set(Object.keys(workflow.jobs));
  while (pending.size) {
    let advanced = false;
    for (const id of pending) {
      const job = workflow.jobs[id]!;
      const deps = typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
      if (deps.some((dep) => !needs[dep])) continue;
      const condition = job.if?.replace(/^\$\{\{ | \}\}$/g, "") ?? "true";
      const run = Boolean(
        NodeVM.runInNewContext(condition, {
          needs,
          github,
          cancelled: () => false,
          always: () => true,
        }),
      );
      needs[id] = { result: run ? "success" : "skipped", outputs: {} };
      if (run && id === "release_notes") needs[id].outputs = { qualified: String(focused) };
      if (run && id === "queue_ci")
        needs[id].outputs = {
          reused: String(reused),
          web_reports: "true",
          server_reports: "true",
        };
      if (run && id === "changes") needs[id].outputs = gates;
      pending.delete(id);
      advanced = true;
    }
    if (!advanced) throw new Error("Workflow has a dependency cycle or missing job");
  }
  const gateNeeds = { ...needs };
  delete gateNeeds.check;
  return {
    needs,
    gateNeeds,
    failures: jobFailures(gateNeeds, {
      eventName,
      qualifyingPr: Boolean(
        NodeVM.runInNewContext(
          workflow.jobs
            .check!.steps!.find((step) => step.name === "Require every job to pass")!
            .env!.QUALIFYING_PR!.slice(3, -2),
          { github, needs },
        ),
      ),
    }),
  };
}

// Expand reusable workflows as well as the web/server matrices. This checks runner
// counts against the YAML instead of treating a reusable call as one machine.
function runnerCount(needs: Record<string, JobResult>) {
  const matrixSize = (job: Job) => {
    const matrix = job.strategy?.matrix;
    if (!matrix) return 1;
    if (matrix.include) return matrix.include.length;
    return Object.values(matrix).reduce((count, values) => count * values.length, 1);
  };
  return Object.entries(workflow.jobs).reduce((total, [id, job]) => {
    if (needs[id]!.result !== "success") return total;
    if (!job.uses) return total + matrixSize(job);
    const inputs = Object.fromEntries(
      Object.entries(job.with ?? {}).map(([key, expression]) => [
        key,
        NodeVM.runInNewContext(expression.slice(3, -2), { needs }),
      ]),
    );
    const called = YAML.parse(
      NodeFS.readFileSync(new URL(`../${job.uses}`, import.meta.url), "utf8"),
    ) as { jobs: Record<string, Job> };
    return (
      total +
      Object.values(called.jobs).reduce((count, child) => {
        const run = !child.if || NodeVM.runInNewContext(child.if.slice(3, -2), { inputs });
        return count + (run ? matrixSize(child) : 0);
      }, 0)
    );
  }, 0);
}

describe("CI workflow decisions", () => {
  it("qualifies feature-base PRs without creating a main-only reuse receipt", () => {
    const f = simulate(
      ["apps/web/src/authBootstrap.test.ts"],
      "pull_request",
      false,
      false,
      "feature/parent",
    );
    expect(f.needs.qualification!.result).toBe("skipped");
    expect(f.failures).toEqual([]);
  });

  it.each(["pull_request", "merge_group"])(
    "%s blocks the reported cross-package and documentation regressions",
    (eventName) => {
      for (const [file, consumerJob] of [
        ["apps/mobile/src/features/review/reviewModel.ts", "test"],
        ["packages/scient-analytics/src/wireContract.ts", "test_web"],
        ["docs/fixtures/scient-chat-plotly.md", "test_web"],
        ["packages/client-runtime/src/state/threads.ts", "test_server"],
      ]) {
        const f = simulate([file!], eventName);
        expect(f.needs[consumerJob!]!.result, file).toBe("success");
        expect(f.needs.changes!.outputs.test_packages).toBe("");
        expect(f.failures, file).toEqual([]);
        f.gateNeeds[consumerJob!]!.result = "failure";
        expect(jobFailures(f.gateNeeds, { eventName, qualifyingPr: true })).toContain(
          `${consumerJob}: failure`,
        );
      }
    },
  );

  it("has one required gate covering every job, eight server shards and three hosted web shards", () => {
    expect(workflow.jobs.check).toMatchObject({ name: "Check", if: "${{ always() }}" });
    expect([...(workflow.jobs.check!.needs as string[])].sort()).toEqual(
      Object.keys(workflow.jobs)
        .filter((id) => id !== "check")
        .sort(),
    );
    expect(workflow.jobs.lint!.name).toBe("Lint");
    expect(workflow.jobs.test_server).toMatchObject({
      "timeout-minutes": 15,
      strategy: { matrix: { shard: [1, 2, 3, 4, 5, 6, 7, 8] } },
    });
    expect(workflow.jobs.test_web).toMatchObject({
      "runs-on": "ubuntu-24.04",
      strategy: { matrix: { shard: [1, 2, 3] } },
    });
  });

  it.each([
    [
      "web test",
      ["apps/web/src/authBootstrap.test.ts"],
      "pull_request",
      ["test_server", "test_web", "build", "test"],
      [
        "rust",
        "compute_native",
        "mobile_native_static_analysis",
        "release_smoke",
        "linux_packaging",
        "windows_packaging",
        "remote_server_packaging",
      ],
    ],
    [
      "server test",
      ["apps/server/src/git/GitManager.test.ts"],
      "pull_request",
      ["test_web", "test_server", "build", "test"],
      [
        "rust",
        "compute_native",
        "mobile_native_static_analysis",
        "release_smoke",
        "linux_packaging",
        "windows_packaging",
        "remote_server_packaging",
      ],
    ],
    [
      "web production",
      ["apps/web/src/authBootstrap.ts"],
      "pull_request",
      ["test_server", "test_web", "build", "test", "windows_packaging", "remote_server_packaging"],
      ["linux_packaging"],
    ],
    [
      "server production",
      ["apps/server/src/git/GitManager.ts"],
      "pull_request",
      ["test_web", "test_server", "build", "test", "windows_packaging", "remote_server_packaging"],
      ["linux_packaging"],
    ],
    [
      "docs",
      ["docs/operations/development.md"],
      "pull_request",
      ["lint", "test_web", "test_server", "test", "build"],
      [
        "compute_native",
        "windows_packaging",
        "remote_server_packaging",
        "linux_packaging",
        "rust",
        "mobile_native_static_analysis",
        "release_smoke",
      ],
    ],
    [
      "workflow",
      [".github/workflows/ci.yml"],
      "pull_request",
      [
        "test_web",
        "test_server",
        "test",
        "build",
        "compute_native",
        "windows_packaging",
        "remote_server_packaging",
        "linux_packaging",
        "rust",
        "mobile_native_static_analysis",
        "release_smoke",
      ],
      [],
    ],
    [
      "queue fallback",
      ["apps/web/src/authBootstrap.test.ts"],
      "merge_group",
      ["test_server", "queue_ci", "test_web", "test", "build"],
      ["rust", "compute_native"],
    ],
    [
      "main backstop",
      ["docs/operations/development.md"],
      "push",
      [
        "changes",
        "lint",
        "build",
        "test",
        "test_web",
        "test_server",
        "rust",
        "mobile_native_static_analysis",
        "release_smoke",
        "compute_native",
        "windows_packaging",
        "remote_server_packaging",
        "linux_packaging",
      ],
      ["queue_ci", "qualification"],
    ],
  ])("%s runs and skips the intended jobs", (_label, files, event, runs, skips) => {
    const f = simulate(files as string[], event as string);
    expect(f.failures).toEqual([]);
    for (const id of runs) expect(f.needs[id]!.result, id).toBe("success");
    for (const id of skips) expect(f.needs[id]!.result, id).toBe("skipped");
    f.gateNeeds.lint!.result = "failure";
    expect(jobFailures(f.gateNeeds, { eventName: event as string, qualifyingPr: true })).toContain(
      "lint: failure",
    );
  });

  it("exact queue reuse requires reporters while release notes still run every test lane", () => {
    const reused = simulate(["apps/web/src/authBootstrap.test.ts"], "merge_group", true);
    expect(reused.failures).toEqual([]);
    for (const id of ["lint", "build", "test", "test_web", "test_server", "changes"])
      expect(reused.needs[id]!.result).toBe("skipped");
    for (const id of ["test_web_reused", "test_server_reused"])
      expect(reused.needs[id]!.result).toBe("success");
    for (const event of ["pull_request", "merge_group"]) {
      const focused = simulate(["apps/web/src/scient/releaseNotes/catalog.ts"], event, false, true);
      expect(focused.failures).toEqual([]);
      for (const id of [
        "lint",
        "build",
        "test",
        "test_web",
        "test_server",
        "changes",
        "qualification",
      ])
        expect(focused.needs[id]!.result).toBe("success");
      for (const id of ["test_web_reused", "test_server_reused"])
        expect(focused.needs[id]!.result).toBe("skipped");
    }
  });

  it.each([
    ["web test PR", "apps/web/src/authBootstrap.test.ts", "pull_request", false, 19],
    ["server PR", "apps/server/src/git/GitManager.ts", "pull_request", false, 25],
    ["docs PR", "docs/operations/development.md", "pull_request", false, 19],
    ["workflow PR", ".github/workflows/ci.yml", "pull_request", false, 37],
    ["Rust PR", "native/resource-monitor/Cargo.toml", "pull_request", false, 28],
    ["fresh merge group", "apps/web/src/authBootstrap.test.ts", "merge_group", false, 20],
    ["reused merge group", "apps/web/src/authBootstrap.test.ts", "merge_group", true, 7],
    ["main push", "docs/operations/development.md", "push", false, 36],
  ] as const)(
    "%s expands to the expected runners with a passing Check",
    (_label, file, event, reused, count) => {
      const f = simulate([file], event, reused);
      expect(f.failures).toEqual([]);
      expect(runnerCount(f.needs)).toBe(count);
      if (!reused) {
        for (const id of ["test", "test_web", "test_server"]) {
          f.gateNeeds[id]!.result = "cancelled";
          expect(jobFailures(f.gateNeeds, { eventName: event, qualifyingPr: true })).toContain(
            `${id}: cancelled`,
          );
          f.gateNeeds[id]!.result = "success";
        }
      }
    },
  );

  it("installs CI-script dependencies before Node tests and always tests every workspace", () => {
    const steps = workflow.jobs.lint!.steps!;
    const install = steps.findIndex((step) => step.uses === "./.github/actions/setup-ci-deps");
    const nodeTests = steps.findIndex((step) => step.run?.includes("node --test"));
    expect(install).toBeGreaterThan(-1);
    expect(nodeTests).toBeGreaterThan(install);
    const test = workflow.jobs.test!.steps!.find((step) => step.name === "Test")!;
    expect(test.env).toBeUndefined();
    expect(test.run).toBe(
      "vp run --parallel --concurrency-limit 4 --filter '!t3' --filter '!@t3tools/monorepo' --filter '!@t3tools/web' test",
    );
    for (const id of ["build", "test", "test_web", "test_server"])
      expect(workflow.jobs[id]!.if).not.toContain("needs.changes.outputs");
  });
});
