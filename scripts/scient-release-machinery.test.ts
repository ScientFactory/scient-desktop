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
  it("keeps stable releases manual-only and globally serialized", () => {
    const workflow = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "../.github/workflows/release.yml"),
      "utf8",
    );

    assert.match(workflow, /^on:\n  workflow_dispatch:\n/mu);
    assert.notMatch(workflow, /^  push:\n/mu);
    assert.notMatch(workflow, /^  schedule:\n/mu);
    assert.include(workflow, "group: scient-stable-release");
    assert.include(workflow, "cancel-in-progress: false");
  });

  it("prepares stable candidates at 03:00 Jerusalem without direct publication authority", () => {
    const workflow = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "../.github/workflows/scheduled-stable-candidate.yml"),
      "utf8",
    );

    assert.include(workflow, 'cron: "0 3 * * *"');
    assert.include(workflow, 'timezone: "Asia/Jerusalem"');
    assert.include(workflow, "actions: write");
    assert.include(workflow, "contents: read");
    assert.notInclude(workflow, "contents: write");
    assert.notInclude(workflow, "environment: production");
    assert.notInclude(workflow, "gh release create");
    assert.include(workflow, 'status != "completed"');
    assert.include(workflow, "gh workflow run promote-release.yml");
    assert.include(workflow, "gh workflow run release.yml");
    assert.include(workflow, '-f "publish_release=true"');
    assert.include(workflow, '-f "allow_note_free=false"');
    assert.include(workflow, '-f "allow_unsigned_windows=true"');
  });

  it("fails duplicate release identities before builds and again before publication", () => {
    const workflow = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "../.github/workflows/release.yml"),
      "utf8",
    );
    const preflight = workflow.split(/^  preflight:\n/mu)[1]?.split(/^  \w+:\n/mu)[0] ?? "";
    const publish = workflow.split(/^  publish:\n/mu)[1] ?? "";

    assert.include(preflight, 'gh release view "$release_tag"');
    assert.include(preflight, '"refs/tags/$release_tag"');
    assert.include(publish, 'gh release view "$RELEASE_TAG"');
    assert.include(publish, '"refs/tags/$RELEASE_TAG"');
    assert(
      workflow.indexOf("Refuse an existing tag or release before builds") <
        workflow.indexOf("build_desktop:"),
    );
  });

  it("publishes the same retained candidate only after production approval", () => {
    const workflow = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "../.github/workflows/release.yml"),
      "utf8",
    );
    const assemble = workflow.split(/^  assemble:\n/mu)[1]?.split(/^  \w+:\n/mu)[0] ?? "";
    const publish = workflow.split(/^  publish:\n/mu)[1] ?? "";

    assert.include(assemble, "name: Upload immutable release candidate");
    assert.include(assemble, "retention-days: 30");
    assert.include(assemble, "artifact-digest");
    assert.include(assemble, "artifact-id");
    assert.include(assemble, "artifact-url");
    assert.include(assemble, 'echo "- Artifact: \\`$ARTIFACT_NAME\\`"');
    assert.include(publish, "environment: production");
    assert.include(publish, "actions: read");
    assert.include(publish, "name: scient-release-v${{ needs.preflight.outputs.version }}");
    assert.include(publish, "Verify accepted candidate identity and checksums");
    assert.include(publish, 'sub("^sha256:"; "")');
    assert.include(publish, ".workflow_run.id == $run_id");
    assert.include(publish, "sha256sum --check SHA256SUMS.txt");
    assert.include(publish, "Stage, verify, and publish the immutable release");
  });

  it("cancels superseded pull request CI while retaining pushed main validation", () => {
    const workflow = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "../.github/workflows/ci.yml"),
      "utf8",
    );

    assert.include(workflow, "group: ci-${{ github.event.pull_request.number || github.sha }}");
    assert.include(workflow, "cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    assert.include(workflow, "vp run build:desktop");
    assert.include(workflow, "Verify preload bundle output");
  });

  it("pins every release-owned action to an immutable commit", () => {
    for (const workflowName of [
      "promote-release.yml",
      "release.yml",
      "scheduled-stable-candidate.yml",
    ]) {
      const workflow = NodeFS.readFileSync(
        NodePath.join(import.meta.dirname, "../.github/workflows", workflowName),
        "utf8",
      );
      const uses = [...workflow.matchAll(/^\s+(?:-\s+)?uses:\s*([^\s#]+)/gmu)].map(
        (match) => match[1],
      );
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

  it("pins Bash for every package-version alignment step", () => {
    const workflow = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "../.github/workflows/release.yml"),
      "utf8",
    );

    // Split into step blocks so the assertion covers every step that stamps
    // package versions, not just one named step. On the Windows matrix leg the
    // default shell is PowerShell, where "$RELEASE_VERSION" expands empty and
    // silently stamps blank versions; each such step must declare shell: bash.
    const stampingSteps = workflow
      .split(/^ {6}- name: /mu)
      .slice(1)
      .filter((step) => step.includes("update-release-package-versions.ts"));

    assert.equal(stampingSteps.length, 2);
    for (const step of stampingSteps) {
      assert.match(step, /^[^\n]*\n\s+shell: bash\n/u);
    }
  });

  it("exposes Vite+'s pinned pnpm before packaging the remote server", () => {
    const workflow = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "../.github/workflows/release.yml"),
      "utf8",
    );
    const serverAssetJob =
      workflow.split(/^  build_server_asset:\n/mu)[1]?.split(/^  \w+:\n/mu)[0] ?? "";

    assert.include(
      serverAssetJob,
      'vp_pnpm_bin="$HOME/.vite-plus/package_manager/pnpm/$pnpm_version/pnpm/bin"',
    );
    assert.include(serverAssetJob, 'echo "$vp_pnpm_bin" >> "$GITHUB_PATH"');
    assert.include(serverAssetJob, '"$vp_pnpm_bin/pnpm" --version');

    const setupVpIndex = serverAssetJob.indexOf("voidzero-dev/setup-vp@");
    const exposePnpmIndex = serverAssetJob.indexOf("- name: Expose pnpm");
    const packageServerIndex = serverAssetJob.indexOf("node scripts/package-scient-server.ts");
    assert(setupVpIndex >= 0 && setupVpIndex < exposePnpmIndex);
    assert(exposePnpmIndex < packageServerIndex);
  });

  it("installs workspace dependencies before running release assembly scripts", () => {
    const workflow = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "../.github/workflows/release.yml"),
      "utf8",
    );
    const assembleJob = workflow.split(/^  assemble:\n/mu)[1]?.split(/^  \w+:\n/mu)[0] ?? "";
    const steps = assembleJob.split(/^ {6}- /mu).slice(1);
    const setupVpStep = steps.find((step) => step.includes("voidzero-dev/setup-vp@"));

    assert.include(setupVpStep ?? "", "run-install: true");

    const setupVpIndex = assembleJob.indexOf("voidzero-dev/setup-vp@");
    const firstNodeScriptIndex = assembleJob.indexOf("node scripts/");
    assert(setupVpIndex >= 0 && setupVpIndex < firstNodeScriptIndex);
  });

  it("copies only updater manifests and removes internal builder metadata", () => {
    const workflow = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "../.github/workflows/release.yml"),
      "utf8",
    );
    assert.include(workflow, "release/latest*.yml");
    assert.include(workflow, "rm -f release-assets/builder-debug.yml");
    assert(
      workflow.indexOf("rm -f release-assets/builder-debug.yml") <
        workflow.indexOf("node scripts/verify-scient-release-assets.ts"),
    );
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
