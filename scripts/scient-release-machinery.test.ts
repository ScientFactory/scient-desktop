// @effect-diagnostics nodeBuiltinImport:off - Release tooling tests use isolated temporary filesystem fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";

import { createScientReleaseHandoff } from "./create-scient-release-handoff.ts";
import {
  createScientServerPackageJson,
  resolveNpmCompatibleOverrides,
} from "./package-scient-server.ts";
import {
  renderScientReleaseNotesMarkdown,
  resolveReleaseNoteSource,
  runScientReleasePreflight,
} from "./scient-release-preflight.ts";

describe("Scient release machinery", () => {
  it("pins every release-owned action to an immutable commit", () => {
    for (const workflowName of ["promote-release.yml", "release.yml"]) {
      const workflow = NodeFS.readFileSync(
        NodePath.join(import.meta.dirname, "../.github/workflows", workflowName),
        "utf8",
      );
      const uses = [...workflow.matchAll(/^\s*- uses:\s*([^\s#]+)/gmu)].map((match) => match[1]);
      assert(uses.length > 0, `${workflowName} must declare at least one action`);
      for (const action of uses) {
        assert.match(
          action ?? "",
          /@[0-9a-f]{40}$/u,
          `${workflowName} has a mutable action: ${action}`,
        );
      }
    }
  });

  it("keeps unsigned Windows publication an explicit exception", () => {
    const workflow = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "../.github/workflows/release.yml"),
      "utf8",
    );
    assert.include(workflow, "allow_unsigned_windows:");
    assert.include(
      workflow,
      "allow_unsigned_windows is only valid for an explicitly publishing run.",
    );
    assert.include(
      workflow,
      "Windows publication is unsigned; rerun only with explicit allow_unsigned_windows=true.",
    );
    assert.include(workflow, "Publication requires signed macOS artifacts:");
  });

  it("requires release/stable to be the exact selected main commit", async () => {
    await expect(
      runScientReleasePreflight({
        version: "0.6.0",
        sourceSha: "a".repeat(40),
        releaseSha: "b".repeat(40),
        root: process.cwd(),
        allowNoteFree: true,
      }),
    ).rejects.toThrow("must point at the exact selected main commit");
    await expect(
      runScientReleasePreflight({
        version: "00.6.0",
        sourceSha: "a".repeat(40),
        releaseSha: "a".repeat(40),
        root: process.cwd(),
        allowNoteFree: true,
      }),
    ).rejects.toThrow("exact x.y.z version");
  });

  it("uses the validated owned What's New catalog for the exact release", () => {
    assert.equal(
      resolveReleaseNoteSource({
        catalog: [{ version: "0.6.0" }],
        issues: [],
        version: "0.6.0",
        allowNoteFree: false,
      }),
      "catalog",
    );
    assert.throws(
      () =>
        resolveReleaseNoteSource({
          catalog: [{ version: "0.6.0" }],
          issues: ["release[0].headline must not be empty."],
          version: "0.6.0",
          allowNoteFree: true,
        }),
      "catalog is invalid",
    );
  });

  it("renders the approved in-app note as the public GitHub release body", () => {
    assert.equal(
      renderScientReleaseNotesMarkdown({
        version: "0.6.0",
        kicker: "The new Scient foundation",
        headline: "A faster, clearer Scient",
        summary: "Scient now runs on its new maintained desktop foundation.",
        highlights: [
          {
            title: "Easier setup",
            description: "Connect an existing AI subscription from the composer.",
          },
        ],
      }),
      "# A faster, clearer Scient\n\n**The new Scient foundation**\n\nScient now runs on its new maintained desktop foundation.\n\n## Highlights\n\n- **Easier setup** — Connect an existing AI subscription from the composer.\n",
    );
  });

  it("prepares a GitHub-distributed server package without workspace dependencies", () => {
    const manifest = createScientServerPackageJson({
      source: {
        license: "MIT",
        bin: { t3: "./dist/bin.mjs" },
        engines: { node: ">=24" },
        dependencies: {
          effect: "catalog:",
          "@t3tools/shared": "workspace:*",
        },
      },
      version: "0.6.0",
      catalog: { effect: "4.0.0" },
      overrides: { effect: "catalog:" },
      installedVersions: { effect: "4.0.0" },
    });

    assert.equal(manifest.name, "t3");
    assert.equal(manifest.version, "0.6.0");
    assert.deepStrictEqual(manifest.files, ["dist", "npm-shrinkwrap.json"]);
    assert.deepStrictEqual(manifest.dependencies, { effect: "4.0.0" });
    assert.deepStrictEqual(manifest.overrides, {});
    assert.deepStrictEqual(manifest.allowScripts, {
      "node-pty@1.1.0": true,
      "msgpackr-extract@3.0.4": true,
    });
  });

  it("omits pnpm-only override selectors from the npm tarball", () => {
    assert.deepStrictEqual(
      resolveNpmCompatibleOverrides(
        {
          effect: "catalog:",
          "@clerk/clerk-js>@base-org/account": "-",
        },
        { effect: "3.19.15" },
      ),
      { effect: "3.19.15" },
    );
    assert.deepStrictEqual(
      resolveNpmCompatibleOverrides(
        { yaml: "catalog:", effect: "catalog:" },
        { yaml: "2.9.0", effect: "3.19.15" },
        new Set(["yaml"]),
      ),
      { effect: "3.19.15" },
    );
  });

  it("writes deterministic checksums and an exact-source handoff", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-release-handoff-"));
    try {
      NodeFS.writeFileSync(NodePath.join(root, "Scient-0.6.0-x64.AppImage"), "linux");
      const output = NodePath.join(root, "scient-release-handoff.json");
      createScientReleaseHandoff([
        "--assets-dir",
        root,
        "--version",
        "0.6.0",
        "--source-sha",
        "a".repeat(40),
        "--source-tree",
        "b".repeat(40),
        "--output",
        output,
      ]);

      const handoff = JSON.parse(NodeFS.readFileSync(output, "utf8")) as {
        readonly source: {
          readonly repository: string;
          readonly commit: string;
          readonly tree: string;
        };
        readonly assets: ReadonlyArray<{
          readonly name: string;
          readonly size: number;
          readonly sha256: string;
        }>;
      };
      const expectedHash = NodeCrypto.createHash("sha256").update("linux").digest("hex");
      assert.deepStrictEqual(handoff.source, {
        repository: "ScientFactory/scient-desktop-next",
        commit: "a".repeat(40),
        tree: "b".repeat(40),
      });
      assert.deepStrictEqual(handoff.assets, [
        { name: "Scient-0.6.0-x64.AppImage", size: 5, sha256: expectedHash },
      ]);
      assert.equal(
        NodeFS.readFileSync(NodePath.join(root, "SHA256SUMS.txt"), "utf8"),
        `${expectedHash}  Scient-0.6.0-x64.AppImage\n`,
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
