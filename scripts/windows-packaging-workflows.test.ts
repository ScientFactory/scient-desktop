// @effect-diagnostics nodeBuiltinImport:off -- qualification graph tests read checked-in workflows.
import * as NodeFS from "node:fs";
import { expect, it } from "@effect/vitest";
import * as YAML from "yaml";

it("requires applicable Windows qualification through the single Check gate", () => {
  const ci = YAML.parse(
    NodeFS.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  expect(ci.jobs).toMatchObject({
    changes: {
      outputs: {
        windows_changed:
          "${{ github.event_name == 'push' && 'true' || steps.packaging.outputs.changed }}",
      },
    },
    windows_packaging: {
      needs: ["queue_ci", "release_notes", "changes"],
      if: "${{ !cancelled() && needs.release_notes.outputs.qualified != 'true' && needs.queue_ci.outputs.reused != 'true' && needs.changes.outputs.windows_changed != 'false' }}",
      uses: "./.github/workflows/windows-packaging.yml",
    },
    check: {
      name: "Check",
      if: "${{ always() }}",
      needs: expect.arrayContaining(["changes", "windows_packaging"]),
    },
  });
  const gate = ci.jobs.check.steps.find(
    (step: { name?: string }) => step.name === "Require applicable native qualification",
  );
  expect(gate.env).toMatchObject({
    WINDOWS_DETECTION_RESULT: "${{ needs.changes.result }}",
    WINDOWS_CHANGED: "${{ needs.changes.outputs.windows_changed }}",
    WINDOWS_NATIVE_RESULT: "${{ needs.windows_packaging.result }}",
  });
  expect(gate.run).toContain("node .github/scripts/windows-packaging-ci-gate.mjs check");
  expect(gate.run).toContain("node .github/scripts/compute-ci-gate.mjs check");
});
