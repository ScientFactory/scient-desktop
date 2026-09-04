// @effect-diagnostics nodeBuiltinImport:off -- This contract test reads a repository workflow file.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

function workflow(name: string) {
  return parse(
    NodeFS.readFileSync(NodePath.join(import.meta.dirname, "../.github/workflows", name), "utf8"),
  );
}

describe("managed provider runtime update workflow", () => {
  it("keeps ACP on its own native installer and uses the provisioned package manager", () => {
    const caller = workflow("managed-provider-runtime-updates.yml");
    const reusable = workflow("managed-provider-runtime-update-provider.yml");
    expect(caller.on.workflow_dispatch.inputs.provider.options).toContain("antigravityAcp");
    expect(caller.jobs.provider.strategy.matrix.provider).toContain('"antigravityAcp"');
    const steps = reusable.jobs.qualify.steps;
    expect(
      steps.find((step: { run?: string }) =>
        step.run?.includes("node scripts/qualify-managed-runtime-catalog.ts"),
      ).if,
    ).toBe("inputs.provider != 'antigravityAcp'");
    const deps = steps.find(
      (step: { name: string }) => step.name === "Install official ACP qualification dependencies",
    );
    expect(deps.if).toBe("inputs.provider == 'antigravityAcp'");
    expect(deps.run).toBe("vp install --frozen-lockfile --filter=t3...");
    expect(
      steps.find((step: { run?: string }) =>
        step.run?.includes("node apps/server/scripts/qualify-antigravity-acp-catalog.ts"),
      ).if,
    ).toBe("inputs.provider == 'antigravityAcp'");
    expect(reusable.env.CATALOG_PATH).toContain("/managed-runtime-catalog.json");
    expect(reusable.env.BUNDLED_CATALOG_PATH).toContain("/bundled-managed-runtime-catalog.json");
  });

  it("gives GitHub CLI the least-privilege release app token during publication", () => {
    const workflow = NodeFS.readFileSync(
      NodePath.join(
        import.meta.dirname,
        "../.github/workflows/managed-provider-runtime-update-provider.yml",
      ),
      "utf8",
    );
    const publishStep =
      workflow
        .split("      - name: Merge and publish the qualified provider\n")[1]
        ?.split(/^      - name:/mu)[0] ?? "";

    expect(publishStep).toContain("GH_TOKEN: ${{ steps.app-token.outputs.token }}");
    expect(publishStep).toContain('gh api "/users/${APP_SLUG}[bot]"');
  });

  it("keeps feature-branch qualification read-only and pins the caller's exact source", () => {
    const caller = workflow("managed-provider-runtime-updates.yml");
    const reusable = workflow("managed-provider-runtime-update-provider.yml");
    expect(caller.jobs.provider.with.publish).toBe(
      "${{ github.ref == 'refs/heads/main' && !inputs.qualify_only }}",
    );
    expect(reusable.on.workflow_call.inputs.publish.default).toBe(false);
    expect(reusable.permissions).toEqual({ contents: "read" });
    expect(reusable.jobs.publish.if).toBe(
      "inputs.publish && github.ref == 'refs/heads/main' && needs.discover.outputs.changed == 'true' && needs.qualify.result == 'success'",
    );
    expect(reusable.jobs.discover.steps[0].with.ref).toBe(
      "${{ inputs.publish && github.ref == 'refs/heads/main' && 'main' || github.sha }}",
    );
    expect(reusable.jobs.qualify.steps[0].with.ref).toBe(
      "${{ needs.discover.outputs.source_sha }}",
    );
    expect(
      reusable.jobs.discover.steps.some((step: { uses?: string }) =>
        step.uses?.includes("create-github-app-token"),
      ),
    ).toBe(false);
    expect(
      reusable.jobs.qualify.steps.some((step: { uses?: string }) =>
        step.uses?.includes("create-github-app-token"),
      ),
    ).toBe(false);
  });

  it("requalifies unchanged candidates and requires every Windows stress cycle to pass", () => {
    const reusable = workflow("managed-provider-runtime-update-provider.yml");
    const upload = reusable.jobs.discover.steps.find(
      (step: { name: string }) => step.name === "Upload immutable candidate",
    );
    expect(upload.if).toBe("steps.catalog.outputs.changed == 'true' || !inputs.publish");
    expect(reusable.jobs.qualify.if).toBe(
      "needs.discover.outputs.changed == 'true' || !inputs.publish",
    );
    const exercise = reusable.jobs.qualify.steps.find(
      (step: { name: string }) =>
        step.name === "Exercise download, verification, smoke, activation, and removal",
    );
    expect(exercise.env.QUALIFICATION_RUNS).toBe(
      "${{ !inputs.publish && runner.os == 'Windows' && '5' || '1' }}",
    );
    expect(exercise.run).toContain("set -euo pipefail");
    expect(exercise.run).toContain("args+=(--repair)");
    expect(exercise.run).toContain("attempt <= QUALIFICATION_RUNS");
  });
});
