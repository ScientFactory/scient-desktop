// @effect-diagnostics nodeBuiltinImport:off -- tests create temporary executable fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { AnalysisSourceRevision } from "@scientfactory/analysis";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  MATLAB_BATCH_EXPRESSION,
  inspectMatlabRuntime,
  matlabReleaseFromExecutablePath,
  prepareMatlabCommand,
} from "./MatlabAdapter.ts";

const tempDirectories: string[] = [];

async function executableFixture(name = "matlab"): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-matlab-adapter-"));
  tempDirectories.push(directory);
  const executable = NodePath.join(directory, name);
  await NodeFSP.writeFile(executable, "#!/usr/bin/env node\n", "utf8");
  await NodeFSP.chmod(executable, 0o755);
  return executable;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => NodeFSP.rm(directory, { recursive: true })),
  );
});

describe("MATLAB runtime adapter", () => {
  it("derives a release from conventional cross-platform executable paths", () => {
    expect(matlabReleaseFromExecutablePath("/Applications/MATLAB_R2025b.app/bin/matlab")).toBe(
      "R2025b",
    );
    expect(
      matlabReleaseFromExecutablePath("C:\\Program Files\\MATLAB\\R2024A\\bin\\matlab.exe"),
    ).toBe("R2024a");
    expect(matlabReleaseFromExecutablePath("/usr/local/bin/matlab")).toBeNull();
  });

  it("prefers an explicit executable and reports invalid custom paths honestly", async () => {
    const executable = await executableFixture();
    await expect(
      inspectMatlabRuntime({
        customExecutablePath: executable,
        inspectedAt: "2026-08-12T00:00:00Z",
        platform: "linux",
        environment: { PATH: "" },
      }),
    ).resolves.toMatchObject({
      availability: "available",
      source: "custom",
      executablePath: executable,
    });
    await expect(
      inspectMatlabRuntime({
        customExecutablePath: `${executable}-missing`,
        inspectedAt: "2026-08-12T00:00:00Z",
        platform: "linux",
        environment: { PATH: "" },
      }),
    ).resolves.toMatchObject({ availability: "invalid", source: "custom" });
  });

  it("discovers MATLAB on PATH without launching it", async () => {
    const executable = await executableFixture();
    const profile = await inspectMatlabRuntime({
      inspectedAt: "2026-08-12T00:00:00Z",
      platform: "linux",
      environment: { PATH: NodePath.dirname(executable) },
    });

    expect(profile).toMatchObject({ availability: "available", source: "path" });
  });

  it("returns a useful missing state without requiring MATLAB to view files", async () => {
    await expect(
      inspectMatlabRuntime({
        inspectedAt: "2026-08-12T00:00:00Z",
        platform: "aix",
        environment: { PATH: "" },
      }),
    ).resolves.toMatchObject({
      availability: "missing",
      source: "unconfigured",
      executablePath: null,
    });
  });

  it("uses a static batch expression and passes arbitrary source paths through the environment", () => {
    const sourcePath = "/project/researcher's $results/analysis.m";
    const command = prepareMatlabCommand({
      profile: {
        id: "matlab:local" as never,
        kind: "matlab",
        label: "MATLAB",
        availability: "available",
        source: "custom",
        executablePath: "/Applications/MATLAB.app/bin/matlab",
        version: null,
        detail: null,
        capabilities: ["run-file", "stream-output", "cancel-process-tree"],
        inspectedAt: "2026-08-12T00:00:00Z",
      },
      source: {
        cwd: "/project",
        relativePath: "researcher's $results/analysis.m",
        revision: AnalysisSourceRevision.make("sha256:test"),
      },
      absoluteSourcePath: sourcePath,
    });

    expect(command.args).toEqual(["-batch", MATLAB_BATCH_EXPRESSION]);
    expect(command.args.join(" ")).not.toContain(sourcePath);
    expect(command.environment).toEqual({ SCIENT_MATLAB_ENTRYPOINT: sourcePath });
  });
});
