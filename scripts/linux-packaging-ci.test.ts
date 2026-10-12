// @effect-diagnostics nodeBuiltinImport:off -- Workflow contract tests read checked-in YAML only.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { parse } from "yaml";
import { LINUX_DESKTOP_BUILD_PREREQUISITES } from "./build-desktop-artifact.ts";

describe("Linux packaging CI prerequisites", () => {
  const workflow = Schema.decodeUnknownSync(
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
  )(
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
});
