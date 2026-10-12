// @effect-diagnostics nodeBuiltinImport:off -- Workflow contract tests read checked-in YAML and execute baseline preparation on synthetic files only.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { parse } from "yaml";
import { LINUX_DESKTOP_BUILD_PREREQUISITES } from "./build-desktop-artifact.ts";

const decodeWorkflow = Schema.decodeUnknownSync(
  Schema.Struct({
    jobs: Schema.Struct({
      appimage: Schema.Struct({
        "runs-on": Schema.String,
        steps: Schema.Array(
          Schema.Struct({
            name: Schema.optional(Schema.String),
            uses: Schema.optional(Schema.String),
            run: Schema.optional(Schema.String),
          }),
        ),
      }),
    }),
  }),
);

describe("Linux packaging CI contracts", () => {
  const workflow = decodeWorkflow(
    parse(
      NodeFS.readFileSync(
        new URL("../.github/workflows/linux-packaging.yml", import.meta.url),
        "utf8",
      ),
    ),
  );
  const steps = workflow.jobs.appimage.steps;
  const installation =
    steps.find((step) => step.name === "Install native build and headless launch dependencies")
      ?.run ?? "";
  const installed = installation.match(/sudo apt-get install[^\n]+/)?.[0].split(/\s+/) ?? [];

  it.each(LINUX_DESKTOP_BUILD_PREREQUISITES)(
    "provides $id required by the production packer",
    (requirement) => {
      if (requirement.id === "cargo" || requirement.id === "rust-target") {
        expect(steps.some((step) => step.uses?.startsWith("dtolnay/rust-toolchain@"))).toBe(true);
        expect(workflow.jobs.appimage["runs-on"]).toBe("ubuntu-24.04");
      } else {
        for (const dependency of requirement.packages) expect(installed).toContain(dependency);
      }
    },
  );

  it("baseline preparation retains the production output directory and leaves staged inputs unchanged", () => {
    const run =
      steps.find(
        (step) =>
          step.name === "Build same-stage compression baseline with duplicate trees restored",
      )?.run ?? "";
    const source = run.match(/<<'NODE'\n([\s\S]*?)\nNODE/)?.[1];
    expect(source).toBeDefined();
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "linux-baseline-test-"));
    try {
      const stage = NodePath.join(scratch, "t3code-desktop-linux-stage-fixture/app");
      NodeFS.mkdirSync(NodePath.join(stage, "dist"), { recursive: true });
      const filters = [
        "whisper-runtime",
        "resource-monitor",
        "synctex-runtime",
        "kde-capture",
        "hyprland-capture",
      ].flatMap((name) => [
        `!apps/desktop/prod-resources/${name}`,
        `!apps/desktop/prod-resources/${name}/**/*`,
      ]);
      const retained = ["apps/**", "!**/*.map", "!apps/desktop/prod-resources/cursor-sdk/**/*"];
      const original = JSON.stringify({
        version: "0.0.45",
        build: {
          files: [...retained, ...filters],
          directories: { output: "dist", buildResources: "apps/desktop/prod-resources" },
        },
      });
      const manifest = NodePath.join(stage, "package.json");
      NodeFS.writeFileSync(manifest, original);
      const priorArtifact = NodePath.join(stage, "dist/Scient-fixture.AppImage");
      NodeFS.writeFileSync(priorArtifact, "first build remains excluded from baseline input");
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", source ?? ""],
        {
          env: {
            ...process.env,
            STAGE_PARENT: scratch,
            RUNNER_TEMP: scratch,
            GITHUB_OUTPUT: NodePath.join(scratch, "output"),
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(NodeFS.readFileSync(manifest, "utf8")).toBe(original);
      expect(NodeFS.readFileSync(priorArtifact, "utf8")).toBe(
        "first build remains excluded from baseline input",
      );
      expect(
        JSON.parse(NodeFS.readFileSync(NodePath.join(scratch, "baseline-config.json"), "utf8")),
      ).toEqual({
        files: retained,
        directories: { output: "dist", buildResources: "apps/desktop/prod-resources" },
        npmRebuild: false,
      });
    } finally {
      NodeFS.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
