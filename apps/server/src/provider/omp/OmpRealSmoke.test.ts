// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OmpSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { nativeOmpSession, watchNativeOmpTextTurn } from "../testUtils/nativeOmpSession.ts";
import { checkOmpProviderStatus } from "../OmpProvider.ts";
import * as OmpExecutableGate from "./OmpExecutableGate.ts";
import {
  ompLiveInstance,
  ompQualifyBinary,
  ompQualifyFullTurn,
  ompQualifyModel,
  ompQualifyTarget,
} from "./OmpLive.testFixtures.ts";
import { makeOmpRpcProcess, type OmpRpcProcessOptions } from "./OmpRpcProcess.ts";

/** The production process factory, leasing from this test's executable gate. */
const gatedProcess = Effect.map(
  OmpExecutableGate.OmpExecutableGate,
  (gate) => (options: OmpRpcProcessOptions) =>
    makeOmpRpcProcess(options).pipe(
      Effect.provideService(OmpExecutableGate.OmpExecutableGate, gate),
    ),
);

const binary = ompQualifyBinary ?? "";

/** Local model access only, without inheriting account credentials or user profiles. */
const isolatedInstance = (root: string) =>
  ompLiveInstance(root, {
    baseEnv: {
      PATH: process.env.PATH ?? "",
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
    },
  });

describe.runIf(ompQualifyBinary)("real OMP qualification", () => {
  it.effect("discovers a pinned executable when explicitly requested", () =>
    Effect.gen(function* () {
      const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-real-${process.pid}`);
      NodeFS.rmSync(root, { recursive: true, force: true });
      const { environment, homePath } = isolatedInstance(root);
      const settings = OmpSettings.make({
        enabled: true,
        binaryPath: binary,
        customModels: [],
        homePath,
        profile: "",
      });
      const result = yield* checkOmpProviderStatus(
        ompQualifyTarget,
        settings,
        environment,
        yield* gatedProcess,
        root,
      );
      expect(result.status).toBe("ready");
      expect(result.models.length).toBeGreaterThan(0);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer)),
    ),
  );

  it.effect("starts and stops a real isolated OMP session", () =>
    Effect.gen(function* () {
      const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-adapter-real-${process.pid}`);
      NodeFS.rmSync(root, { recursive: true, force: true });
      const { environment, homePath } = isolatedInstance(root);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );
      const instanceId = ProviderInstanceId.make("omp-real-smoke");
      const session = yield* nativeOmpSession({
        root,
        target: ompQualifyTarget,
        binaryPath: binary,
        instanceId,
        threadId: ThreadId.make("real-omp-thread"),
        modelSelection: createModelSelection(instanceId, ompQualifyModel),
        stateDir: NodePath.join(root, "state"),
        attachmentsDir: NodePath.join(root, "attachments"),
        environment,
        homePath,
        makeProcess: yield* gatedProcess,
      });
      expect(session.runtime.providerSession.status).toBe("ready");
      expect(session.providerThread.appThreadId).toBe(ThreadId.make("real-omp-thread"));
      yield* session.close;
      expect(session.runtime.providerSession.status).toBe("stopped");
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect.skipIf(!ompQualifyFullTurn)(
    `completes a real model turn with ${ompQualifyModel} when explicitly requested`,
    () =>
      Effect.gen(function* () {
        const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-turn-real-${process.pid}`);
        NodeFS.rmSync(root, { recursive: true, force: true });
        const { environment, homePath } = isolatedInstance(root);
        const instanceId = ProviderInstanceId.make("omp-real-turn-smoke");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );
        const options = {
          root,
          target: ompQualifyTarget,
          binaryPath: binary,
          instanceId,
          threadId: ThreadId.make("real-omp-turn-thread"),
          modelSelection: createModelSelection(instanceId, ompQualifyModel),
          stateDir: NodePath.join(root, "state"),
          attachmentsDir: NodePath.join(root, "attachments"),
          environment,
          homePath,
          makeProcess: yield* gatedProcess,
        };
        const session = yield* nativeOmpSession(options);
        const terminal = yield* watchNativeOmpTextTurn(session.events);
        yield* session.start({ text: "Reply with exactly QUALIFIED_OMP." });
        expect((yield* terminal.pipe(Effect.timeout("120 seconds"))).trim()).toBe("QUALIFIED_OMP");
        const prior = session.latestProviderThread();
        expect(prior.nativeMetadata?.resumeCursor).toBeDefined();
        expect(prior.nativeThreadRef?.nativeId).toBeTruthy();
        yield* session.close;
        expect(session.runtime.providerSession.status).toBe("stopped");
        const resumed = yield* nativeOmpSession({ ...options, resumeProviderThread: prior });
        expect(resumed.runtime.providerSession.status).toBe("ready");
        expect(resumed.providerThread.id).toBe(prior.id);
        expect(resumed.providerThread.nativeThreadRef?.nativeId).toBe(
          prior.nativeThreadRef?.nativeId,
        );
        yield* resumed.close;
        expect(resumed.runtime.providerSession.status).toBe("stopped");
        NodeFS.rmSync(root, { recursive: true, force: true });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer, McpProviderSessions.layer),
        ),
      ),
    300_000,
  );
});
