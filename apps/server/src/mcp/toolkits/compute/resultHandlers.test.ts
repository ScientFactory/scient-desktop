import {
  ComputeResultRevisionId,
  ProviderInstanceId,
  ThreadId,
  type ComputeResultParameterValues,
  type ComputeResultRevision,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AgentInvocationContext } from "../../../scient/operations/AgentInvocationContext.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import { ComputeMcpGateway } from "./ComputeMcpGateway.ts";
import { listScientResults, runScientResults } from "./resultHandlers.ts";

it.effect("preserves JSON parameter types and makes the inventory and output reads explicit", () =>
  Effect.gen(function* () {
    const cwd = "/project";
    const resolver = workspaceResolverForTest(
      new Map([[cwd, { projectId: "test", scope: workspaceScopeForTest("test", cwd) }]]),
    );
    const workspace = yield* resolver.resolveWorkspaceRoot(cwd);
    const path = "analysis.py";
    const latest: ComputeResultRevision = {
      revision: ComputeResultRevisionId.make("r0123456789ab"),
      script: { path, language: "Python", sha256: "0".repeat(64) },
      run: {
        sessionId: "session",
        executionId: "run",
        startedAt: null,
        finishedAt: "2026-11-23T00:00:00.000Z",
      },
      runtime: { executable: null, version: null, fingerprint: null },
      inputs: { tracking: "observed", files: [], truncated: false },
      outputs: [],
      omitted: 0,
      environment: {
        lockfiles: [{ path: "uv.lock", sha256: "1".repeat(64) }],
        packages: [{ name: "numpy", version: "2.0" }],
        packagesTruncated: true,
      },
    };
    let parameters: ComputeResultParameterValues | undefined;
    const gateway = Layer.mock(ComputeMcpGateway)({
      listResults: () => Effect.succeed({ scripts: [] }),
      resultHistory: () => Effect.succeed({ latest, revisions: [] }),
      resultSetup: () => Effect.succeed({ inputs: [], parameters: [], suggestedInputs: [] }),
      rerunResults: (request) =>
        Effect.sync(() => {
          parameters = request.parameters;
          return { _tag: "failed" as const, message: "fixture" };
        }),
      resultOutputContent: ({ revision, output }) =>
        Effect.succeed({
          _tag: "content",
          revision: ComputeResultRevisionId.make(revision),
          output,
          mediaType: "text/csv",
          encoding: "utf8",
          content: "n\n2\n",
          truncated: false,
        }),
    });
    const withinProject = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(gateway),
        Effect.provideService(WorkspaceBindingResolver, resolver),
        Effect.provideService(AgentInvocationContext, {
          environmentId: workspace.binding.environmentId,
          threadId: ThreadId.make("results-test"),
          providerSessionId: "results-test",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          capabilities: new Set(["compute"] as const),
          issuedAt: 1,
          workspace,
        }),
      );
    const standard = yield* withinProject(listScientResults({ path }));
    expect(standard).toMatchObject({
      packageCount: 1,
      latestRecord: {
        environment: { lockfiles: latest.environment?.lockfiles, packagesTruncated: true },
      },
    });
    expect(standard).not.toHaveProperty("latestRecord.environment.packages");
    expect(yield* withinProject(listScientResults({ path, includePackages: true }))).toMatchObject({
      latestRecord: { environment: latest.environment },
    });
    yield* withinProject(
      runScientResults({
        path,
        parameters: { threshold: 0.7, text: "0.7", exclude: null, keep: true, ids: [1, 2] },
      }),
    );
    expect(parameters).toEqual({
      threshold: "0.7",
      text: '"0.7"',
      exclude: "null",
      keep: "true",
      ids: "[1,2]",
    });
    expect(
      yield* withinProject(
        listScientResults({ revision: latest.revision, output: "confusion.csv" }),
      ),
    ).toMatchObject({
      outputContent: { output: "confusion.csv", content: "n\n2\n", truncated: false },
    });
  }),
);
