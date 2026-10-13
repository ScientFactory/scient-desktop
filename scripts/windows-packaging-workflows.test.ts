// @effect-diagnostics nodeBuiltinImport:off -- qualification graph tests read checked-in workflows.
import * as NodeFS from "node:fs";
import { expect, it } from "@effect/vitest";
import * as YAML from "yaml";

it("requires applicable Windows qualification through the existing Test check", () => {
  const ci = YAML.parse(
    NodeFS.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  expect(ci.jobs).toMatchObject({
    windows_packaging_changes: {
      outputs: { changed: "${{ steps.detect.outputs.changed }}" },
    },
    windows_packaging: {
      needs: "windows_packaging_changes",
      if: "${{ !cancelled() && needs.windows_packaging_changes.outputs.changed != 'false' }}",
      uses: "./.github/workflows/windows-packaging.yml",
    },
    test: {
      name: "Test",
      if: "${{ always() }}",
      needs: expect.arrayContaining(["windows_packaging_changes", "windows_packaging"]),
    },
  });
  const gate = ci.jobs.test.steps.find(
    (step: { name?: string }) => step.name === "Require applicable test suites",
  );
  expect(gate.env).toMatchObject({
    WINDOWS_DETECTION_RESULT: "${{ needs.windows_packaging_changes.result }}",
    WINDOWS_CHANGED: "${{ needs.windows_packaging_changes.outputs.changed }}",
    WINDOWS_NATIVE_RESULT: "${{ needs.windows_packaging.result }}",
  });
  expect(gate.run).toContain("node .github/scripts/windows-packaging-ci-gate.mjs check");
  expect(gate.run).toContain("node .github/scripts/compute-ci-gate.mjs check");
});
