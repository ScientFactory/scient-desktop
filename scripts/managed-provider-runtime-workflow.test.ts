// @effect-diagnostics nodeBuiltinImport:off -- This contract test reads a repository workflow file.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

describe("managed provider runtime update workflow", () => {
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
});
