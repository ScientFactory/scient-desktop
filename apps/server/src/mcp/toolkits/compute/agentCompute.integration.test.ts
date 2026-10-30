// @effect-diagnostics nodeBuiltinImport:off -- gated integration test uses an explicit host Python.
import * as NodeProcess from "node:process";

import { initializeScientProject } from "@scientfactory/project-init";
import {
  ComputeExecutionId,
  ComputeSessionId,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../../config.ts";
import * as OwnedLocalEndpoints from "../../../localEndpoints/OwnedLocalEndpointRegistry.ts";
import * as WorkspaceEntries from "../../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as LocalDuplexProcess from "../../../scient/execution/LocalDuplexProcess.ts";
import * as LocalExecutionProcess from "../../../scient/execution/LocalExecutionProcess.ts";
import * as ComputeSessionService from "../../../scient/compute/ComputeSessionService.ts";
import { makeComputeRpcGateway } from "../../../scient/compute/ComputeRpcGateway.ts";
import { computeWorkspaceResolverForTest } from "../../../scient/compute/ComputeWorkspaceTestUtils.ts";
import * as LocalComputeStore from "../../../scient/compute/LocalComputeStore.ts";
import * as PythonComputeRuntime from "../../../scient/compute/PythonComputeRuntime.ts";
import { layerKnownWorkspacesAllowAll } from "../../../scient/workspace/knownWorkspaces.testkit.ts";
import { AgentInvocationContext } from "../../../scient/operations/AgentInvocationContext.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { ComputeMcpGateway } from "./ComputeMcpGateway.ts";
import {
  listScientComputeSessions,
  readScientComputeOutput,
  runScientCompute,
} from "./handlers.ts";

const TEST_PYTHON = NodeProcess.env.SCIENT_TEST_PYTHON;

describe.runIf(Boolean(TEST_PYTHON))("agent compute tools", () => {
  it.live("runs code in the agent's own session and returns text, errors and figures", () =>
    Effect.gen(function* () {
      if (!TEST_PYTHON) return yield* Effect.die("SCIENT_TEST_PYTHON is not set.");
      const fs = yield* FileSystem.FileSystem;
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "scient-agent-compute-" });
      const stateRoot = yield* fs.makeTempDirectoryScoped({ prefix: "scient-agent-state-" });
      yield* Effect.promise(() => initializeScientProject({ root: projectRoot }));
      const config = ServerConfig.layerTest(projectRoot, stateRoot);
      const computeLayer = PythonComputeRuntime.layer.pipe(
        Layer.provide(LocalComputeStore.layer),
        Layer.provide(LocalExecutionProcess.layer),
        Layer.provide(LocalDuplexProcess.layer),
        Layer.provide(OwnedLocalEndpoints.layer),
        Layer.provide(config),
        Layer.provide(NodeServices.layer),
      );
      const workspaceLayer = WorkspaceFileSystem.layer.pipe(
        Layer.provide(layerKnownWorkspacesAllowAll),
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
        Layer.provide(config),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const compute = yield* ComputeSessionService.ComputeSessionService;
        const gateway = makeComputeRpcGateway({
          workspaceResolver: computeWorkspaceResolverForTest,
          compute,
          workspaceFileSystem: yield* WorkspaceFileSystem.WorkspaceFileSystem,
          serverSettings: {
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              scientificComputing: {
                schemaVersion: 1,
                languages: { python: { enabled: true, executable: TEST_PYTHON } },
              },
            }),
          },
        });
        const workspace = yield* computeWorkspaceResolverForTest.resolveWorkspaceRoot(projectRoot);
        const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provideService(ComputeMcpGateway, {
              ...gateway,
              notebookOutputs: () => Effect.die("not used"),
              readNotebook: () => Effect.die("not used"),
              readNotebookOutput: () => Effect.die("not used"),
              editNotebook: () => Effect.die("not used"),
              recordNotebookRun: () => Effect.die("not used"),
              flushNotebook: () => Effect.die("not used"),
              readOutput: (ref, kind) =>
                Effect.gen(function* () {
                  const resolved =
                    kind === "image"
                      ? yield* compute.resolveOutputImage(ref)
                      : yield* compute.resolveOutputResource(ref);
                  if (resolved === null) return null;
                  return {
                    mediaType: resolved.mediaType,
                    bytes: yield* fs.readFile(resolved.path).pipe(Effect.orDie),
                  };
                }),
            }),
            Effect.provideService(WorkspaceBindingResolver, computeWorkspaceResolverForTest),
            Effect.provideService(AgentInvocationContext, {
              environmentId: workspace.binding.environmentId,
              threadId: ThreadId.make("thread-agent-compute"),
              providerSessionId: "provider-session-agent-compute",
              providerInstanceId: ProviderInstanceId.make("claudeAgent"),
              capabilities: new Set(["compute"] as const),
              issuedAt: 1,
              workspace,
            }),
          );

        const first = yield* provide(runScientCompute({ code: "x = 6 * 7\nprint(x)" }));
        expect(first.run.status).toBe("succeeded");
        expect(first.run.output).toBe("42");
        expect(first.session.owner).toBe("agent (this chat)");

        // Same session: state persists between agent runs.
        const second = yield* provide(runScientCompute({ code: "x + 1" }));
        expect(second.session.session).toBe(first.session.session);
        expect(second.run.output).toBe("43");

        const failed = yield* provide(runScientCompute({ code: "1 / 0" }));
        expect(failed.run.status).toBe("failed");
        expect(failed.run.output).toContain("ZeroDivisionError");

        const figure = yield* provide(
          runScientCompute({
            code: "import matplotlib.pyplot as plt\nplt.plot([1, 3, 2])\nplt.show()",
          }),
        );
        expect(figure.run.figures).toBe(1);
        expect(figure.images?.[0]?.mediaType).toBe("image/png");
        // Shown figures also carry a PDF, so they can be saved as vector graphics.
        const { outputs } = yield* gateway.listOutputs({
          cwd: projectRoot,
          sessionId: ComputeSessionId.make(figure.session.session),
          executionId: ComputeExecutionId.make(figure.run.run),
        });
        expect(
          outputs.flatMap((output) =>
            "bundle" in output ? output.bundle.representations.map((entry) => entry.mediaType) : [],
          ),
        ).toContain("application/pdf");

        const progress = yield* provide(
          runScientCompute({
            code: "import sys, time\nfor i in range(3):\n    sys.stdout.write(f'\\r{i}')\n    time.sleep(0.4)\nprint('\\ndone')",
            waitSeconds: 0,
          }),
        );
        expect(progress.run.status).not.toBe("succeeded");
        const finished = yield* provide(
          readScientComputeOutput({ session: progress.session.session, waitSeconds: 30 }),
        );
        expect(finished.run.status).toBe("succeeded");
        expect(finished.run.output).toBe("2\ndone");

        const { sessions } = yield* provide(listScientComputeSessions());
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.recentRuns.at(-1)?.source).toBe("agent (this chat): code");
      }).pipe(Effect.provide(Layer.mergeAll(computeLayer, workspaceLayer)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
