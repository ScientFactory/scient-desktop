// @effect-diagnostics nodeBuiltinImport:off -- workflow contract tests read checked-in YAML only.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "@effect/vitest";
import * as YAML from "yaml";

const workflow = (name: string): unknown =>
  YAML.parse(NodeFS.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));

describe("Compute CI suite selection", () => {
  it("keeps both suites enabled by default for release callers and manual runs", () => {
    expect(workflow("scient-compute-python-kernel.yml")).toMatchObject({
      on: {
        workflow_call: {
          inputs: {
            real_kernel: { type: "boolean", default: true },
            managed_python: { type: "boolean", default: true },
            python_product: { type: "boolean", default: false },
            platforms: { type: "string", default: "all" },
          },
        },
        workflow_dispatch: {
          inputs: {
            real_kernel: { type: "boolean", default: true },
            managed_python: { type: "boolean", default: true },
          },
        },
      },
      jobs: {
        real_kernel: { if: "${{ inputs.real_kernel || inputs.python_product }}" },
        managed_python: { if: "${{ inputs.managed_python }}" },
      },
    });
  });

  it("wires each suite independently and skips it only on an explicit false", () => {
    expect(workflow("ci.yml")).toMatchObject({
      jobs: {
        changes: {
          outputs: {
            compute_changed:
              "${{ (github.event_name != 'pull_request' && github.event_name != 'merge_group') && 'true' || steps.compute.outputs.changed }}",
            real_kernel:
              "${{ (github.event_name != 'pull_request' && github.event_name != 'merge_group') && 'true' || steps.compute.outputs.real_kernel }}",
            managed_python:
              "${{ (github.event_name != 'pull_request' && github.event_name != 'merge_group') && 'true' || steps.compute.outputs.managed_python }}",
            python_product:
              "${{ (github.event_name != 'pull_request' && github.event_name != 'merge_group') && 'true' || steps.compute.outputs.python_product }}",
            compute_platforms:
              "${{ (github.event_name != 'pull_request' && github.event_name != 'merge_group') && 'all' || steps.compute.outputs.platforms }}",
          },
        },
        compute_native: {
          needs: ["queue_ci", "changes"],
          if: "${{ !cancelled() && needs.queue_ci.outputs.reused != 'true' && needs.changes.outputs.compute_changed != 'false' }}",
          uses: "./.github/workflows/scient-compute-python-kernel.yml",
          with: {
            real_kernel: "${{ needs.changes.outputs.real_kernel != 'false' }}",
            managed_python: "${{ needs.changes.outputs.managed_python != 'false' }}",
            python_product: "${{ needs.changes.outputs.python_product != 'false' }}",
            platforms:
              "${{ needs.changes.outputs.compute_platforms == 'linux' && 'linux' || 'all' }}",
          },
        },
        check: {
          name: "Check",
          needs: expect.arrayContaining(["test", "changes", "compute_native"]),
          if: "${{ always() }}",
        },
      },
    });
  });

  type Step = {
    id?: string;
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
    "working-directory"?: string;
  };
  type Job = {
    if?: string;
    strategy: { matrix: { runner?: string; include?: string | Array<Record<string, unknown>> } };
    steps: Array<Step>;
  };
  const jobs = (workflow("scient-compute-python-kernel.yml") as { jobs: Record<string, Job> }).jobs;
  // Each value is one `${{ ... }}` expression; these use only ==, &&, ||, ! and fromJSON.
  const evaluate = (expression: string, context: object) =>
    NodeVM.runInNewContext(expression.slice(3, -2), { fromJSON: JSON.parse, ...context });
  const all = ["ubuntu-24.04", "macos-15", "macos-15-intel", "windows-2025"];
  const legsOf = (id: string, inputs: object): Array<Record<string, unknown>> => {
    const job = jobs[id]!;
    if (job.if && !evaluate(job.if, { inputs })) return [];
    const { runner, include } = job.strategy.matrix;
    if (runner !== undefined)
      return (evaluate(runner, { inputs }) as Array<string>).map((name) => ({ runner: name }));
    return typeof include === "string" ? evaluate(include, { inputs }) : include!;
  };
  // Which runners run each proof, and with which parts, across every job.
  const coverage = (inputs: Record<string, unknown>) => {
    const runners: Record<string, Map<string, Array<string>>> = {};
    const add = (proof: string, runner: string, part: string) => {
      const byRunner = (runners[proof] ??= new Map());
      byRunner.set(runner, [...(byRunner.get(runner) ?? []), part].toSorted());
    };
    for (const leg of legsOf("managed_python", inputs)) add("managed", leg.runner as string, "all");
    for (const leg of legsOf("real_kernel", inputs))
      add("kernel", leg.runner as string, leg.python as string);
    for (const leg of legsOf("real_languages", inputs))
      add("languages", leg.runner as string, leg.part as string);
    for (const leg of legsOf("macos", inputs)) {
      if (inputs.managed_python) add("managed", leg.runner as string, "all");
      if (inputs.real_kernel) add("kernel", leg.runner as string, "both");
      if (inputs.real_kernel && leg.languages) add("languages", leg.runner as string, "all");
    }
    return runners;
  };

  it("narrows every native proof to Linux only on an explicit linux", () => {
    // A proof split into legs must give every runner the whole proof: one leg that runs all of
    // it, or one leg per part.
    const whole: Record<string, Array<Array<string>>> = {
      managed: [["all"]],
      kernel: [["both"], ["3.10", "3.12"]],
      languages: [["all"], ["files", "kernels", "people"]],
    };
    const runnersOf = (inputs: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(coverage(inputs)).map(([proof, byRunner]) => {
          for (const [runner, parts] of byRunner)
            expect(whole[proof], `${proof} ${runner}`).toContainEqual(parts);
          return [proof, [...byRunner.keys()].toSorted((a, b) => all.indexOf(a) - all.indexOf(b))];
        }),
      );
    const both = { real_kernel: true, managed_python: true };
    expect(runnersOf({ ...both, platforms: "linux" })).toEqual({
      managed: ["ubuntu-24.04"],
      kernel: ["ubuntu-24.04"],
      languages: ["ubuntu-24.04"],
    });
    expect(runnersOf({ ...both, platforms: "all" })).toEqual({
      managed: all,
      kernel: all,
      languages: all,
    });
    // Manual dispatch has no platforms input.
    expect(runnersOf(both)).toEqual({ managed: all, kernel: all, languages: all });
    expect(runnersOf({ managed_python: true, real_kernel: false, platforms: "all" })).toEqual({
      managed: all,
    });
    // Only the product case changed: one Linux leg on the interpreter its step uses.
    for (const platforms of ["linux", "all"]) {
      const inputs = { real_kernel: false, managed_python: false, python_product: true, platforms };
      expect(legsOf("real_kernel", inputs)).toEqual([{ runner: "ubuntu-24.04", python: "3.12" }]);
      expect(legsOf("macos", inputs)).toEqual([]);
    }
    const target = jobs.managed_python!.steps.find((step) => step.env?.EXPECTED_TARGET)!.env!
      .EXPECTED_TARGET!;
    expect(all.map((runner) => evaluate(target, { matrix: { runner } }))).toEqual([
      "linux-x64",
      "darwin-arm64",
      "darwin-x64",
      "win32-x64",
    ]);
    for (const leg of legsOf("macos", both))
      expect(leg.target, String(leg.runner)).toBe(evaluate(target, { matrix: leg }));
  });

  it("runs on a Mac the same steps as each role's own job, one role after another", () => {
    const steps = jobs.macos!.steps;
    const source: Record<string, string> = {
      people: "real_languages",
      files: "real_languages",
      kernels: "real_languages",
      languages: "real_languages",
      managed: "managed_python",
      python: "real_kernel",
    };
    const roles = ["people", "files", "kernels", "managed", "python"];
    const same = (step: Step) => ({
      uses: step.uses,
      run: step.run,
      env: step.env,
      with: step.with,
      "working-directory": step["working-directory"],
    });
    const proofs = steps.filter((step) => /^(?!end-)[a-z]+-/.test(step.id ?? ""));
    expect(proofs.length).toBeGreaterThan(15);
    for (const step of proofs) {
      const role = step.id!.split("-")[0]!;
      const original = jobs[source[role]!]!.steps.find((other) => other.name === step.name);
      expect(original, step.name).toBeDefined();
      // The target comes from the leg here, from a runner map there (checked above).
      if (step.env?.EXPECTED_TARGET)
        expect({ ...same(step), env: undefined }).toEqual({ ...same(original!), env: undefined });
      else expect(same(step), step.name).toEqual(same(original!));
      // Every proof of a role runs once the role began, whatever an earlier one did.
      if (role !== "languages")
        expect(step.if, step.name).toBe(
          `\${{ !cancelled() && steps.${role}.outcome == 'success' }}`,
        );
    }
    for (const role of roles) {
      const begin = steps.findIndex((step) => step.id === role);
      const finish = steps.findIndex((step) => step.id === `end-${role}`);
      expect(steps[begin]!.run).toMatch(new RegExp(`compute-roles\\.mjs begin ${role}\\b`));
      expect(steps[begin]!.if).toMatch(/^\$\{\{ !cancelled\(\) && steps\.vp\.outcome == 'success'/);
      expect(steps[finish]!.run).toMatch(new RegExp(`compute-roles\\.mjs end ${role}\\b`));
      expect(steps[finish]!.if).toBe(`\${{ !cancelled() && steps.${role}.outcome != 'skipped' }}`);
      const own = steps.slice(begin + 1, finish).map((step) => step.id!.split("-")[0]);
      expect(own.length, role).toBeGreaterThan(0);
      expect(new Set(own), role).toEqual(new Set([role]));
    }
    // The plain-Python proof runs before anything is installed into a Python, and the Python
    // it saved returns to its packages before real Python reuses that interpreter.
    const index = (id: string) => steps.findIndex((step) => step.id === id);
    expect(index("people")).toBeLessThan(index("kernels-install"));
    expect(index("kernels-install")).toBeLessThan(index("python-install-312"));
    expect(steps[index("people")]!.run).toContain("--save-python bare");
    expect(steps[index("end-kernels")]!.run).toContain("--restore-python bare");
    const summary = steps.at(-1)!;
    expect(summary.run).toBe("node .github/scripts/compute-roles.mjs summary");
    expect(summary.env!.STEPS).toBe("${{ toJSON(steps) }}");
    const expected = (inputs: object, leg: object) =>
      (
        evaluate(summary.env!.EXPECTED!, {
          inputs,
          matrix: leg,
          format: (template: string, ...args: Array<string>) =>
            template.replace(/\{(\d+)\}/g, (_, i: string) => args[Number(i)]!),
        }) as string
      )
        .split(" ")
        .filter(Boolean);
    const both = { real_kernel: true, managed_python: true, platforms: "all" };
    expect(legsOf("macos", both).map((leg) => expected(both, leg))).toEqual([
      ["people", "files", "kernels", "managed", "python"],
      ["managed", "python"],
    ]);
    const managedOnly = { real_kernel: false, managed_python: true, platforms: "all" };
    expect(legsOf("macos", managedOnly).map((leg) => expected(managedOnly, leg))).toEqual([
      ["managed"],
      ["managed"],
    ]);
  });

  it("runs the Compute product case on Linux 3.12 and the kernel suites only when asked", () => {
    expect(workflow("scient-compute-python-kernel.yml")).toMatchObject({
      jobs: {
        real_kernel: {
          steps: expect.arrayContaining([
            expect.objectContaining({
              name: "Run the real-kernel integration suite on Python 3.12",
              if: "${{ inputs.real_kernel && (matrix.python == 'both' || matrix.python == '3.12') }}",
            }),
            expect.objectContaining({
              name: "Run the Compute product case on Python 3.12",
              if: "${{ runner.os == 'Linux' && (matrix.python == 'both' || matrix.python == '3.12') }}",
              "working-directory": "apps/server",
              run: expect.stringContaining("src/scient/compute/ComputeProduct.integration.test.ts"),
            }),
          ]),
        },
      },
    });
  });

  it("qualifies recipes and the opted-in managed product in their respective lanes", () => {
    expect(workflow("scient-compute-python-kernel.yml")).toMatchObject({
      jobs: {
        managed_python: {
          steps: expect.arrayContaining([
            expect.objectContaining({
              name: "Qualify recipes",
              if: "${{ matrix.runner != 'windows-2025' }}",
              "working-directory": "apps/server",
              env: { SCIENT_TEST_MANAGED_PYTHON: "1", MPLBACKEND: "Agg" },
              run: "vp test run src/scient/compute/ComputeRecipe.live.test.ts --maxWorkers=1",
            }),
            expect.objectContaining({
              name: "Qualify base, every toolkit combination, and retained kernels",
              "working-directory": "apps/server",
              env: { SCIENT_TEST_MANAGED_PYTHON: "1", MPLBACKEND: "Agg" },
              run: "vp test bench --run src/scient/compute/ManagedPythonProduct.bench.ts --maxWorkers=1",
            }),
          ]),
        },
        // Windows, where managed_python is longest, qualifies recipes beside it.
        managed_recipes: {
          if: "${{ inputs.managed_python && inputs.platforms != 'linux' }}",
          "runs-on": "windows-2025",
          steps: expect.arrayContaining([
            expect.objectContaining({
              name: "Qualify recipes",
              "working-directory": "apps/server",
              env: { SCIENT_TEST_MANAGED_PYTHON: "1", MPLBACKEND: "Agg" },
              run: "vp test run src/scient/compute/ComputeRecipe.live.test.ts --maxWorkers=1",
            }),
          ]),
        },
      },
    });
  });
});
