// @effect-diagnostics nodeBuiltinImport:off -- workflow contract tests read checked-in YAML only.
import * as NodeFS from "node:fs";
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
              "${{ github.event_name == 'push' && 'true' || steps.compute.outputs.changed }}",
            real_kernel:
              "${{ github.event_name == 'push' && 'true' || steps.compute.outputs.real_kernel }}",
            managed_python:
              "${{ github.event_name == 'push' && 'true' || steps.compute.outputs.managed_python }}",
          },
        },
        compute_native: {
          needs: ["queue_ci", "release_notes", "changes"],
          if: "${{ !cancelled() && needs.release_notes.outputs.qualified != 'true' && needs.queue_ci.outputs.reused != 'true' && needs.changes.outputs.compute_changed != 'false' }}",
          uses: "./.github/workflows/scient-compute-python-kernel.yml",
          with: {
            real_kernel: "${{ needs.changes.outputs.real_kernel != 'false' }}",
            managed_python: "${{ needs.changes.outputs.managed_python != 'false' }}",
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

  it("qualifies recipes and the opted-in managed product in their respective lanes", () => {
    expect(workflow("scient-compute-python-kernel.yml")).toMatchObject({
      jobs: {
        managed_python: {
          steps: expect.arrayContaining([
            expect.objectContaining({
              name: "Qualify base, every toolkit combination, and retained kernels",
              "working-directory": "apps/server",
              env: { SCIENT_TEST_MANAGED_PYTHON: "1", MPLBACKEND: "Agg" },
              run: "vp test run src/scient/compute/ComputeRecipe.live.test.ts --maxWorkers=1 && vp test bench --run src/scient/compute/ManagedPythonProduct.bench.ts --maxWorkers=1",
            }),
          ]),
        },
      },
    });
  });
});
