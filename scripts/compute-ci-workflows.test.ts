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
        real_kernel: { if: "${{ inputs.real_kernel }}" },
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
            compute_platforms:
              "${{ (github.event_name != 'pull_request' && github.event_name != 'merge_group') && 'all' || steps.compute.outputs.platforms }}",
          },
        },
        compute_native: {
          needs: ["queue_ci", "release_notes", "changes"],
          if: "${{ !cancelled() && needs.queue_ci.outputs.reused != 'true' && needs.changes.outputs.compute_changed != 'false' }}",
          uses: "./.github/workflows/scient-compute-python-kernel.yml",
          with: {
            real_kernel: "${{ needs.changes.outputs.real_kernel != 'false' }}",
            managed_python: "${{ needs.changes.outputs.managed_python != 'false' }}",
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

  it("narrows every native matrix to Linux only on an explicit linux", () => {
    const jobs = (
      workflow("scient-compute-python-kernel.yml") as {
        jobs: Record<
          string,
          {
            strategy: { matrix: { runner?: string; include?: string } };
            steps?: Array<{ env?: Record<string, string> }>;
          }
        >;
      }
    ).jobs;
    // Each value is one `${{ ... }}` expression; these use only ==, &&, || and fromJSON.
    const evaluate = (expression: string, context: object) =>
      NodeVM.runInNewContext(expression.slice(3, -2), { fromJSON: JSON.parse, ...context });
    const all = ["ubuntu-24.04", "macos-15", "macos-15-intel", "windows-2025"];
    // A job split into legs must give every runner the whole proof: one leg that runs all of
    // it, or one leg per part.
    const legs: Record<string, { key: string; whole: string; parts: Array<string> }> = {
      real_kernel: { key: "python", whole: "both", parts: ["3.10", "3.12"] },
      real_languages: { key: "part", whole: "all", parts: ["files", "kernels", "people"] },
    };
    const runners = (id: string, context: object): Array<string> => {
      const { runner, include } = jobs[id]!.strategy.matrix;
      if (runner !== undefined) return evaluate(runner, context);
      const entries = evaluate(include!, context) as Array<Record<string, string>>;
      const byRunner = Map.groupBy(entries, (entry) => entry.runner!);
      for (const [name, group] of byRunner) {
        const parts = group.map((entry) => entry[legs[id]!.key]!).toSorted();
        expect([[legs[id]!.whole], legs[id]!.parts], `${id} ${name}`).toContainEqual(parts);
      }
      return [...byRunner.keys()].toSorted((a, b) => all.indexOf(a) - all.indexOf(b));
    };
    for (const id of ["managed_python", "real_kernel", "real_languages"]) {
      expect(runners(id, { inputs: { platforms: "linux" } }), id).toEqual(["ubuntu-24.04"]);
      expect(runners(id, { inputs: { platforms: "all" } }), id).toEqual(all);
      // Manual dispatch has no such input.
      expect(runners(id, { inputs: {} }), id).toEqual(all);
    }
    const target = jobs.managed_python!.steps!.find((step) => step.env?.EXPECTED_TARGET)!.env!
      .EXPECTED_TARGET!;
    expect(all.map((runner) => evaluate(target, { matrix: { runner } }))).toEqual([
      "linux-x64",
      "darwin-arm64",
      "darwin-x64",
      "win32-x64",
    ]);
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
