// @effect-diagnostics nodeBuiltinImport:off -- execute the workflow's own conditions against synthetic events.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "@effect/vitest";
import * as YAML from "yaml";
const require = NodeModule.createRequire(import.meta.url);
const { computeQualificationSuites } = require("../.github/scripts/compute-ci-gate.mjs") as {
  computeQualificationSuites: (paths: string[]) => {
    realKernel: boolean;
    managedPython: boolean;
    pythonProduct: boolean;
    platforms: string;
  };
};
const { needsLinuxPackaging, needsWindowsPackaging } =
  require("../.github/scripts/windows-packaging-ci-gate.mjs") as {
    needsLinuxPackaging: (paths: string[]) => boolean;
    needsWindowsPackaging: (paths: string[]) => boolean;
  };
const { needsMacOverleaf } = require("../.github/scripts/overleaf-macos-ci-gate.mjs") as {
  needsMacOverleaf: (paths: string[]) => boolean;
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
const { ADVISORY, jobFailures } = require("../.github/scripts/ci-check.cjs") as {
  ADVISORY: ReadonlyArray<string>;
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
  // A string is a `${{ fromJSON(...) }}` expression over the caller's inputs.
  strategy?: { matrix: Record<string, unknown[] | string> };
  with?: Record<string, string>;
  name?: string;
  uses?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
};
const workflow = YAML.parse(
  NodeFS.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as { jobs: Record<string, Job> };

function simulate(files: string[], eventName = "pull_request", reused = false, baseRef = "main") {
  // Main pushes and the nightly run select every lane; only PR and queue gates narrow them.
  const full = eventName !== "pull_request" && eventName !== "merge_group";
  const outputs = decide(eventName === "schedule" ? null : files, readWorkspace(), full).outputs;
  const compute = computeQualificationSuites(files);
  const gates = Object.fromEntries(
    Object.entries({
      ...outputs,
      compute_changed: full || compute.realKernel || compute.managedPython || compute.pythonProduct,
      real_kernel: full || compute.realKernel,
      managed_python: full || compute.managedPython,
      python_product: full || compute.pythonProduct,
      compute_platforms: full ? "all" : compute.platforms,
      windows_changed: full || needsWindowsPackaging(files),
      linux_changed: full || needsLinuxPackaging(files),
      macos_overleaf: eventName !== "pull_request" || needsMacOverleaf(files),
    }).map(([key, value]) => [key, String(value)]),
  );
  const needs: Record<string, JobResult> = {};
  const github = {
    event_name: eventName,
    ref: full ? "refs/heads/main" : "refs/pull/1/merge",
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
      if (run && id === "queue_ci")
        needs[id].outputs = {
          reused: String(reused),
          web_reports: "true",
          server_reports: "true",
          overleaf_windows: "true",
        };
      if (run && id === "changes") needs[id].outputs = gates;
      pending.delete(id);
      advanced = true;
    }
    if (!advanced) throw new Error("Workflow has a dependency cycle or missing job");
  }
  // The gate sees only the jobs it needs.
  const gated = workflow.jobs.check!.needs as string[];
  const gateNeeds = Object.fromEntries(Object.entries(needs).filter(([id]) => gated.includes(id)));
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
  const matrixSize = (job: Job, inputs: Record<string, unknown> = {}) => {
    const matrix = job.strategy?.matrix;
    if (!matrix) return 1;
    const expand = (values: unknown[] | string) =>
      typeof values === "string"
        ? (NodeVM.runInNewContext(values.slice(3, -2), {
            inputs,
            fromJSON: JSON.parse,
          }) as unknown[])
        : values;
    if (matrix.include) return expand(matrix.include).length;
    return Object.values(matrix).reduce((count, values) => count * expand(values).length, 1);
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
        const run =
          !child.if ||
          NodeVM.runInNewContext(child.if.slice(3, -2), { inputs, cancelled: () => false });
        return count + (run ? matrixSize(child, inputs) : 0);
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

  it("has one required gate covering every job", () => {
    expect(workflow.jobs.check).toMatchObject({ name: "Check", if: "${{ always() }}" });
    expect([...(workflow.jobs.check!.needs as string[])].sort()).toEqual(
      Object.keys(workflow.jobs)
        .filter((id) => id !== "check" && !ADVISORY.includes(id))
        .sort(),
    );
    expect(workflow.jobs.lint!.name).toBe("Lint");
    expect(workflow.jobs.test_server).toMatchObject({ "timeout-minutes": 20 });
    expect(workflow.jobs.test_web).toMatchObject({ "runs-on": "ubuntu-24.04" });
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
      ["docs/operations/00_development.md"],
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
      ["docs/operations/00_development.md"],
      "push",
      [
        "queue_ci",
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
      [
        "qualification",
        "test_web_reused",
        "test_server_reused",
        "stable_contexts_reused",
        "main_caches",
      ],
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

  it("a main push reuses the queue's exact qualification and refreshes only main's stores", () => {
    const reused = simulate(["apps/server/src/git/GitManager.ts"], "push", true);
    expect(reused.failures).toEqual([]);
    for (const [id, job] of Object.entries(reused.needs)) {
      const expected = [
        "queue_ci",
        "test_web_reused",
        "test_server_reused",
        "stable_contexts_reused",
        "main_caches",
        "check",
      ].includes(id);
      expect(job.result, id).toBe(expected ? "success" : "skipped");
    }
    const nightly = simulate(["apps/server/src/git/GitManager.ts"], "schedule", true);
    expect(nightly.failures).toEqual([]);
    for (const id of [
      "queue_ci",
      "test_web_reused",
      "test_server_reused",
      "stable_contexts_reused",
      "main_caches",
    ])
      expect(nightly.needs[id]!.result, id).toBe("skipped");
    for (const id of ["compute_native", "windows_packaging", "linux_packaging", "overleaf_macos"])
      expect(nightly.needs[id]!.result, id).toBe("success");
    const fallback = simulate(["apps/server/src/git/GitManager.ts"], "push", false);
    expect(fallback.failures).toEqual([]);
    expect(fallback.needs.main_caches!.result).toBe("skipped");
    for (const id of ["compute_native", "windows_packaging", "overleaf_windows", "overleaf_macos"])
      expect(fallback.needs[id]!.result, id).toBe("success");
  });

  // GET repos/ScientFactory/scient-desktop/branches/release%2Fstable/protection/required_status_checks
  const STABLE_REQUIRED = [
    "Check",
    "Test",
    "Test Server 1",
    "Test Server 2",
    "Test Server 3",
    "Rust",
    "Release Smoke",
  ];
  // Check names the run reports: a skipped matrix reports only its unexpanded name.
  function reportedChecks(needs: Record<string, JobResult>) {
    return Object.entries(workflow.jobs).flatMap(([id, job]) => {
      const name = job.name ?? id;
      const matrix = job.strategy?.matrix;
      if (!matrix || needs[id]!.result !== "success" || !name.includes("${{"))
        return [{ name, result: needs[id]!.result }];
      const rows = matrix.include
        ? (matrix.include as Record<string, unknown>[])
        : Object.entries(matrix).flatMap(([key, values]) =>
            (values as unknown[]).map((value) => ({ [key]: value })),
          );
      const format = (template: string, ...args: unknown[]) =>
        template.replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)]));
      return rows.map((row) => ({
        name: name.replace(/\$\{\{ (.*?) \}\}/g, (_, expression: string) =>
          String(NodeVM.runInNewContext(expression, { matrix: row, format })),
        ),
        result: "success",
      }));
    });
  }

  it.each([
    ["fresh PR", "pull_request", false],
    ["fresh queue", "merge_group", false],
    ["reused queue", "merge_group", true],
    ["fresh main push", "push", false],
    ["reused main push", "push", true],
    ["nightly", "schedule", false],
  ] as const)("a %s reports every check release/stable requires", (_label, event, reused) => {
    const f = simulate(["apps/server/src/git/GitManager.ts"], event, reused);
    const reported = reportedChecks(f.needs);
    for (const check of STABLE_REQUIRED)
      expect(
        reported.some(
          (entry) => entry.name === check && ["success", "skipped"].includes(entry.result),
        ),
        check,
      ).toBe(true);
  });

  it("exact queue reuse requires reporters", () => {
    const reused = simulate(["apps/web/src/authBootstrap.test.ts"], "merge_group", true);
    expect(reused.failures).toEqual([]);
    for (const id of [
      "lint",
      "build",
      "test",
      "test_web",
      "test_server",
      "changes",
      "overleaf_windows",
    ])
      expect(reused.needs[id]!.result).toBe("skipped");
    for (const id of ["test_web_reused", "test_server_reused", "stable_contexts_reused"])
      expect(reused.needs[id]!.result).toBe("success");
  });

  it("keeps the advisory Overleaf macOS selector from failing Changes", () => {
    const steps = workflow.jobs.changes!.steps! as Array<{
      id?: string;
      "continue-on-error"?: boolean;
    }>;
    for (const id of ["macos_overleaf_gate", "macos_overleaf"])
      expect(steps.find((step) => step.id === id)?.["continue-on-error"], id).toBe(true);
    // Only a successful detection may return `false`; any other outcome runs the job.
    const output = (workflow.jobs.changes as { outputs?: Record<string, string> }).outputs!
      .macos_overleaf!;
    const evaluate = (event: string, outcome: string, changed: string) =>
      NodeVM.runInNewContext(output.slice(3, -2), {
        github: { event_name: event },
        steps: { macos_overleaf: { outcome, outputs: { changed } } },
      });
    expect(evaluate("pull_request", "success", "false")).toBe("false");
    expect(evaluate("pull_request", "failure", "")).toBe("true");
    expect(evaluate("pull_request", "skipped", "")).toBe("true");
    expect(evaluate("push", "skipped", "")).toBe("true");
  });

  it("runs advisory Overleaf macOS on pull requests only when their diff can reach it", () => {
    const run = (file: string, event = "pull_request") =>
      simulate([file], event).needs.overleaf_macos!.result;
    expect(run("apps/web/src/authBootstrap.test.ts")).toBe("skipped");
    expect(run("apps/server/src/scient/overleaf/OverleafSync.ts")).toBe("success");
    expect(run("apps/web/src/authBootstrap.test.ts", "push")).toBe("success");
    expect(run("apps/web/src/authBootstrap.test.ts", "schedule")).toBe("success");
    expect(run("apps/server/src/scient/overleaf/OverleafSync.ts", "merge_group")).toBe("skipped");
  });

  it.each([
    ["web test PR", "apps/web/src/authBootstrap.test.ts", "pull_request", false, 40],
    ["server PR", "apps/server/src/git/GitManager.ts", "pull_request", false, 46],
    ["docs PR", "docs/operations/00_development.md", "pull_request", false, 40],
    // CI wiring runs Compute on Linux only; a push to main still runs all four.
    ["workflow PR", ".github/workflows/ci.yml", "pull_request", false, 54],
    ["lockfile PR", "pnpm-lock.yaml", "pull_request", false, 53],
    [
      "Compute PR",
      "apps/server/src/scient/compute/ComputeSessionService.ts",
      "pull_request",
      false,
      57,
    ],
    ["Rust PR", "native/resource-monitor/Cargo.toml", "pull_request", false, 49],
    ["fresh merge group", "apps/web/src/authBootstrap.test.ts", "merge_group", false, 41],
    // The probe, two suite reporters, four stable contexts, the receipt and Check.
    ["reused merge group", "apps/web/src/authBootstrap.test.ts", "merge_group", true, 9],
    ["main push", "docs/operations/00_development.md", "push", false, 62],
    ["nightly", "docs/operations/00_development.md", "schedule", false, 61],
    // Probe, two suite reporters, four stable contexts, the store refresh, Check.
    ["reused main push", "docs/operations/00_development.md", "push", true, 9],
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

  it("runs the performance checks first on the last shard, and its tests whatever they found", () => {
    type Step = { name?: string; id?: string; if?: string; run?: string; env?: object };
    for (const [id, checks] of [
      ["test_web", ["Boot the built web client", "Test scientific editor performance"]],
      ["test_server", ["Test compute session Python bridge", "Test scientific server performance"]],
    ] as const) {
      const steps = workflow.jobs[id]!.steps! as Array<Step>;
      const at = (name: string) => steps.findIndex((step) => step.name === name);
      const clear = at("Clear what the performance checks cached");
      for (const name of checks) {
        expect(steps[at(name)]!.if, name).toContain("matrix.shard == strategy.job-total");
        expect(at(name), name).toBeGreaterThan(at("Install missing Chromium system dependencies"));
        expect(at(name), name).toBeLessThan(clear);
      }
      expect(steps[clear]!.if).toBe("${{ !cancelled() && matrix.shard == strategy.job-total }}");
      expect(clear).toBeLessThan(at("Test"));
      expect(steps[at("Test")]!.if).toBe(
        "${{ !cancelled() && steps.browser.outcome == 'success' }}",
      );
      expect(steps.find((step) => step.id === "browser")!.name).toBe(
        "Install missing Chromium system dependencies",
      );
    }
    expect(
      (workflow.jobs.test_web!.steps! as Array<Step>).find(
        (step) => step.name === "Test scientific editor performance",
      )!.env,
    ).toEqual({ SCIENT_MARKDOWN_PERF_STRICT: "1" });
    expect(Object.keys(workflow.jobs).filter((id) => id.includes("performance"))).toEqual([]);
  });

  it("installs CI-script dependencies before Node tests and always tests every workspace", () => {
    const steps = workflow.jobs.lint!.steps!;
    const install = steps.findIndex((step) => step.uses === "./.github/actions/setup-ci-deps");
    const nodeTests = steps.findIndex((step) => step.run?.includes("node --test"));
    expect(install).toBeGreaterThan(-1);
    expect(nodeTests).toBeGreaterThan(install);
    const test = workflow.jobs.test!.steps!.find((step) => step.name === "Test")!;
    expect(test.env).toBeUndefined();
    expect(test.run).toContain(
      "vp run --parallel --concurrency-limit 4 ${{ matrix.packages }} test ${{ matrix.args }} 2>&1",
    );
    expect(test.run).not.toContain("TEST_PACKAGES");
    // Part 1 runs everything except the server, web and root packages and what the other parts
    // name, so the parts together run every workspace exactly once. A package several parts
    // name is split between them with `--shard`, each shard once.
    const parts = (
      workflow.jobs.test!.strategy!.matrix as unknown as {
        include: Array<{ part: number; packages: string; args?: string }>;
      }
    ).include;
    expect(parts.map((part) => part.part)).toEqual([1, 2, 3, 4, 5, 6]);
    const filters = (packages: string) =>
      [...packages.matchAll(/--filter '?([^' ]+)'?/g)].map((match) => match[1]!);
    const named = [...new Set(parts.slice(1).flatMap((part) => filters(part.packages)))];
    expect(named.every((name) => !name.startsWith("!"))).toBe(true);
    for (const name of named) {
      const sharing = parts.filter((part) => filters(part.packages).includes(name));
      if (sharing.length === 1) expect(sharing[0]!.args).toBeUndefined();
      else {
        for (const part of sharing) expect(filters(part.packages)).toEqual([name]);
        expect(sharing.map((part) => part.args).toSorted()).toEqual(
          sharing.map((_, i) => `--shard ${i + 1}/${sharing.length}`),
        );
      }
    }
    expect(filters(parts[0]!.packages).toSorted()).toEqual(
      ["!t3", "!@t3tools/monorepo", "!@t3tools/web", ...named.map((name) => `!${name}`)].toSorted(),
    );
    expect(workflow.jobs.test!.name).toBe(
      "${{ matrix.part == 1 && 'Test' || format('Test {0}', matrix.part) }}",
    );
    for (const id of ["build", "test", "test_web", "test_server"])
      expect(workflow.jobs[id]!.if).not.toContain("needs.changes.outputs");
  });
});
