// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OmpSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { makeOmpAdapter } from "../Layers/OmpAdapter.ts";
import { checkOmpProviderStatus } from "../Layers/OmpProvider.ts";

describe("real OMP qualification", () => {
  it.effect("discovers a pinned executable when explicitly requested", () =>
    Effect.gen(function* () {
      const binary = process.env.OMP_QUALIFY_BINARY;
      if (!binary) return;
      const home = NodePath.join(NodeOS.tmpdir(), `scient-omp-real-${process.pid}`);
      NodeFS.rmSync(home, { recursive: true, force: true });
      NodeFS.mkdirSync(home, { recursive: true });
      const settings = OmpSettings.make({
        enabled: true,
        binaryPath: binary,
        customModels: [],
        homePath: "",
        profile: "",
      });
      const result = yield* checkOmpProviderStatus(
        settings,
        { ...process.env, HOME: home, PI_CODING_AGENT_DIR: NodePath.join(home, "agent") },
        undefined,
        home,
      );
      expect(result.status).toBe("ready");
      expect(result.models.length).toBeGreaterThan(0);
      NodeFS.rmSync(home, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("starts and stops a real isolated OMP session", () =>
    Effect.gen(function* () {
      const binary = process.env.OMP_QUALIFY_BINARY;
      if (!binary) return;
      const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-adapter-real-${process.pid}`);
      NodeFS.rmSync(root, { recursive: true, force: true });
      NodeFS.mkdirSync(root, { recursive: true });
      const environment = {
        ...process.env,
        HOME: NodePath.join(root, "home"),
        PI_CODING_AGENT_DIR: NodePath.join(root, "home", "agent"),
      };
      NodeFS.mkdirSync(environment.HOME, { recursive: true });
      const adapter = yield* makeOmpAdapter({
        binaryPath: binary,
        providerInstanceId: ProviderInstanceId.make("omp-real-smoke"),
        stateDir: NodePath.join(root, "state"),
        attachmentsDir: NodePath.join(root, "attachments"),
        environment,
      });
      const threadId = ThreadId.make("real-omp-thread");
      const session = yield* adapter.startSession({
        threadId,
        cwd: root,
        runtimeMode: "full-access",
      });
      expect(session.status).toBe("ready");
      yield* adapter.stopAll();
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "completes a real model turn when explicitly requested",
    () =>
      Effect.gen(function* () {
        const binary = process.env.OMP_QUALIFY_BINARY;
        if (!binary || process.env.OMP_QUALIFY_FULL_TURN !== "1") return;
        const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-turn-real-${process.pid}`);
        NodeFS.rmSync(root, { recursive: true, force: true });
        NodeFS.mkdirSync(root, { recursive: true });
        const environment = {
          ...process.env,
          HOME: NodePath.join(root, "home"),
          PI_CODING_AGENT_DIR: NodePath.join(root, "home", "agent"),
        };
        NodeFS.mkdirSync(environment.HOME, { recursive: true });
        const instanceId = ProviderInstanceId.make("omp-real-turn-smoke");
        const adapter = yield* makeOmpAdapter({
          binaryPath: binary,
          providerInstanceId: instanceId,
          stateDir: NodePath.join(root, "state"),
          attachmentsDir: NodePath.join(root, "attachments"),
          environment,
        });
        const threadId = ThreadId.make("real-omp-turn-thread");
        yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
        const terminal = yield* Deferred.make<unknown>();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type === "turn.completed" || event.type === "turn.aborted") {
                yield* Deferred.succeed(terminal, event);
              }
            }),
          ),
          Effect.forkScoped,
        );
        yield* adapter.sendTurn({
          threadId,
          input: "Reply with exactly QUALIFIED_OMP.",
          modelSelection: createModelSelection(instanceId, "ollama/gemma4:12b-it-qat"),
        });
        expect(yield* Deferred.await(terminal)).toMatchObject({
          type: "turn.completed",
          payload: { state: "completed" },
        });
        const resumeCursor = (yield* adapter.listSessions()).find(
          (session) => session.threadId === threadId,
        )?.resumeCursor;
        expect(resumeCursor).toBeDefined();
        yield* adapter.stopAll();
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        const resumedAdapter = yield* makeOmpAdapter({
          binaryPath: binary,
          providerInstanceId: instanceId,
          stateDir: NodePath.join(root, "state"),
          attachmentsDir: NodePath.join(root, "attachments"),
          environment,
        });
        const resumed = yield* resumedAdapter.startSession({
          threadId,
          cwd: root,
          runtimeMode: "full-access",
          resumeCursor,
        });
        expect(resumed.status).toBe("ready");
        yield* resumedAdapter.stopAll();
        NodeFS.rmSync(root, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
    300_000,
  );
});
