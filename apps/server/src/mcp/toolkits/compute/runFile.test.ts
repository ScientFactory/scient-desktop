// @effect-diagnostics nodeBuiltinImport:off -- a real project folder for the workspace receipt.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { expect, it } from "@effect/vitest";
import {
  AnalysisRuntimeId,
  AnalysisSourceRevision,
  ProviderInstanceId,
  ThreadId,
  type AnalysisRunSnapshot,
  type AnalysisStartRunInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { computeWorkspaceResolverForTest } from "../../../scient/compute/ComputeWorkspaceTestUtils.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { AgentInvocationContext } from "../../../scient/operations/AgentInvocationContext.ts";
import { ComputeMcpGateway } from "./ComputeMcpGateway.ts";
import { projectRelativePath, runScientComputeFile } from "./handlers.ts";

const finishedRun = (input: AnalysisStartRunInput): AnalysisRunSnapshot =>
  ({
    runtime: { label: "Java", version: "21.0.11" },
    source: { relativePath: input.relativePath },
    artifacts: [{ label: "chart.png" }],
    writtenFiles: ["table.csv"],
    receipt: {
      runId: input.runId,
      status: "failed",
      startedAt: "2026-11-01T00:00:00.000Z",
      finishedAt: "2026-11-01T00:00:01.000Z",
      failureMessage: "Java exited with code 1.",
      output: [{ text: "a.java:1: error\n" }],
    },
  }) as unknown as AnalysisRunSnapshot;

const available = (kind: string) => ({
  id: AnalysisRuntimeId.make(`file:${kind}`),
  kind,
  availability: "available",
});

const scoped = Effect.fn("runFile.test.scoped")(function* (
  runtimes: ReadonlyArray<ReturnType<typeof available>>,
  contents: string,
  path: string,
  project?: string,
) {
  const root =
    project ?? NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "run-file-")));
  yield* Effect.promise(() => initializeScientProject({ root }));
  const workspace = yield* computeWorkspaceResolverForTest.resolveWorkspaceRoot(root);
  const started: AnalysisStartRunInput[] = [];
  const result = yield* runScientComputeFile({ path }).pipe(
    Effect.provideService(ComputeMcpGateway, {
      readFile: () =>
        Effect.succeed({ contents, revision: AnalysisSourceRevision.make("revision") }),
      inspectFileRuntimes: () => Effect.succeed({ runtimes }),
      subscribeFileRuns: () => Effect.succeed(Stream.empty),
      startFileRun: (input: AnalysisStartRunInput) => {
        started.push(input);
        return Effect.succeed(finishedRun(input));
      },
    } as never),
    Effect.provideService(WorkspaceBindingResolver, computeWorkspaceResolverForTest),
    Effect.provideService(AgentInvocationContext, {
      environmentId: workspace.binding.environmentId,
      threadId: ThreadId.make("thread-run-file"),
      providerSessionId: "provider-session-run-file",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      capabilities: new Set(["compute"] as const),
      issuedAt: 1,
      workspace,
    }),
    Effect.result,
  );
  return { result, started };
});

it.effect("runs a file through the same run the app starts, and reports what it made", () =>
  Effect.gen(function* () {
    const { result, started } = yield* scoped([available("java")], "class A {}", "a.java");
    expect(started[0]?.runtimeId).toBe("file:java");
    expect(started[0]?.sourceRevision).toBe("revision");
    expect(result._tag === "Success" && result.success).toMatchObject({
      runtime: "Java 21.0.11",
      run: { status: "failed", figures: 1 },
      wrote: ["table.csv", "chart.png"],
    });
    expect(result._tag === "Success" && result.success.run.output).toContain("exited with code 1");
    expect(result._tag === "Success" && result.success.run.output).toContain("a.java:1: error");
  }),
);

it.effect("accepts the full path of a file in the project", () =>
  Effect.gen(function* () {
    const project = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "run-file-")),
    );
    const { started } = yield* scoped(
      [available("java")],
      "class A {}",
      NodePath.join(project, "src", "a.java"),
      project,
    );
    expect(started[0]?.relativePath).toBe("src/a.java");
  }),
);

it("shortens only a plain path under the project", () => {
  expect(projectRelativePath("/lab", "/lab/src/a.c", "/")).toBe("src/a.c");
  expect(projectRelativePath("/lab", "src/a.c", "/")).toBe("src/a.c");
  expect(projectRelativePath("C:\\lab", "C:\\lab\\src\\a.c", "\\")).toBe("src/a.c");
  // Folding these could pass through a symlink, or leave the project.
  expect(projectRelativePath("/lab", "/lab/nested/../a.c", "/")).toBe("/lab/nested/../a.c");
  expect(projectRelativePath("/lab", "/lab2/a.c", "/")).toBe("/lab2/a.c");
  expect(projectRelativePath("/lab", "/etc/passwd", "/")).toBe("/etc/passwd");
  // On POSIX a backslash is part of a file's name.
  expect(projectRelativePath("/lab", "/lab/a\\b.c", "/")).toBe("a\\b.c");
});

it.effect("sends a shared file type to the language that is installed", () =>
  Effect.gen(function* () {
    const { started } = yield* scoped([available("gp")], "1 + 1\n", "a.gp");
    expect(started[0]?.runtimeId).toBe("file:gp");
  }),
);

it.effect("runs a sqlite3 script with sqlite3, and plain SQL not at all", () =>
  Effect.gen(function* () {
    const script = yield* scoped([available("sqlite")], ".bail on\n", "a.sql");
    expect(script.started[0]?.runtimeId).toBe("file:sqlite");
    const plain = yield* scoped([available("sqlite")], "select 1;\n", "a.sql");
    expect(plain.started).toHaveLength(0);
    expect(plain.result._tag).toBe("Failure");
  }),
);

it.effect("names the way forward when nothing can run a file", () =>
  Effect.gen(function* () {
    const { result } = yield* scoped([], "print(1)\n", "a.py");
    expect(result._tag === "Failure" && result.failure.message).toContain("scient_compute_run");
  }),
);
