// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { OmpSettings } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeOmpManagedRuntimeResolution } from "../../scient/providerLifecycle/OmpManagedRuntimeActions.ts";
import { makeOmpRpcProcess } from "./OmpRpcProcess.ts";

/**
 * Real managed-runtime qualification. It is intentionally opt-in because the
 * reviewed OMP artifact is a macOS ARM64 download. The normal unit suite only
 * exercises the catalog and state-machine seams.
 */
describe("real Oh My Pi managed runtime qualification", () => {
  it.effect(
    "installs, handshakes, resumes, and removes the reviewed OMP artifact",
    () =>
      Effect.gen(function* () {
        if (process.env.OMP_QUALIFY_MANAGED !== "1") return;
        const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-managed-real-${process.pid}`);
        NodeFS.rmSync(root, { recursive: true, force: true });
        NodeFS.mkdirSync(root, { recursive: true });
        const environment = {
          // Keep the host's independently installed OMP out of this
          // qualification so the managed path is selected from a true miss.
          PATH: "/usr/bin:/bin",
          HOME: NodePath.join(root, "home"),
          PI_CODING_AGENT_DIR: NodePath.join(root, "home", "agent"),
        };
        NodeFS.mkdirSync(environment.PI_CODING_AGENT_DIR, { recursive: true });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const settings = OmpSettings.make({
          enabled: true,
          binaryPath: "omp",
          homePath: "",
          profile: "",
        });
        const resolution = yield* makeOmpManagedRuntimeResolution({
          settings,
          baseDir: root,
          environment,
          spawner,
          managedInstallationAllowed: true,
        });
        expect(resolution.usesManagedPath).toBe(true);
        expect(resolution.summary.source).toBe("missing");
        expect(resolution.summary.actions).toContain("install");

        const plan = yield* resolution.actions.plan("install");
        expect(plan.action).toBe("install");
        expect(plan.version).toBe("18.2.8");
        yield* resolution.actions.run("install", plan.catalogRevision, () => Effect.void);
        const installed = yield* resolution.actions.getSummary;
        expect(installed).toMatchObject({
          source: "scient_managed",
          managedVersion: "18.2.8",
          availableManagedVersion: null,
        });

        // Recreate the resolution to prove the v3 OMP receipt survives a
        // process restart, rather than only working in the installing process.
        const recreated = yield* makeOmpManagedRuntimeResolution({
          settings,
          baseDir: root,
          environment,
          spawner,
          managedInstallationAllowed: true,
        });
        expect(recreated.usesManagedPath).toBe(true);
        expect(recreated.summary).toMatchObject({
          source: "scient_managed",
          managedVersion: "18.2.8",
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* makeOmpRpcProcess({
              command: recreated.effectiveBinaryPath,
              cwd: root,
              env: environment,
              sessionDir: NodePath.join(root, "session"),
            }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
            const ready = yield* client.ready;
            expect(ready.supportedProtocolVersions).toContain(2);
            const state = yield* client.getState();
            expect(state.isStreaming).not.toBe(true);
            expect(state.sessionId).toBeTypeOf("string");
            yield* client.shutdown;
          }),
        );

        const removePlan = yield* resolution.actions.plan("remove");
        yield* resolution.actions.run("remove", removePlan.catalogRevision, () => Effect.void);
        const removed = yield* resolution.actions.getSummary;
        expect(removed.source).toBe("missing");
        expect(removed.managedVersion).toBeNull();
        NodeFS.rmSync(root, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("10 minutes")),
    700_000,
  );
});
