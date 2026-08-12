import { describe, expect, it } from "@effect/vitest";
import { AnalysisRuntimeId, createSimulatedAnalysisAdapter } from "./index.ts";

describe("analysis runtime adapter", () => {
  it("prepares a runtime-neutral file execution command", async () => {
    const profile = {
      id: AnalysisRuntimeId.make("simulator"),
      kind: "simulator",
      label: "Simulator",
      availability: "available",
      source: "custom",
      executablePath: "/tmp/simulator",
      version: "1",
      detail: null,
      capabilities: ["run-file", "stream-output", "cancel-process-tree"] as const,
      inspectedAt: "2026-08-12T00:00:00.000Z",
    } as const;
    const adapter = createSimulatedAnalysisAdapter({ profile, command: ["sim", "--run"] });

    await expect(
      adapter.inspect({
        inspectedAt: "2026-08-12T00:00:00.000Z",
        platform: "linux",
        environment: {},
      }),
    ).resolves.toEqual(profile);
    expect(
      adapter.prepare({
        runId: "run-1" as never,
        projectId: "project-1",
        runtime: profile,
        source: { cwd: "/project", relativePath: "analysis.m", revision: "sha256:1" as never },
        absoluteSourcePath: "/project/analysis.m",
      }),
    ).toEqual({ executable: "sim", args: ["--run"], cwd: "/project", environment: {} });
  });
});
