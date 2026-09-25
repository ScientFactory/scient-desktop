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
        compute_changes: {
          outputs: {
            changed: "${{ steps.detect.outputs.changed }}",
            real_kernel: "${{ steps.detect.outputs.real_kernel }}",
            managed_python: "${{ steps.detect.outputs.managed_python }}",
          },
        },
        compute_native: {
          needs: "compute_changes",
          if: "${{ !cancelled() && needs.compute_changes.outputs.changed != 'false' }}",
          uses: "./.github/workflows/scient-compute-python-kernel.yml",
          with: {
            real_kernel: "${{ needs.compute_changes.outputs.real_kernel != 'false' }}",
            managed_python: "${{ needs.compute_changes.outputs.managed_python != 'false' }}",
          },
        },
        test: {
          name: "Test",
          needs: ["test_workspaces", "compute_changes", "compute_native"],
          if: "${{ always() }}",
        },
      },
    });
  });
});
